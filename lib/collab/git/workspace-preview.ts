import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import { z } from "zod";
import { asUser } from "../database";
import { DomainError } from "../policy";
import { inspectWorkspaceGit, type WorkspaceGitView } from "../runtime/workspace-git-view";
import { sourceSchema, workspaceGitFileQuery, type WorkspaceGitOperation } from "./workspace-schema";

type Scope = { runId: string; runRevision: string; workspaceId: string; executorId: string | null; epoch: string; runtime: string;
  runStatus: string; workspaceStatus: string; taskVersion: number; ownerId: string; role: string; organizationVersion: string; projectVersion: string; canWrite: boolean; pushPreviewBusy: boolean };
async function scope(db: PoolClient, runId: string): Promise<Scope> {
  const row = (await db.query<Scope>(`SELECT r.id AS "runId",r.revision::text AS "runRevision",w.id AS "workspaceId",r.executor_id AS "executorId",r.epoch::text AS epoch,w.runtime,
    r.status AS "runStatus",w.status AS "workspaceStatus",t.version AS "taskVersion",t.owner_id AS "ownerId",collab.project_role(r.project_id) AS role,
    m.authorization_version::text AS "organizationVersion",pm.authorization_version::text AS "projectVersion",
    (collab.project_role(r.project_id)='maintainer' OR (collab.project_role(r.project_id)='developer' AND t.owner_id=collab.actor()))
    AND (NOT collab.user_requires_mfa(collab.actor()) OR collab.actor_has_mfa()) AS "canWrite",
    EXISTS(SELECT 1 FROM jsonb_array_elements(collab.task_push_previews(r.id)) item WHERE item->>'status' IN ('queued','running')) AS "pushPreviewBusy"
    FROM collab.runs r JOIN collab.workspaces w ON w.id=r.workspace_id JOIN collab.tasks t ON t.id=r.task_id
    JOIN collab.memberships m ON m.organization_id=r.organization_id AND m.user_id=collab.actor()
    JOIN collab.project_memberships pm ON pm.project_id=r.project_id AND pm.user_id=m.user_id WHERE r.id=$1`, [runId])).rows[0];
  if (!row) throw new DomainError("not_found", "运行不存在或项目访问权限已变化。", 404);
  return row;
}
const available = (row: Scope) => ["native","docker"].includes(row.runtime) && row.workspaceStatus === "stopped" && ["completed", "failed", "cancelled"].includes(row.runStatus) && !!row.executorId && row.epoch !== "0";
const history = async (db: PoolClient, runId: string): Promise<WorkspaceGitOperation[]> => (await db.query("SELECT collab.workspace_git_operations($1) AS result", [runId])).rows[0].result;
const unfinished = (items: WorkspaceGitOperation[]) => items.some(item => !["applied", "aborted"].includes(item.status));
export function workspaceGitState(userId: string, runId: string) {
  z.uuid().parse(runId);
  return asUser(userId, async db => {
    const row = await scope(db, runId), operations = await history(db, runId);
    return { canWrite: row.canWrite, available: available(row), occupied: row.pushPreviewBusy || unfinished(operations), runRevision: row.runRevision, operations };
  });
}
export type WorkspaceGitState = Awaited<ReturnType<typeof workspaceGitState>>;
const key = Symbol.for("pi-collab:workspace-git-readers");
const slots = globalThis as typeof globalThis & { [key]?: { active: number } };
async function authorized<T>(userId: string, runId: string, work: (view: WorkspaceGitView, row: Scope, signal: AbortSignal) => Promise<T>, external?: AbortSignal) {
  z.uuid().parse(runId); const capacity = slots[key] ??= { active: 0 };
  if (capacity.active >= 2) throw new DomainError("code_reader_busy", "Git 差异正在读取，请稍后重试。", 429);
  capacity.active++;
  try {
    return await asUser(userId, async db => {
      const before = await scope(db, runId);
      if (!available(before)) throw new DomainError("workspace_git_unavailable", "只有已确认停止、尚未归档的工作区可以检查 Git 变更。", 409);
      if (before.pushPreviewBusy || unfinished(await history(db, runId))) throw new DomainError("workspace_git_busy", "已有 Git 操作或推送预览执行中，请等待完成或查看原操作记录。", 409);
      const deadline = AbortSignal.timeout(20000), signal = external ? AbortSignal.any([external, deadline]) : deadline;
      let result: T;
      try {
        const source = sourceSchema.parse({ ...(before.runtime==="docker"?{runtime:"docker"}:{}), workspaceId: before.workspaceId, identity: { runId, executorId: before.executorId, epoch: before.epoch } });
        result = await work(await inspectWorkspaceGit(process.env.PI_COLLAB_DATA_DIR ?? path.resolve(".local"), source, signal), before, signal);
      } catch (error) {
        if (error instanceof DomainError) throw error;
        throw new DomainError("workspace_git_unavailable", "工作区的退出证据、Git 锁或代码状态无法核验。请确认旧操作并重新读取。", 409);
      }
      // READ COMMITTED rechecks current RLS and versions after filesystem work.
      // No cache may keep serving bytes after project access is revoked.
      const after = await scope(db, runId);
      if (!isDeepStrictEqual(before, after) || unfinished(await history(db, runId))) throw new DomainError("workspace_git_stale_revision", "权限、运行或 Git 操作状态已经变化，请重新读取差异。", 409);
      return result;
    });
  } finally { capacity.active--; }
}
export function workspaceGitPreview(userId: string, runId: string, signal?: AbortSignal) {
  return authorized(userId, runId, async (view, row) => {
    const { revision, branch, head, indexTree, indexHash, files, exclusions, commitBlockedPaths, stagingPolicy } = view.summary();
    return { runId, runRevision: row.runRevision, canWrite: row.canWrite, revision, branch, head, indexTree, indexHash, files, exclusions, commitBlockedPaths, stagingPolicy };
  }, signal);
}
export function workspaceGitFile(userId: string, runId: string, raw: unknown, signal?: AbortSignal) {
  const query = workspaceGitFileQuery.parse(raw);
  return authorized(userId, runId, async (view, _row, deadline) => {
    if (query.revision !== view.revision) throw new DomainError("workspace_git_stale_revision", "工作文件、索引或 HEAD 已变化，请重新读取差异。", 409);
    const item = view.summary().files.find(item => item.path === query.path && item[query.layer]);
    if (!item || item.excluded) throw new DomainError("workspace_git_file_unavailable", "该文件不属于所选差异，或其内容已被排除。", 409);
    return view.file(query.layer, query.path, deadline);
  }, signal);
}
export type WorkspaceGitPreview = Awaited<ReturnType<typeof workspaceGitPreview>>;
export type WorkspaceGitFile = Awaited<ReturnType<typeof workspaceGitFile>>;
