import { z } from "zod";
import { asUser } from "./database";
import { projectRole, uuid } from "./projects";

const role = z.enum(["maintainer", "developer", "reviewer", "viewer"]);
export const addProjectMemberInput = z.object({ email: z.email().trim().toLowerCase(), role }).strict();
export const changeProjectMemberInput = z.object({ role, active: z.boolean(), expectedVersion: z.string().regex(/^[1-9][0-9]{0,17}$/) }).strict();
export const recoveryInput = z.object({ reason: z.string().trim().min(10).max(2000) }).strict();
export const reassignTaskInput = z.object({ ownerId: z.string().min(1).max(128), expectedVersion: z.number().int().positive() }).strict();

export function projectMembers(userId: string, projectId: string) {
  uuid.parse(projectId);
  return asUser(userId, async db => {
    await projectRole(db, projectId, "project.members");
    const project = (await db.query("SELECT id,name FROM collab.projects WHERE id=$1", [projectId])).rows[0];
    const members = (await db.query(`SELECT pm.user_id,pm.role,pm.active,pm.authorization_version::text AS version,
      m.active AS organization_active,u.name,u.email,
      (SELECT count(*)::integer FROM collab.tasks WHERE project_id=pm.project_id AND owner_id=pm.user_id AND status NOT IN ('done','cancelled')) AS open_tasks
      FROM collab.project_memberships pm JOIN collab.memberships m ON m.organization_id=pm.organization_id AND m.user_id=pm.user_id
      JOIN public."user" u ON u.id=pm.user_id WHERE pm.project_id=$1 ORDER BY pm.active DESC,u.name`, [projectId])).rows;
    const tasks = (await db.query("SELECT id,title,owner_id,version,status FROM collab.tasks WHERE project_id=$1 AND status NOT IN ('done','cancelled') ORDER BY created_at DESC", [projectId])).rows;
    return { project, members, tasks };
  });
}
export function addProjectMember(userId: string, projectId: string, raw: z.infer<typeof addProjectMemberInput>) {
  uuid.parse(projectId); const input = addProjectMemberInput.parse(raw);
  return asUser(userId, async db => (await db.query("SELECT collab.add_project_member($1,$2,$3) AS result", [projectId, input.email, input.role])).rows[0].result);
}
export function changeProjectMember(userId: string, projectId: string, target: string, raw: z.infer<typeof changeProjectMemberInput>) {
  uuid.parse(projectId); z.string().min(1).max(128).parse(target); const input = changeProjectMemberInput.parse(raw);
  return asUser(userId, async db => (await db.query("SELECT collab.change_project_member($1,$2,$3,$4,$5) AS result", [projectId, target, input.role, input.active, input.expectedVersion])).rows[0].result);
}
export function recoverProject(userId: string, projectId: string, raw: z.infer<typeof recoveryInput>) {
  uuid.parse(projectId); const input = recoveryInput.parse(raw);
  return asUser(userId, async db => (await db.query("SELECT collab.recover_project($1,$2) AS result", [projectId, input.reason])).rows[0].result);
}
export function reassignTask(userId: string, taskId: string, raw: z.infer<typeof reassignTaskInput>) {
  uuid.parse(taskId); const input = reassignTaskInput.parse(raw);
  return asUser(userId, async db => (await db.query("SELECT collab.reassign_task($1,$2,$3) AS result", [taskId, input.ownerId, input.expectedVersion])).rows[0].result);
}
