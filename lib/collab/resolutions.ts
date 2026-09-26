import { z } from "zod";
import { asUser } from "./database";
import { DomainError } from "./policy";
import { uuid } from "./projects";
export const createResolutionInput = z.object({ ownerId: z.string().min(1), title: z.string().trim().min(1).max(200), reason: z.string().trim().min(10).max(2000), idempotencyKey: uuid }).strict();
export function createResolutionTask(userId: string, integrationId: string, raw: z.infer<typeof createResolutionInput>) {
  uuid.parse(integrationId); const input = createResolutionInput.parse(raw);
  return asUser(userId, async db => (await db.query("SELECT collab.create_resolution_task($1,$2,$3,$4,$5) AS result", [integrationId, input.ownerId, input.title, input.reason, input.idempotencyKey])).rows[0].result as { taskId: string; replayed: boolean });
}
export function resolutionDetail(userId: string, taskId: string) {
  uuid.parse(taskId);
  return asUser(userId, async db => {
    if (!(await db.query("SELECT 1 FROM collab.tasks WHERE id=$1", [taskId])).rowCount) throw new DomainError("not_found", "任务不存在或不可访问。", 404);
    return { revert: (await db.query("SELECT rt.*,r.base_sha=rt.target_sha AS current FROM collab.revert_tasks rt JOIN collab.repositories r ON r.id=rt.repository_id WHERE task_id=$1", [taskId])).rows[0] ?? null, resolution: (await db.query("SELECT rt.task_id,rt.integration_id,rt.input,rt.created_by,rt.created_at,collab.integration_state(rt.integration_id) AS input_state FROM collab.resolution_tasks rt WHERE task_id=$1", [taskId])).rows[0] ?? null };
  });
}
