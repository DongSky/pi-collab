import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { link, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { z } from "zod";
import { asUser } from "./database";
import { projectRole, uuid } from "./projects";
import { DomainError } from "./policy";
import { forceWriteback, runDocumentWriteback } from "./local-writeback";
import { safeSnapshotPath, snapshotExcludedPath } from "./runtime/snapshots";
import { getAllowedFileRoots, allowFileRoot } from "../file-access";
import { isPathWithinRoots } from "../path-security";
import type { EditorWriteback } from "./editor-schema";

const bindingInput = z.object({ localPath: z.string().min(1).max(4096) }).strict();
const resolveInput = z.object({ decision: z.enum(["overwrite", "retry"]) }).strict();
const saveAsLocalInput = z.object({ localPath: z.string().min(1).max(4096) }).strict();
const dataRoot = () => process.env.PI_COLLAB_DATA_DIR ?? path.resolve(".local");

export type LocalBindingView = { id: string; projectId: string; localPath: string; createdAt: string; updatedAt: string };

/**
 * Validate a server-side absolute directory for binding. The binding is an
 * explicit, audited, maintainer/developer-only action, so any existing local
 * directory qualifies — except the server data dir itself (writes there would
 * corrupt snapshots/workspaces) or a parent of it.
 */
export function validateBindingPath(raw: string): string {
 const fail = (message: string): never => { throw new DomainError("invalid_local_binding", message, 400); };
 const trimmed = raw.trim();
 if (!trimmed) fail("请填写本机目录的绝对路径。");
 if (!path.isAbsolute(trimmed)) fail("需要绝对路径，例如 /home/user/my-project。");
 const resolved = path.resolve(trimmed);
 let real: string;
 try { real = realpathSync(resolved); } catch { fail("目录不存在或无法访问，请检查路径。"); real = resolved; }
 if (!statSync(real).isDirectory()) fail("该路径不是目录。");
 let dataDir: string | null = null;
 try { dataDir = realpathSync(dataRoot()); } catch { dataDir = null; }
 if (dataDir && (real === dataDir || real.startsWith(dataDir + path.sep))) fail("不能关联服务端数据目录本身。");
 if (dataDir && (dataDir === real || dataDir.startsWith(real + path.sep))) fail("不能关联包含服务端数据目录的上级目录。");
 return real;
}

export function getLocalBinding(userId: string, projectId: string): Promise<{ binding: LocalBindingView | null }> {
 uuid.parse(projectId);
 return asUser(userId, async db => {
  await projectRole(db, projectId, "project.read");
  // Bindings are per-user: each user only ever sees their own.
  const row = (await db.query(
   "SELECT id, project_id AS \"projectId\", local_path AS \"localPath\", created_at AS \"createdAt\", updated_at AS \"updatedAt\" FROM collab.project_local_bindings WHERE project_id=$1 AND owner_user_id=$2",
   [projectId, userId])).rows[0];
  return { binding: row ?? null };
 });
}

export function setLocalBinding(userId: string, projectId: string, raw: unknown): Promise<{ binding: { id: string; projectId: string; localPath: string } }> {
 uuid.parse(projectId);
 const input = bindingInput.parse(raw);
 const localPath = validateBindingPath(input.localPath);
 return asUser(userId, async db => {
  try {
   const result = (await db.query("SELECT collab.set_project_local_binding($1,$2) AS result", [projectId, localPath])).rows[0].result as { id: string; projectId: string; localPath: string };
   // The user explicitly authorized this directory (audited, MFA-gated): make
   // it browsable and a valid per-document save-as target, like cwd/validate.
   allowFileRoot(localPath);
   return { binding: result };
  } catch (error) {
   // Race with another project's bind of the same directory (the function also
   // raises local_binding_conflict via P0001, mapped in lib/collab/http.ts).
   if ((error as { code?: string }).code === "23505") throw new DomainError("local_binding_conflict", "此本地目录已关联到另一个项目，请先解绑或选择其他目录。", 409);
   throw error;
  }
 });
}

export function removeLocalBinding(userId: string, projectId: string): Promise<{ removed: boolean }> {
 uuid.parse(projectId);
 return asUser(userId, async db => {
  const before = (await db.query("SELECT id FROM collab.project_local_bindings WHERE project_id=$1", [projectId])).rows[0];
  await db.query("SELECT collab.remove_project_local_binding($1)", [projectId]);
  return { removed: !!before };
 });
}

/**
 * Explicit user resolution of a write-back conflict.
 * - "overwrite": write the current shared-draft content to the local file
 *   regardless of disk state (or remove it when the document was deleted) and
 *   adopt the result as the new baseline.
 * - "retry": re-run the normal write-back against the current disk content
 *   (the user may have resolved the external edit on disk themselves).
 * Works for both project bindings and per-document local paths.
 */
export function resolveWriteback(userId: string, sessionId: string, documentId: string, raw: unknown) {
 z.uuid().parse(sessionId); z.uuid().parse(documentId);
 const input = resolveInput.parse(raw);
 return asUser(userId, async db => {
  const s = (await db.query("SELECT s.project_id AS \"projectId\" FROM collab.editor_sessions WHERE id=$1", [sessionId])).rows[0] as { projectId: string } | undefined;
  if (!s) throw new DomainError("not_found", "共编草稿不存在或不可访问。", 404);
  await projectRole(db, s.projectId, "task.create");
  const d = (await db.query("SELECT id, path, content, original_text, deleted, local_path AS \"localPath\" FROM collab.editor_documents WHERE id=$1 AND session_id=$2", [documentId, sessionId])).rows[0] as { id: string; path: string; content: string; original_text: string | null; deleted: boolean; localPath: string | null } | undefined;
  if (!d) throw new DomainError("not_found", "文件不存在或不可访问。", 404);
  const binding = (await db.query("SELECT id, local_path AS \"localPath\" FROM collab.project_local_bindings WHERE project_id=$1 AND owner_user_id=$2", [s.projectId, userId])).rows[0] as { id: string; localPath: string } | undefined;
  if (input.decision === "retry") {
   return runDocumentWriteback(db, s.projectId, { id: d.id, path: d.path, content: d.content, original_text: d.original_text, local_path: d.localPath }, { deleted: d.deleted })
    .catch(error => ({ status: "error", message: error instanceof Error ? error.message : "本地回写失败" }) as EditorWriteback);
  }
  const org = (await db.query("SELECT organization_id FROM collab.projects WHERE id=$1", [s.projectId])).rows[0]?.organization_id;
  const audit = (detail: unknown) => db.query(
   "INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES($1,$2,$3,'editor.local_writeback_resolved',$4,$5)",
   [org, s.projectId, userId, d.id, JSON.stringify(detail)]);
  const bytes = d.deleted ? null : Buffer.from(d.content, "utf8");
  if (binding) {
   await forceWriteback(binding.localPath, d.path, bytes);
   if (d.deleted) await db.query("SELECT collab.clear_local_writeback($1,$2)", [binding.id, d.path]);
   else await db.query("SELECT collab.record_local_writeback($1,$2,$3,$4)", [binding.id, d.path, createHash("sha256").update(bytes!).digest("hex"), bytes]);
   await audit({ sessionId, path: d.path, decision: input.decision, scope: "binding" });
   return { status: d.deleted ? "deleted" : "written", scope: "binding", localPath: binding.localPath, path: d.path };
  }
  if (d.localPath) {
   await forceWriteback(path.dirname(d.localPath), path.basename(d.localPath), bytes);
   if (d.deleted) await db.query("SELECT collab.clear_document_writeback($1)", [d.id]);
   else await db.query("SELECT collab.record_document_writeback($1,$2,$3)", [d.id, createHash("sha256").update(bytes!).digest("hex"), bytes]);
   await audit({ sessionId, path: d.path, decision: input.decision, scope: "document", localPath: d.localPath });
   return { status: d.deleted ? "deleted" : "written", scope: "document", localPath: d.localPath };
  }
  throw new DomainError("local_binding_missing", "项目尚未关联本地目录。", 409);
 });
}

/**
 * Validate an absolute local file target for per-document save-as.
 * The target must be inside the app's allowed file roots (the same boundary
 * the file browser enforces) and outside the server data directory; the name
 * itself must pass the editor path rules. Never overwrites an existing file.
 */
async function validateSaveAsLocalTarget(raw: string): Promise<string> {
 const fail = (message: string): never => { throw new DomainError("invalid_local_path", message, 400); };
 const trimmed = raw.trim();
 if (!trimmed) fail("请填写本地保存路径。");
 if (!path.isAbsolute(trimmed)) fail("需要绝对路径。");
 const normalized = path.normalize(trimmed);
 const base = path.basename(normalized);
 if (!safeSnapshotPath(base) || snapshotExcludedPath(base)) fail("文件名不合法或属于受限路径，无法保存到本地。");
 const roots = await getAllowedFileRoots();
 if (!isPathWithinRoots(normalized, roots)) fail("该路径不在允许访问的目录范围内，请先在文件浏览器中打开该目录。");
 let dataDir: string | null = null;
 try { dataDir = realpathSync(dataRoot()); } catch { dataDir = null; }
 if (dataDir && (normalized === dataDir || normalized.startsWith(dataDir + path.sep))) fail("不能保存到服务端数据目录。");
 // Resolve the nearest existing ancestor so a planted symlink cannot redirect
 // the write outside the allowed roots.
 let probe = path.dirname(normalized);
 for (;;) {
  let real: string;
  try { real = realpathSync(probe); }
  catch {
   const parent = path.dirname(probe);
   if (parent === probe) fail("路径无法解析。");
   probe = parent; continue;
  }
  if (!isPathWithinRoots(real, roots)) fail("该路径不在允许访问的目录范围内。");
  if (dataDir && (real === dataDir || real.startsWith(dataDir + path.sep))) fail("不能保存到服务端数据目录。");
  break;
 }
 // No existence check here on purpose: the create below is atomic (tmp+link),
 // so check-then-write cannot race. An existing target is reported from there.
 return normalized;
}

/**
 * Atomically create a new file, never overwriting an existing one. Writing to
 * a temp file and hard-linking it into place makes check-and-create a single
 * atomic step. When the target already exists with byte-identical content, it
 * is treated as success so a retried save-as (file written, association
 * commit lost) converges instead of erroring.
 */
async function writeNewFileAtomic(target: string, bytes: Buffer): Promise<void> {
 const dir = path.dirname(target);
 await mkdir(dir, { recursive: true });
 const tmp = path.join(dir, `.pi-saveas-${randomUUID()}.tmp`);
 await writeFile(tmp, bytes);
 try {
  await link(tmp, target);
 } catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  let identical = false;
  try { identical = createHash("sha256").update(await readFile(target)).digest("hex") === createHash("sha256").update(bytes).digest("hex"); }
  catch { identical = false; }
  if (identical) return;
  let isDir = false;
  try { isDir = (await stat(target)).isDirectory(); } catch { isDir = false; }
  throw new DomainError("local_target_exists", isDir ? "目标已存在同名目录，请换一个文件名。" : "目标文件已存在，请换一个文件名或直接编辑该文件。", 409);
 } finally {
  await rm(tmp, { force: true });
 }
}

/**
 * "Save as to local" for projects without a binding: writes the current
 * shared-draft content to a user-chosen local file and associates the document
 * with it, moving the document out of the pure shared-draft state. Later saves
 * write back to that file directly. Cancelling leaves the shared draft intact.
 */
export function saveDocumentAsLocal(userId: string, sessionId: string, documentId: string, raw: unknown): Promise<EditorWriteback> {
 z.uuid().parse(sessionId); z.uuid().parse(documentId);
 const input = saveAsLocalInput.parse(raw);
 return asUser(userId, async db => {
  await db.query("SELECT collab.editor_lock($1,false,false)", [sessionId]);
  const s = (await db.query("SELECT s.project_id AS \"projectId\" FROM collab.editor_sessions s WHERE s.id=$1", [sessionId])).rows[0] as { projectId: string } | undefined;
  if (!s) throw new DomainError("not_found", "共编草稿不存在或不可访问。", 404);
  await projectRole(db, s.projectId, "task.create");
  const d = (await db.query("SELECT id, path, content, deleted FROM collab.editor_documents WHERE id=$1 AND session_id=$2", [documentId, sessionId])).rows[0] as { id: string; path: string; content: string; deleted: boolean } | undefined;
  if (!d) throw new DomainError("not_found", "文件不存在或不可访问。", 404);
  if (d.deleted) throw new DomainError("editor_frozen", "文件已删除；本地未同步内容可导出。", 409);
  const already = (await db.query("SELECT 1 FROM collab.project_local_bindings WHERE project_id=$1 AND owner_user_id=$2", [s.projectId, userId])).rows[0];
  if (already) throw new DomainError("local_binding_exists", "项目已关联本地目录，保存会自动回写，无需另存为到本地。", 409);
  const target = await validateSaveAsLocalTarget(input.localPath);
  const bytes = Buffer.from(d.content, "utf8");
  const sha = createHash("sha256").update(bytes).digest("hex");
  // Atomic no-clobber create; the association below stays in the same
  // transaction, and an EEXIST with identical content converges on retry.
  await writeNewFileAtomic(target, bytes);
  await db.query("SELECT collab.set_document_local_path($1,$2)", [d.id, target]);
  await db.query("SELECT collab.record_document_writeback($1,$2,$3)", [d.id, sha, bytes]);
  return { status: "written", scope: "document", localPath: target } as EditorWriteback;
 });
}
