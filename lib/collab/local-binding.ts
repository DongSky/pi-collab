import path from "node:path";
import { realpathSync, statSync } from "node:fs";
import { z } from "zod";
import { asUser } from "./database";
import { projectRole, uuid } from "./projects";
import { DomainError } from "./policy";
import { forceWriteback, runDocumentWriteback } from "./local-writeback";
import type { EditorWriteback } from "./editor-schema";

const bindingInput = z.object({ localPath: z.string().min(1).max(4096) }).strict();
const resolveInput = z.object({ decision: z.enum(["overwrite", "retry"]) }).strict();
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
  const row = (await db.query(
   "SELECT id, project_id AS \"projectId\", local_path AS \"localPath\", created_at AS \"createdAt\", updated_at AS \"updatedAt\" FROM collab.project_local_bindings WHERE project_id=$1",
   [projectId])).rows[0];
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
 * - "overwrite": write the current shared-draft content to the bound file
 *   regardless of disk state (or remove it when the document was deleted) and
 *   adopt the result as the new baseline.
 * - "retry": re-run the normal write-back against the current disk content
 *   (the user may have resolved the external edit on disk themselves).
 */
export function resolveWriteback(userId: string, sessionId: string, documentId: string, raw: unknown) {
 z.uuid().parse(sessionId); z.uuid().parse(documentId);
 const input = resolveInput.parse(raw);
 return asUser(userId, async db => {
  const s = (await db.query("SELECT s.project_id AS \"projectId\" FROM collab.editor_sessions WHERE id=$1", [sessionId])).rows[0] as { projectId: string } | undefined;
  if (!s) throw new DomainError("not_found", "共编草稿不存在或不可访问。", 404);
  await projectRole(db, s.projectId, "task.create");
  const d = (await db.query("SELECT id, path, content, original_text, deleted FROM collab.editor_documents WHERE id=$1 AND session_id=$2", [documentId, sessionId])).rows[0] as { id: string; path: string; content: string; original_text: string | null; deleted: boolean } | undefined;
  if (!d) throw new DomainError("not_found", "文件不存在或不可访问。", 404);
  const binding = (await db.query("SELECT id, local_path AS \"localPath\" FROM collab.project_local_bindings WHERE project_id=$1", [s.projectId])).rows[0] as { id: string; localPath: string } | undefined;
  if (!binding) throw new DomainError("local_binding_missing", "项目尚未关联本地目录。", 409);
  if (input.decision === "retry") {
   return runDocumentWriteback(db, s.projectId, { id: d.id, path: d.path, content: d.content, original_text: d.original_text }, { deleted: d.deleted })
    .catch(error => ({ status: "error", message: error instanceof Error ? error.message : "本地回写失败" }) as EditorWriteback);
  }
  await forceWriteback(binding.localPath, d.path, d.deleted ? null : Buffer.from(d.content, "utf8"));
  if (d.deleted) await db.query("SELECT collab.clear_local_writeback($1,$2)", [binding.id, d.path]);
  else {
   const { createHash } = await import("node:crypto");
   const bytes = Buffer.from(d.content, "utf8");
   await db.query("SELECT collab.record_local_writeback($1,$2,$3,$4)", [binding.id, d.path, createHash("sha256").update(bytes).digest("hex"), bytes]);
  }
  const org = (await db.query("SELECT organization_id FROM collab.projects WHERE id=$1", [s.projectId])).rows[0]?.organization_id;
  await db.query(
   "INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES($1,$2,$3,'editor.local_writeback_resolved',$4,$5)",
   [org, s.projectId, userId, d.id, JSON.stringify({ sessionId, path: d.path, decision: input.decision })]);
  return { status: d.deleted ? "deleted" : "written", localPath: binding.localPath, path: d.path };
 });
}
