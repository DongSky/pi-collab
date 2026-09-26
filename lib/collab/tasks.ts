import { z } from "zod";
import { asUser } from "./database";
import { audit, projectRole, uuid } from "./projects";
import { DomainError } from "./policy";

export const taskInput = z.object({ title: z.string().trim().min(1).max(200), description: z.string().max(20000).default(""), acceptance: z.string().max(20000).default(""), ownerId: z.string().min(1).optional() }).strict();
export const dependencyInput = z.object({ dependsOn: uuid, kind: z.enum(["strict", "soft"]).default("strict") }).strict();

export function createTask(userId: string, projectId: string, input: z.infer<typeof taskInput>) {
  return asUser(userId, async client => {
    const role = await projectRole(client, projectId, "task.create");
    const ownerId = input.ownerId ?? userId;
    if (ownerId !== userId && role !== "maintainer") throw new DomainError("forbidden", "Only a maintainer can assign another member", 403);
    const project = (await client.query("SELECT organization_id FROM collab.projects WHERE id=$1", [projectId])).rows[0];
    const owner = await client.query("SELECT 1 FROM collab.project_memberships pm JOIN collab.memberships m ON m.organization_id=pm.organization_id AND m.user_id=pm.user_id WHERE pm.project_id=$1 AND pm.user_id=$2 AND pm.role IN ('developer','maintainer') AND pm.active AND m.active", [projectId, ownerId]);
    if (!owner.rowCount) throw new DomainError("invalid_owner", "Task owner must be an active project developer");
    const task = (await client.query("INSERT INTO collab.tasks(organization_id,project_id,title,description,acceptance,owner_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *", [project.organization_id, projectId, input.title, input.description, input.acceptance, ownerId, userId])).rows[0];
    await audit(client, project.organization_id, projectId, userId, "task.created", task.id);
    return task;
  });
}

export function addDependency(userId: string, taskId: string, input: z.infer<typeof dependencyInput>) {
  uuid.parse(taskId); const parsed = dependencyInput.parse(input);
  return asUser(userId, async client => (await client.query("SELECT collab.add_task_dependency($1,$2,$3) AS result", [taskId, parsed.dependsOn, parsed.kind])).rows[0].result).catch(error => {
    if (error?.code === "P0001" && error.message === "dependency_cycle") throw new DomainError("dependency_cycle", "This dependency would create a cycle", 409);
    if (error?.code === "P0001" && error.message === "not_found") throw new DomainError("not_found", "Task or dependency not found in this project", 404);
    throw error;
  });
}
