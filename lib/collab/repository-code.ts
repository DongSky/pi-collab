import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, realpath } from "node:fs/promises";
import { isUtf8 } from "node:buffer";
import { z } from "zod";
import { asUser } from "./database";
import { DomainError } from "./policy";
import { runnerEnvironment } from "./runtime/workspace";
import { safeSnapshotPath, snapshotExcludedPath, snapshotHasSecret } from "./runtime/snapshots";
import { codeDisplayText } from "./integration-code-schema";
const exec = promisify(execFile);
export type RepositoryCodeTree = { repositoryId: string; revision: string; files: { path: string; size: number }[]; omitted: number };
export type RepositoryCodeFile = { repositoryId: string; revision: string; path: string; text: string };
const querySchema = z.object({ revision: z.string().regex(/^[a-f0-9]{40,64}$/).optional(), path: z.string().min(1).max(1024).optional() });
const unavailable = () => new DomainError("code_unavailable", "文件被排除、不是可显示的文本，或仓库代码暂时不可读取。", 409);
/** Only the authorized, current managed baseline. Never accept a caller's Git ref or filesystem root. */
export async function repositoryCode(userId: string, repositoryId: string, input: z.input<typeof querySchema>, signal?: AbortSignal): Promise<RepositoryCodeTree | RepositoryCodeFile> {
 z.uuid().parse(repositoryId); const query = querySchema.parse(input);
 return asUser(userId, async db => {
  const scope = async () => (await db.query(`SELECT r.base_sha, m.authorization_version::text AS organization_version, pm.authorization_version::text AS project_version
    FROM collab.repositories r JOIN collab.memberships m ON m.organization_id=r.organization_id AND m.user_id=collab.actor()
    JOIN collab.project_memberships pm ON pm.project_id=r.project_id AND pm.user_id=m.user_id WHERE r.id=$1`, [repositoryId])).rows[0];
  const before = await scope();
  if (!before) throw new DomainError("not_found", "仓库不存在或没有访问权限。", 404);
  if (query.revision && query.revision !== before.base_sha) throw new DomainError("code_revision_changed", "仓库基线已更新，请刷新文件树。", 409);
  if (query.path && (!safeSnapshotPath(query.path) || snapshotExcludedPath(query.path))) throw unavailable();
  const root = path.resolve(process.env.PI_COLLAB_DATA_DIR ?? ".local"), directory = path.join(root, "repositories", repositoryId, "git");
  let result: RepositoryCodeTree | RepositoryCodeFile;
  try {
   const canonicalRoot = await realpath(root);
   if (await realpath(directory) !== path.join(canonicalRoot, "repositories", repositoryId, "git")) throw unavailable();
   for (const entry of ["objects", "objects/info", "objects/pack"]) { const info = await lstat(path.join(directory, entry)); if (!info.isDirectory() || info.isSymbolicLink()) throw unavailable(); }
   for (const entry of ["objects/info/alternates", "objects/info/http-alternates"]) { try { await lstat(path.join(directory, entry)); throw unavailable(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; } }
   const git = async (args: string[], maxBuffer: number) => (await exec("git", ["--no-pager", "--no-optional-locks", `--git-dir=${directory}`, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.allow=never", ...args], { env: { ...runnerEnvironment("/nonexistent", "/nonexistent"), GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_CONFIG_NOSYSTEM: "1" }, encoding: "buffer", timeout: 10000, maxBuffer, signal })).stdout;
   const tree = await git(["ls-tree", "-rlz", before.base_sha], 2 * 1024 * 1024);
   if (!isUtf8(tree)) throw unavailable();
   const entries = tree.toString("utf8").split("\0").filter(Boolean).map(row => {
    const match = /^(\d+) (\w+) ([a-f0-9]+)\s+([\d-]+)\t([\s\S]+)$/.exec(row);
    if (!match) throw unavailable();
    return { mode: match[1], type: match[2], oid: match[3], size: Number(match[4]), path: match[5] };
   });
   if (entries.length > 10000) throw new DomainError("code_tree_limit", "仓库超过 10000 个文件，当前文件浏览器暂不支持。", 409);
   const files = entries.filter(f => f.type === "blob" && ["100644", "100755"].includes(f.mode) && safeSnapshotPath(f.path) && !snapshotExcludedPath(f.path));
   if (query.path) {
    const file = files.find(f => f.path === query.path); if (!file || file.size > 262144) throw unavailable();
    const bytes = await git(["cat-file", "blob", file.oid], 262144);
    if (bytes.length !== file.size || !isUtf8(bytes) || bytes.includes(0) || snapshotHasSecret(bytes)) throw unavailable();
    result = { repositoryId, revision: before.base_sha, path: file.path, text: codeDisplayText(bytes.toString("utf8")) };
   } else result = { repositoryId, revision: before.base_sha, files: files.map(({ path, size }) => ({ path, size })), omitted: entries.length - files.length };
  } catch (e) { if (e instanceof DomainError) throw e; throw unavailable(); }
  const after = await scope();
  if (!after || JSON.stringify(before) !== JSON.stringify(after)) throw new DomainError("code_revision_changed", "仓库基线或访问权限已改变，请重新打开。", 409);
  return result;
 });
}
