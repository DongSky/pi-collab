import { z } from "zod";
import { asUser } from "./database";
import { projectRole } from "./projects";
export const revertTaskInput = z.object({ promotionId: z.uuid(), baseSha: z.string().regex(/^[a-f0-9]{40}$/), title: z.string().trim().min(1).max(200), reason: z.string().trim().min(10).max(2000), idempotencyKey: z.uuid() }).strict();
export function createRevertTask(userId: string, raw: z.infer<typeof revertTaskInput>) {
  const input = revertTaskInput.parse(raw);
  return asUser(userId, async db => (await db.query("SELECT collab.create_revert_task($1,$2,$3,$4,$5) AS result", [input.promotionId, input.baseSha, input.title, input.reason, input.idempotencyKey])).rows[0].result as { taskId: string; replayed: boolean });
}
export function revertCatalogue(userId: string, projectId: string) {
  z.uuid().parse(projectId);
  return asUser(userId, async db => {
    await projectRole(db, projectId, "project.read");
    return { sources: (await db.query("SELECT b.promotion_id,b.repository_id,b.old_sha,b.new_sha,b.created_at,r.name,r.base_sha FROM collab.repository_baselines b JOIN collab.repositories r ON r.id=b.repository_id WHERE b.project_id=$1 AND b.promotion_id IS NOT NULL ORDER BY b.sequence DESC LIMIT 100", [projectId])).rows,
      tasks: (await db.query("SELECT rt.task_id,rt.promotion_id,rt.target_sha,t.title,r.base_sha=rt.target_sha AS current FROM collab.revert_tasks rt JOIN collab.tasks t ON t.id=rt.task_id JOIN collab.repositories r ON r.id=rt.repository_id WHERE rt.project_id=$1 ORDER BY rt.created_at DESC LIMIT 100", [projectId])).rows };
  });
}
