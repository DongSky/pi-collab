import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { isUtf8 } from "node:buffer";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { z } from "zod";
import { createWorkspace, runnerEnvironment, type WorkspaceLocation } from "./workspace";
import { dependencyPins, type DependencyPin } from "../dependency-inputs";
import { contractPins, type ContractPin } from "../contract-schema";
import { safeSnapshotPath as safePath } from "../snapshot-paths";
import { resolutionInputSchema, type ResolutionInput } from "../resolution-schema";
import { verifyResolutionInputs } from "./resolution-inputs";
import { verifyContractInputs } from "./contract-inputs";

const FILE_LIMIT = 2 * 1024 * 1024, TOTAL_LIMIT = 64 * 1024 * 1024, COUNT_LIMIT = 5000, MANIFEST_LIMIT = 8 * 1024 * 1024;
const digest = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const sha = z.string().regex(/^[a-f0-9]{40}$/), hash = z.string().regex(/^[a-f0-9]{64}$/);
const entrySchema = z.object({ path: z.string().refine(safePath), mode: z.enum(["100644", "100755"]), hash, size: z.number().int().min(0).max(FILE_LIMIT) }).strict();
type Entry = z.infer<typeof entrySchema>;
const excludedSchema = z.object({ path: z.string().max(1024), reason: z.enum(["private_path", "generated", "large_file", "secret_pattern", "symlink", "submodule", "special_file"]) }).strict();
type Exclusion = z.infer<typeof excludedSchema>;
export const manifestSchema = z.object({
  version: z.literal(1), id: z.uuid(), runId: z.uuid(), workspaceId: z.uuid(), repositoryId: z.uuid(), baseSha: sha, sourceHead: sha,
  exportedHead: sha, indexCommit: sha, worktreeCommit: sha,
  parentSnapshot: z.object({ id: z.uuid(), manifestHash: hash }).strict().nullable().default(null),
  dependencies: dependencyPins.default([]),
  contracts: contractPins.default([]),
  resolution: resolutionInputSchema.nullable().default(null),
  head: z.array(entrySchema).max(COUNT_LIMIT), index: z.array(entrySchema).max(COUNT_LIMIT), worktree: z.array(entrySchema).max(COUNT_LIMIT),
  excluded: z.array(excludedSchema).max(COUNT_LIMIT), note: z.string().max(4000),
  // An explicit handoff note is shared; raw Pi sessions and private reasoning are never copied.
  context: z.object({ title: z.string(), description: z.string(), acceptance: z.string(), prompt: z.string(), status: z.string() }).strict(),
  omissions: z.array(z.string()), stagedPatchHash: hash, workingPatchHash: hash,
}).strict();
export type SnapshotManifest = z.infer<typeof manifestSchema>;
export interface SnapshotSource {
  id: string; runId: string; workspaceId: string; repositoryId: string; baseSha: string; note: string;
  context: SnapshotManifest["context"];
  parentSnapshot?: SnapshotManifest["parentSnapshot"];
  dependencies?: DependencyPin[];
  contracts?: ContractPin[];
  resolution?: ResolutionInput | null;
}
export class SnapshotError extends Error { constructor(readonly code: string) { super(code); } }
function fail(code: string): never { throw new SnapshotError(code); }

function git(cwd: string, args: string[], input?: Buffer | string, limit = TOTAL_LIMIT * 2): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["--no-pager", "--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.attributesFile=/dev/null", "-c", "protocol.allow=never", ...args], {
      cwd, env: { ...runnerEnvironment("/nonexistent", "/nonexistent"), GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" }, stdio: "pipe",
    });
    const chunks: Buffer[] = []; let bytes = 0, overflow = false;
    const timeout = setTimeout(() => { overflow = true; child.kill("SIGKILL"); }, 30_000);
    child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > limit) { overflow = true; child.kill("SIGKILL"); } else chunks.push(chunk); });
    child.stderr.resume(); // Do not disclose agent-controlled config or filesystem paths in errors.
    child.stdin.on("error", () => {}); child.stdin.end(input);
    child.once("error", () => { clearTimeout(timeout); reject(new SnapshotError("snapshot_git_unavailable")); });
    child.once("close", code => { clearTimeout(timeout); if (code || overflow) reject(new SnapshotError("snapshot_git_failed")); else resolve(Buffer.concat(chunks)); });
  });
}
async function regular(file: string, limit: number) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > limit) fail("snapshot_invalid_artifact");
    const bytes = await handle.readFile(); const after = await handle.stat();
    if (bytes.length > limit || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail("snapshot_source_changed");
    return bytes;
  } finally { await handle.close(); }
}
async function directory(file: string) { const stat = await lstat(file); if (!stat.isDirectory() || stat.isSymbolicLink()) fail("snapshot_unsafe_path"); }
async function guardGit(checkout: string) {
  await directory(checkout); await directory(path.join(checkout, ".git"));
  let count = 0;
  const walk = async (dir: string) => {
    for (const name of await readdir(dir)) {
      if (++count > 50_000) fail("snapshot_limit");
      const file = path.join(dir, name), info = await lstat(file);
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()) || file.endsWith("/objects/info/alternates") || file.endsWith("/objects/info/http-alternates")) fail("snapshot_unsafe_git");
      if (info.isDirectory()) await walk(file);
    }
  };
  await walk(path.join(checkout, ".git"));
}
function excludedPath(file: string): Exclusion["reason"] | null {
  const parts = file.toLowerCase().split("/"), name = parts.at(-1)!;
  if (parts.some(p => [".git", ".pi", ".agents", ".ssh", ".aws", ".config", ".local"].includes(p))
    || /^\.env(?:\.|$)/.test(name) || [".npmrc", ".pypirc", "auth.json", "credentials.json", "credentials", "id_rsa", "id_ed25519"].includes(name)
    || /\.(pem|key|p12|pfx|kdbx|keystore)$/.test(name)) return "private_path";
  if (parts.some(p => ["node_modules", ".next", ".cache", ".venv", "venv", "__pycache__", "coverage", "dist", "build", ".turbo"].includes(p)) || name === ".ds_store") return "generated";
  return null;
}
function hasSecret(bytes: Buffer) {
  const value = bytes.toString("utf8");
  return /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}|\bBearer\s+[A-Za-z0-9_.-]{20,}|\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s:/]+:[^\s@]+@/i.test(value)
    || /["']?(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)["']?\s*[:=]\s*["'][A-Za-z0-9_+/=.-]{12,}["']/i.test(value);
}
// Code review uses the same omission policy for historical target/conflict
// bytes, including secrets that were deleted before a snapshot was captured.
export { safePath as safeSnapshotPath, excludedPath as snapshotExcludedPath, hasSecret as snapshotHasSecret };
function textRecords(bytes: Buffer) { if (!isUtf8(bytes)) fail("snapshot_filename_unsupported"); return bytes.toString("utf8").split("\0").filter(Boolean); }
function checkNames(entries: Entry[]) {
  const names = new Set<string>(), prefixes = new Map<string, string>();
  for (const entry of entries) {
    if (!safePath(entry.path)) fail("snapshot_filename_unsupported");
    const key = entry.path.normalize("NFC").toLowerCase();
    if (names.has(key)) fail("snapshot_path_collision"); names.add(key);
    const parts = entry.path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join("/"), folded = prefix.normalize("NFC").toLowerCase();
      if (prefixes.has(folded) && prefixes.get(folded) !== prefix) fail("snapshot_path_collision"); prefixes.set(folded, prefix);
    }
  }
}
async function scan(checkout: string) {
  await guardGit(checkout);
  const sourceHead = (await git(checkout, ["rev-parse", "--verify", "HEAD^{commit}"])).toString().trim(); sha.parse(sourceHead);
  const rows = (bytes: Buffer, index: boolean) => textRecords(bytes).map(row => {
    const tab = row.indexOf("\t"), file = row.slice(tab + 1), fields = row.slice(0, tab).split(" ");
    if (tab < 0 || !safePath(file)) fail("snapshot_filename_unsupported");
    if (index && fields[2] !== "0") fail("snapshot_unmerged_index");
    return { path: file, mode: fields[0], oid: index ? fields[1] : fields[2] };
  });
  const headRows = rows(await git(checkout, ["ls-tree", "-rz", "--full-tree", sourceHead]), false);
  const indexRows = rows(await git(checkout, ["ls-files", "--stage", "-z"]), true);
  // Trees cannot represent intent-to-add, skip-worktree or assume-unchanged.
  // Reject these explicitly rather than silently changing staging semantics.
  const indexDebug = (await git(checkout, ["ls-files", "--debug", "-z"])).toString("utf8");
  if ([...indexDebug.matchAll(/flags: ([0-9a-f]+)/g)].some(match => parseInt(match[1], 16) !== 0)) fail("snapshot_index_flags");
  if (headRows.length > COUNT_LIMIT || indexRows.length > COUNT_LIMIT) fail("snapshot_limit");
  const blobs = new Map<string, Buffer>(), excluded = new Map<string, Exclusion>();
  let total = 0;
  const omit = (file: string, reason: Exclusion["reason"]) => { excluded.set(`${file}:${reason}`, { path: file, reason }); if (excluded.size > COUNT_LIMIT) fail("snapshot_limit"); };
  const include = (file: string, mode: string, bytes: Buffer): Entry | null => {
    if (bytes.length > FILE_LIMIT) { omit(file, "large_file"); return null; }
    if (hasSecret(bytes)) { omit(file, "secret_pattern"); return null; }
    const hash = digest(bytes);
    if (!blobs.has(hash)) { total += bytes.length; if (total > TOTAL_LIMIT) fail("snapshot_limit"); blobs.set(hash, bytes); }
    return { path: file, mode: mode === "100755" ? "100755" : "100644", hash, size: bytes.length };
  };
  const allowed = (row: { path: string; mode: string }) => {
    const exclusion = excludedPath(row.path) ?? (row.mode === "120000" ? "symlink" : row.mode === "160000" ? "submodule" : null);
    if (exclusion) { omit(row.path, exclusion); return false; }
    if (!["100644", "100755"].includes(row.mode)) fail("snapshot_unsafe_git"); return true;
  };
  const candidates = [...headRows, ...indexRows].filter(allowed), oids = [...new Set(candidates.map(row => sha.parse(row.oid)))];
  const sizes = new Map<string, number>();
  if (oids.length) for (const row of (await git(checkout, ["cat-file", "--batch-check"], `${oids.join("\n")}\n`)).toString().trim().split("\n")) {
    const [oid, type, size] = row.split(" "); if (type !== "blob" || !Number.isSafeInteger(Number(size))) fail("snapshot_unsafe_git"); sizes.set(oid, Number(size));
  }
  const small = oids.filter(oid => sizes.has(oid) && sizes.get(oid)! <= FILE_LIMIT);
  if (small.reduce((sum, oid) => sum + sizes.get(oid)!, 0) > TOTAL_LIMIT) fail("snapshot_limit");
  const objects = new Map<string, Buffer>();
  if (small.length) {
    const output = await git(checkout, ["cat-file", "--batch"], `${small.join("\n")}\n`); let offset = 0;
    for (const oid of small) {
      const end = output.indexOf(10, offset), header = output.subarray(offset, end).toString(), size = sizes.get(oid)!;
      if (header !== `${oid} blob ${size}` || end < offset || end + size + 1 >= output.length) fail("snapshot_unsafe_git");
      objects.set(oid, output.subarray(end + 1, end + 1 + size)); offset = end + size + 2;
    }
  }
  const fromGit = (entries: typeof headRows) => entries.filter(allowed).flatMap(row => {
    const content = objects.get(row.oid); if (!content) { omit(row.path, "large_file"); return []; }
    const entry = include(row.path, row.mode, content); return entry ? [entry] : [];
  });
  const head = fromGit(headRows), index = fromGit(indexRows), worktree: Entry[] = [];
  const submodules = new Set([...headRows, ...indexRows].filter(row => row.mode === "160000").map(row => row.path));
  let visited = 0;
  const walk = async (dir: string, prefix = "") => {
    for (const name of (await readdir(dir)).sort()) {
      if (++visited > COUNT_LIMIT * 2) fail("snapshot_limit");
      const file = prefix ? `${prefix}/${name}` : name, absolute = path.join(dir, name);
      if (submodules.has(file)) { omit(file, "submodule"); continue; }
      const reason = excludedPath(file); if (reason) { omit(file, reason); continue; }
      if (!safePath(file)) fail("snapshot_filename_unsupported");
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) { omit(file, "symlink"); continue; }
      if (info.isDirectory()) { await walk(absolute, file); continue; }
      if (!info.isFile()) { omit(file, "special_file"); continue; }
      if (info.size > FILE_LIMIT) { omit(file, "large_file"); continue; }
      const entry = include(file, info.mode & 0o111 ? "100755" : "100644", await regular(absolute, FILE_LIMIT));
      if (entry) worktree.push(entry); if (worktree.length > COUNT_LIMIT) fail("snapshot_limit");
    }
  };
  await walk(checkout);
  // A sensitive path in any layer is excluded from every layer, avoiding recovery
  // of its older secret-bearing content via HEAD or the Git index.
  const privatePaths = new Set([...excluded.values()].filter(item => item.reason === "secret_pattern").map(item => item.path));
  const clean = (entries: Entry[]) => entries.filter(entry => !privatePaths.has(entry.path)).sort((a, b) => a.path.localeCompare(b.path, "en"));
  const result = { sourceHead, head: clean(head), index: clean(index), worktree: clean(worktree), excluded: [...excluded.values()].sort((a, b) => a.path.localeCompare(b.path, "en") || a.reason.localeCompare(b.reason)) };
  for (const entries of [result.head, result.index, result.worktree]) checkNames(entries);
  return { ...result, blobs };
}

// Internal read-only scanner shared with live Git inspection. Its caller owns
// authorization, writer-exit evidence and concurrency checks; this is no lock.
export { scan as scanWorkspaceLayers };

function object(type: string, bytes: Buffer) { const raw = Buffer.concat([Buffer.from(`${type} ${bytes.length}\0`), bytes]); return { oid: createHash("sha1").update(raw).digest("hex"), raw }; }
async function materialize(directoryPath: string, layers: { head: Entry[]; index: Entry[]; worktree: Entry[] }, blobs: Map<string, Buffer>) {
  await mkdir(directoryPath, { mode: 0o700 }); await git(directoryPath, ["init", "--bare", "--template=", "--object-format=sha1"]);
  const ids = new Map<string, string>();
  for (const entries of [layers.head, layers.index, layers.worktree]) for (const entry of entries) {
    if (ids.has(entry.hash)) continue;
    const bytes = blobs.get(entry.hash); if (!bytes || bytes.length !== entry.size || digest(bytes) !== entry.hash) fail("snapshot_invalid_artifact");
    const { oid, raw } = object("blob", bytes); ids.set(entry.hash, oid);
    await mkdir(path.join(directoryPath, "objects", oid.slice(0, 2)), { recursive: true });
    await writeFile(path.join(directoryPath, "objects", oid.slice(0, 2), oid.slice(2)), deflateSync(raw), { mode: 0o600 });
  }
  const commits: string[] = [];
  for (const layer of ["head", "index", "worktree"] as const) {
    await git(directoryPath, ["read-tree", "--empty"]);
    if (layers[layer].length) await git(directoryPath, ["update-index", "-z", "--index-info"], layers[layer].map(entry => `${entry.mode} ${ids.get(entry.hash)}\t${entry.path}\0`).join(""));
    const tree = (await git(directoryPath, ["write-tree"])).toString().trim();
    const commit = object("commit", Buffer.from(`tree ${tree}\n${commits.length ? `parent ${commits[0]}\n` : ""}author pi-collab snapshot <snapshot@pi-collab.local> 946684800 +0000\ncommitter pi-collab snapshot <snapshot@pi-collab.local> 946684800 +0000\n\nSanitized ${layer} snapshot\n`));
    await mkdir(path.join(directoryPath, "objects", commit.oid.slice(0, 2)), { recursive: true });
    await writeFile(path.join(directoryPath, "objects", commit.oid.slice(0, 2), commit.oid.slice(2)), deflateSync(commit.raw), { mode: 0o600 });
    await git(directoryPath, ["update-ref", `refs/heads/snapshot-${layer}`, commit.oid]); commits.push(commit.oid);
  }
  await git(directoryPath, ["symbolic-ref", "HEAD", "refs/heads/snapshot-head"]);
  return { exportedHead: commits[0], indexCommit: commits[1], worktreeCommit: commits[2] };
}
async function durable(file: string, bytes: Buffer | string) { const handle = await open(file, "wx", 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } }
async function syncDir(dir: string) { const handle = await open(dir, "r"); try { await handle.sync(); } finally { await handle.close(); } }
function artifact(root: string, id: string) { z.uuid().parse(id); return path.join(root, "snapshots", id); }
export async function readSnapshotManifest(root: string, id: string, expectedHash?: string) {
  const dir = artifact(root, id); await directory(dir); await directory(path.join(dir, "blobs"));
  const raw = await regular(path.join(dir, "manifest.json"), MANIFEST_LIMIT), manifestHash = digest(raw);
  if (expectedHash && manifestHash !== expectedHash) fail("snapshot_invalid_artifact");
  const manifest = manifestSchema.parse(JSON.parse(raw.toString("utf8")));
  if (manifest.id !== id || (manifest.resolution && (manifest.resolution.repositoryId !== manifest.repositoryId || manifest.resolution.targetSha !== manifest.baseSha))) fail("snapshot_invalid_artifact");
  return { manifest, manifestHash };
}
export async function loadSnapshot(root: string, id: string, expectedHash?: string) {
  const dir = artifact(root, id), { manifest, manifestHash } = await readSnapshotManifest(root, id, expectedHash);
  const blobs = new Map<string, Buffer>(); let size = 0;
  for (const entries of [manifest.head, manifest.index, manifest.worktree]) {
    checkNames(entries);
    for (const entry of entries) {
      if (!blobs.has(entry.hash)) {
        const bytes = await regular(path.join(dir, "blobs", entry.hash), FILE_LIMIT);
        if (digest(bytes) !== entry.hash) fail("snapshot_invalid_artifact"); size += bytes.length; if (size > TOTAL_LIMIT) fail("snapshot_limit"); blobs.set(entry.hash, bytes);
      }
      if (blobs.get(entry.hash)!.length !== entry.size) fail("snapshot_invalid_artifact");
    }
  }
  for (const [file, hash] of [["staged.patch", manifest.stagedPatchHash], ["working.patch", manifest.workingPatchHash]]) if (digest(await regular(path.join(dir, file), TOTAL_LIMIT * 2)) !== hash) fail("snapshot_invalid_artifact");
  return { manifest, manifestHash, blobs };
}

/** Compare saved working bytes to the trusted repository base, including agent
 * commits and restored workspaces with no original Git ancestry. Never run
 * agent Git configuration or read excluded baseline file contents. */
export async function snapshotBaselineChanges(root: string, id: string, expectedHash: string) {
  const { manifest, manifestHash, blobs } = await loadSnapshot(root, id, expectedHash);
  const repository = path.join(root, "repositories", manifest.repositoryId, "git");
  await directory(repository);
  const rows = textRecords(await git(repository, ["ls-tree", "-rz", "--full-tree", manifest.baseSha]));
  if (rows.length > COUNT_LIMIT) fail("snapshot_limit");
  const excluded = new Map(manifest.excluded.map(e => [e.path, e.reason]));
  const baseline = new Map<string, { oid: string; mode: string }>();
  for (const row of rows) {
    const tab = row.indexOf("\t"), file = row.slice(tab + 1), [mode, type, oid] = row.slice(0, tab).split(" ");
    if (tab < 0 || !safePath(file) || !/^[a-f0-9]{40}$/.test(oid)) fail("snapshot_filename_unsupported");
    const reason = excludedPath(file) ?? (mode === "120000" ? "symlink" : mode === "160000" ? "submodule" : null);
    if (reason) { excluded.set(file, reason); continue; }
    if (type !== "blob" || !["100644", "100755"].includes(mode)) fail("snapshot_unsafe_git");
    baseline.set(file, { oid, mode });
  }
  const current = new Map(manifest.worktree.map(entry => [entry.path, entry]));
  const changes: { path: string; kind: "added" | "modified" | "deleted" }[] = [];
  for (const file of [...new Set([...baseline.keys(), ...current.keys()])].sort()) {
    if ([...excluded.keys()].some(prefix => file === prefix || file.startsWith(`${prefix}/`))) continue;
    const before = baseline.get(file), after = current.get(file);
    if (!before && after) changes.push({ path: file, kind: "added" });
    else if (before && !after) changes.push({ path: file, kind: "deleted" });
    else if (before && after && (before.mode !== after.mode || before.oid !== object("blob", blobs.get(after.hash)!).oid)) changes.push({ path: file, kind: "modified" });
  }
  return { snapshotId: id, manifestHash, baseSha: manifest.baseSha, worktreeCommit: manifest.worktreeCommit, changes,
    excluded: [...excluded].map(([path, reason]) => ({ path, reason })) };
}

export async function captureSnapshot(root: string, source: SnapshotSource) {
  const destination = artifact(root, source.id), checkout = path.join(root, "workspaces", z.uuid().parse(source.workspaceId), "checkout");
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const checkSource = (saved: Awaited<ReturnType<typeof loadSnapshot>>) => {
    const m = saved.manifest;
    if (["id", "runId", "workspaceId", "repositoryId", "baseSha", "note"].some(key => m[key as keyof SnapshotSource] !== source[key as keyof SnapshotSource])
      || Object.keys(source.context).some(key => m.context[key as keyof SnapshotSource["context"]] !== source.context[key as keyof SnapshotSource["context"]])
      || m.parentSnapshot?.id !== source.parentSnapshot?.id || m.parentSnapshot?.manifestHash !== source.parentSnapshot?.manifestHash
      || JSON.stringify(m.dependencies) !== JSON.stringify(dependencyPins.parse(source.dependencies ?? []))
      || JSON.stringify(m.contracts) !== JSON.stringify(contractPins.parse(source.contracts ?? []))
      || JSON.stringify(m.resolution) !== JSON.stringify(source.resolution ? resolutionInputSchema.parse(source.resolution) : null)) fail("snapshot_invalid_artifact");
    return saved;
  };
  try { return checkSource(await loadSnapshot(root, source.id)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temp = `${destination}.${randomUUID()}.tmp`; await mkdir(temp, { mode: 0o700 });
  try {
    await verifyDependencyInputs(root, path.dirname(checkout), source.dependencies ?? []);
    await verifyContractInputs(path.dirname(checkout), source.contracts ?? []);
    await verifyResolutionInputs(path.dirname(checkout), source.resolution ?? null);
    const first = await scan(checkout), { blobs, ...layers } = first;
    const gitDir = path.join(temp, "git"), commits = await materialize(gitDir, first, blobs);
    const staged = await git(gitDir, ["diff", "--no-ext-diff", "--no-textconv", "--binary", commits.exportedHead, commits.indexCommit]);
    const working = await git(gitDir, ["diff", "--no-ext-diff", "--no-textconv", "--binary", commits.indexCommit, commits.worktreeCommit]);
    const second = await scan(checkout); const secondLayers = { sourceHead: second.sourceHead, head: second.head, index: second.index, worktree: second.worktree, excluded: second.excluded };
    if (JSON.stringify(layers) !== JSON.stringify(secondLayers)) fail("snapshot_source_changed");
    const manifest = manifestSchema.parse({ version: 1, ...source, ...layers, ...commits, stagedPatchHash: digest(staged), workingPatchHash: digest(working),
      omissions: ["原 Git 配置、hooks、历史祖先和 reflog", "HOME、Pi 配置、会话及控制凭据", "进程、数据库、外部服务和安装的依赖", "排除规则命中的文件；规则无法识别所有秘密", "未执行或认证任何测试结果"] });
    // Contractless artifacts keep their prior wire shape for older readers.
    const raw = JSON.stringify({ ...manifest, contracts: manifest.contracts.length ? manifest.contracts : undefined, resolution: manifest.resolution ?? undefined }); if (Buffer.byteLength(raw) > MANIFEST_LIMIT) fail("snapshot_limit");
    await mkdir(path.join(temp, "blobs"), { mode: 0o700 });
    const included = new Set([...manifest.head, ...manifest.index, ...manifest.worktree].map(entry => entry.hash));
    for (const hash of included) await durable(path.join(temp, "blobs", hash), blobs.get(hash)!);
    await durable(path.join(temp, "staged.patch"), staged); await durable(path.join(temp, "working.patch"), working); await durable(path.join(temp, "manifest.json"), raw);
    await rm(gitDir, { recursive: true, force: true }); await syncDir(path.join(temp, "blobs")); await syncDir(temp);
    try { await rename(temp, destination); await syncDir(path.dirname(destination)); }
    catch (error) { if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    return checkSource(await loadSnapshot(root, source.id));
  } finally { await rm(temp, { recursive: true, force: true }); }
}

export async function restoreSnapshot(root: string, workspaceId: string, snapshotId: string, manifestHash: string): Promise<WorkspaceLocation> {
  const { manifest, blobs } = await loadSnapshot(root, snapshotId, manifestHash);
  const directoryPath = path.join(root, "snapshots", `${snapshotId}.${randomUUID()}.restore`);
  try {
    const commits = await materialize(directoryPath, manifest, blobs);
    if (Object.entries(commits).some(([key, value]) => manifest[key as keyof typeof commits] !== value)) fail("snapshot_invalid_artifact");
    const workspace = await createWorkspace(root, workspaceId, directoryPath, manifest.exportedHead, true);
    await git(workspace.checkout, ["read-tree", "--reset", "-u", manifest.worktreeCommit]);
    await git(workspace.checkout, ["read-tree", manifest.indexCommit]);
    await rm(path.join(workspace.checkout, ".git", "info", "attributes"));
    const restored = await scan(workspace.checkout);
    for (const layer of ["head", "index", "worktree"] as const) {
      if (JSON.stringify(restored[layer]) !== JSON.stringify(manifest[layer])) fail("snapshot_restore_mismatch");
    }
    await durable(path.join(workspace.root, "snapshot.json"), JSON.stringify({ snapshotId, manifestHash, sourceRunId: manifest.runId, sourceHead: manifest.sourceHead, exportedHead: manifest.exportedHead }));
    return workspace;
  } finally { await rm(directoryPath, { recursive: true, force: true }); }
}

/** Integration consumes independently reconstructed objects, never a claimed
 * commit ID from agent-controlled Git history. */
export async function verifiedSnapshot(root: string, snapshotId: string, manifestHash: string) {
  const saved = await loadSnapshot(root, snapshotId, manifestHash);
  const temporary = path.join(root, "snapshots", `${snapshotId}.${randomUUID()}.verify`);
  try {
    const commits = await materialize(temporary, saved.manifest, saved.blobs);
    if (Object.entries(commits).some(([key,value])=>saved.manifest[key as keyof typeof commits]!==value)) fail("snapshot_invalid_artifact");
    return saved;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

/** Validation must not certify a formatter/test that changed the captured code. */
export async function verifySnapshotWorkingTree(checkout: string, manifest: SnapshotManifest) {
  const current = await scan(checkout);
  if (JSON.stringify(current.worktree) !== JSON.stringify(manifest.worktree)) fail("snapshot_validation_changed");
}

/** Private, direct dependency copies; never symlinks into another AI's workspace.
 * Read-only mode is an accident guard in native mode, not a security sandbox.
 */
export async function materializeDependencyInputs(root: string, workspaceRoot: string, raw: DependencyPin[]) {
  const pins = dependencyPins.parse(raw); if (!pins.length) return;
  const directoryPath = path.join(workspaceRoot, "dependencies"); await mkdir(directoryPath, { mode: 0o700 });
  let bytes = 0, files = 0;
  for (const pin of pins) {
    if (!pin.resultId) { if (pin.kind === "strict") fail("snapshot_dependency_missing"); continue; }
    const { manifest, blobs } = await loadSnapshot(root, pin.snapshotId!, pin.manifestHash!);
    if (manifest.worktreeCommit !== pin.worktreeCommit) fail("snapshot_dependency_mismatch");
    const destination = path.join(directoryPath, pin.taskId); await mkdir(destination, { mode: 0o700 });
    for (const entry of manifest.worktree) {
      bytes += entry.size; if (++files > 20000 || bytes > 128 * 1024 * 1024) fail("snapshot_dependency_limit");
      const file = path.join(destination, entry.path); await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, blobs.get(entry.hash)!, { mode: entry.mode === "100755" ? 0o555 : 0o444, flag: "wx" });
    }
  }
  await durable(path.join(directoryPath, "inputs.json"), JSON.stringify(pins));
  await chmod(path.join(directoryPath, "inputs.json"), 0o400);
}

export async function verifyDependencyInputs(root: string, workspaceRoot: string, raw: DependencyPin[]) {
  const pins = dependencyPins.parse(raw); if (!pins.length) return;
  const directoryPath = path.join(workspaceRoot, "dependencies"); await directory(directoryPath);
  if ((await regular(path.join(directoryPath, "inputs.json"), 65536)).toString("utf8") !== JSON.stringify(pins)) fail("snapshot_dependency_mismatch");
  for (const pin of pins) {
    if (!pin.resultId) { if (pin.kind === "strict") fail("snapshot_dependency_missing"); continue; }
    const { manifest } = await loadSnapshot(root, pin.snapshotId!, pin.manifestHash!);
    if (manifest.worktreeCommit !== pin.worktreeCommit) fail("snapshot_dependency_mismatch");
    const destination = path.join(directoryPath, pin.taskId); await directory(destination);
    const expected = new Map(manifest.worktree.map(entry => [entry.path, entry])); let count = 0;
    const walk = async (dir: string, prefix = "") => {
      for (const name of await readdir(dir)) {
        if (++count > 10000) fail("snapshot_limit");
        const relative = prefix + name, file = path.join(dir, name), info = await lstat(file);
        if (info.isSymbolicLink()) fail("snapshot_dependency_mismatch");
        if (info.isDirectory()) await walk(file, `${relative}/`);
        else {
          const entry = expected.get(relative); if (!entry || digest(await regular(file, FILE_LIMIT)) !== entry.hash || !!(info.mode & 0o111) !== (entry.mode === "100755")) fail("snapshot_dependency_mismatch");
          expected.delete(relative);
        }
      }
    };
    await walk(destination); if (expected.size) fail("snapshot_dependency_mismatch");
  }
}

export function snapshotSummary(manifest: SnapshotManifest) {
  const head = new Map(manifest.head.map(entry => [entry.path, entry])), index = new Map(manifest.index.map(entry => [entry.path, entry])), work = new Map(manifest.worktree.map(entry => [entry.path, entry]));
  const equal = (a: Entry | undefined, b: Entry | undefined) => a?.hash === b?.hash && a?.mode === b?.mode;
  const changes = [...new Set([...head.keys(), ...index.keys(), ...work.keys()])].sort().filter(file => !equal(head.get(file), index.get(file)) || !equal(index.get(file), work.get(file)))
    .map(file => ({ path: file, staged: !equal(head.get(file), index.get(file)), untracked: !index.has(file) && work.has(file), deleted: !work.has(file) }));
  return { sourceHead: manifest.sourceHead, exportedHead: manifest.exportedHead, fileCount: manifest.worktree.length, changes: changes.slice(0, 200), changeCount: changes.length,
    excluded: manifest.excluded.slice(0, 200), excludedCount: manifest.excluded.length, omissions: manifest.omissions };
}
