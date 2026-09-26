import { asUser } from "./database";
import { uuid, projectRole } from "./projects";
import { createResourceInput, manageResourceInput, controlResourceInput } from "./resource-schema";
import type { z } from "zod";
export function createResource(userId: string, projectId: string, raw: z.infer<typeof createResourceInput>) {
  uuid.parse(projectId); const input = createResourceInput.parse(raw);
  return asUser(userId, async db => (await db.query("SELECT collab.create_resource($1,$2,$3) AS result", [projectId, input.name, input.idempotencyKey])).rows[0].result);
}
export function projectResources(userId: string, projectId: string) {
  uuid.parse(projectId);
  return asUser(userId, async db => {
    await projectRole(db, projectId, "project.read");
    const resources = (await db.query(`SELECT r.id,r.name,r.kind,r.status,r.version,r.change_reason,r.epoch::text,q.id AS request_id,q.run_id,q.status AS lease_status,q.expires_at,t.title AS task_title
      FROM collab.resources r LEFT JOIN collab.resource_requests q ON q.id=r.holder_id LEFT JOIN collab.runs run ON run.id=q.run_id LEFT JOIN collab.tasks t ON t.id=run.task_id WHERE r.project_id=$1 ORDER BY r.created_at`, [projectId])).rows;
    const control = "(collab.project_role($1)='maintainer' OR (collab.project_role($1)='developer' AND requested_by=collab.actor())) AS can_control";
    const requests = (await db.query(`SELECT q.id,q.run_id,t.title AS task_title,q.status,q.expires_at,q.wait_until,q.resource_ids,${control.replace("requested_by", "q.requested_by")} FROM collab.resource_requests q JOIN collab.runs r ON r.id=q.run_id JOIN collab.tasks t ON t.id=r.task_id WHERE q.project_id=$1 AND q.status IN ('waiting','granted','releasing') ORDER BY q.created_at LIMIT 100`, [projectId])).rows;
    const jobs = (await db.query(`SELECT id,resource_id,run_id,status,cancel_requested,stopped,error_code,result,sql_hash,created_at,${control} FROM collab.resource_jobs WHERE project_id=$1 ORDER BY created_at DESC LIMIT 50`, [projectId])).rows;
    return { resources, requests, jobs };
  });
}
export function manageResource(userId: string, resourceId: string, raw: z.infer<typeof manageResourceInput>) {
  uuid.parse(resourceId); const input=manageResourceInput.parse(raw);
  return asUser(userId,async db=>(await db.query("SELECT collab.manage_resource($1,$2,$3,$4,$5) AS result",[resourceId,input.action,input.expectedVersion,input.reason,input.idempotencyKey])).rows[0].result);
}
export function controlResource(userId: string, targetId: string, raw: z.infer<typeof controlResourceInput>) {
  uuid.parse(targetId); const input=controlResourceInput.parse(raw);
  return asUser(userId,async db=>(await db.query("SELECT collab.control_resource($1,$2,$3,$4) AS result",[input.targetKind,targetId,input.reason,input.idempotencyKey])).rows[0].result);
}
