import { z } from "zod";
import { asUser } from "./database";
import { uuid } from "./projects";
import { DomainError } from "./policy";

export const taskEditInput = z.object({
  expectedVersion: z.number().int().positive(), idempotencyKey: uuid,
  title: z.string().trim().min(1).max(200), description: z.string().max(20000), acceptance: z.string().max(20000),
  status: z.enum(["draft", "ready", "in_progress", "in_review", "ready_to_merge", "done", "blocked", "cancelled"]),
  reason: z.string().trim().min(10).max(2000), acknowledgeCompletion: z.boolean().default(false),
}).strict();
export function editTask(userId: string, taskId: string, raw: z.input<typeof taskEditInput>) {
  uuid.parse(taskId);
  const { expectedVersion, idempotencyKey, ...change } = taskEditInput.parse(raw);
  return asUser(userId, async db => (await db.query("SELECT collab.edit_task($1,$2,$3,$4) AS result", [taskId, expectedVersion, idempotencyKey, change])).rows[0].result);
}
export function taskEditHistory(userId: string, taskId: string) {
  uuid.parse(taskId);
  return asUser(userId, async db => {
    if (!(await db.query("SELECT id FROM collab.tasks WHERE id=$1", [taskId])).rowCount) throw new DomainError("not_found", "任务不存在或不可访问。", 404);
    const rows = (await db.query(`SELECT e.id,e.version,e.previous,e.updated,e.reason,e.evidence_invalidated,e.created_at,u.name AS actor_name
      FROM collab.task_edits e JOIN public."user" u ON u.id=e.actor_id WHERE e.task_id=$1 ORDER BY e.version DESC LIMIT 51`, [taskId])).rows;
    return { edits: rows.slice(0, 50), truncated: rows.length > 50 };
  });
}
