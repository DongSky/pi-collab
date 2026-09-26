import { z } from "zod";
import { asUser } from "./database";
import { uuid } from "./projects";
import { DomainError } from "./policy";

export const publishResultInput = z.object({ validationId: uuid, expectedVersion: z.number().int().positive(), idempotencyKey: uuid, note: z.string().trim().min(1).max(4000), acknowledgeResolution: z.boolean().optional() }).strict();
export const withdrawResultInput = z.object({ reason: z.string().trim().min(10).max(2000) }).strict();
export function publishResult(userId: string, taskId: string, raw: z.infer<typeof publishResultInput>) {
  uuid.parse(taskId); const input = publishResultInput.parse(raw);
  return asUser(userId, async db => (await db.query("SELECT collab.publish_task_result($1,$2,$3,$4,$5,$6) AS result", [taskId, input.validationId, input.expectedVersion, input.idempotencyKey, input.note, input.acknowledgeResolution ?? false])).rows[0].result);
}
export function withdrawResult(userId: string, resultId: string, raw: z.infer<typeof withdrawResultInput>) {
  uuid.parse(resultId); const input = withdrawResultInput.parse(raw);
  return asUser(userId, async db => (await db.query("SELECT collab.withdraw_task_result($1,$2) AS result", [resultId, input.reason])).rows[0].result);
}
export function listTaskResults(userId: string, taskId: string) {
  uuid.parse(taskId);
  return asUser(userId, async db => {
    const task = (await db.query("SELECT version,current_result_id FROM collab.tasks WHERE id=$1", [taskId])).rows[0];
    if (!task) throw new DomainError("not_found", "任务不存在或不可访问。", 404);
    const results = (await db.query(`SELECT r.id,r.version,r.snapshot_id,r.validation_id,r.manifest_hash,r.worktree_commit,r.created_at,r.payload->>'note' AS note,
      w.reason AS withdrawal_reason,collab.run_dependency_state(r.source_run_id) AS dependency_state
      FROM collab.task_results r LEFT JOIN collab.result_withdrawals w ON w.result_id=r.id WHERE r.task_id=$1 ORDER BY r.version DESC LIMIT 50`, [taskId])).rows;
    const validations = (await db.query(`SELECT v.id,v.snapshot_id,p.name AS profile_name,v.evidence->>'worktreeCommit' AS worktree_commit
      FROM collab.validations v JOIN collab.snapshots s ON s.id=v.snapshot_id JOIN collab.validation_profiles p ON p.id=v.profile_id
      WHERE v.task_id=$1 AND v.status='passed' AND collab.run_dependency_state(s.run_id)='current' ORDER BY v.created_at DESC LIMIT 50`, [taskId])).rows;
    const resolution = (await db.query("SELECT input FROM collab.resolution_tasks WHERE task_id=$1", [taskId])).rows[0]?.input ?? null;
    const revert = (await db.query("SELECT promotion_id,target_sha,new_sha,old_sha FROM collab.revert_tasks WHERE task_id=$1", [taskId])).rows[0] ?? null;
    return { task, results, validations, resolution, revert };
  });
}
export function runDependencies(userId: string, runId: string) {
  uuid.parse(runId);
  return asUser(userId, async db => {
    const run = (await db.query("SELECT id,collab.run_dependency_state(id) AS dependency_state FROM collab.runs WHERE id=$1", [runId])).rows[0];
    if (!run) throw new DomainError("not_found", "运行不存在或不可访问。", 404);
    const dependencies = (await db.query(`SELECT d.depends_on AS task_id,t.title,d.kind,d.result_id,r.version,r.snapshot_id,r.manifest_hash,r.worktree_commit,
      (d.result_id IS NOT NULL AND d.result_id=t.current_result_id AND w.result_id IS NULL) AS is_current,w.reason AS withdrawal_reason
      FROM collab.run_dependencies d JOIN collab.tasks t ON t.id=d.depends_on LEFT JOIN collab.task_results r ON r.id=d.result_id
      LEFT JOIN collab.result_withdrawals w ON w.result_id=r.id WHERE d.run_id=$1 ORDER BY d.depends_on`, [runId])).rows;
    return { run, dependencies };
  });
}
