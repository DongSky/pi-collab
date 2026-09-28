import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { asUser } from "./database";
import { DomainError, requireCapability, type Capability, type ProjectRole } from "./policy";

export const uuid = z.uuid();
export const projectInput = z.object({ organizationId: uuid, name: z.string().trim().min(1).max(120), description: z.string().max(5000).default(""), workingDirectory: z.string().trim().min(1).max(4096).optional() }).strict();

export async function projectRole(client: PoolClient, projectId: string, capability: Capability) {
  const result = await client.query<{ role: ProjectRole | null }>("SELECT collab.project_role($1) AS role", [projectId]);
  const role = result.rows[0].role;
  // Do not reveal the existence of an inaccessible project.
  if (!role) throw new DomainError("not_found", "Project not found", 404);
  requireCapability(role, capability);
  return role;
}

export async function audit(client: PoolClient, organizationId: string, projectId: string | null, actorId: string, action: string, resourceId: string, detail: unknown = {}) {
  await client.query("INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES($1,$2,$3,$4,$5,$6)", [organizationId, projectId, actorId, action, resourceId, JSON.stringify(detail)]);
}

export function listProjects(userId: string) {
  return asUser(userId, async client => ({
    deletedOrganizations: (await client.query("SELECT collab.deleted_organizations() AS organizations")).rows[0].organizations as { id: string; name: string }[],
    organizations: (await client.query("SELECT o.*,m.role FROM collab.organizations o JOIN collab.memberships m ON m.organization_id=o.id WHERE m.user_id=$1 AND m.active ORDER BY o.name", [userId])).rows,
    projects: (await client.query("SELECT p.*,collab.project_role(p.id) AS role FROM collab.projects p ORDER BY p.created_at DESC")).rows,
  }));
}

export function createProject(userId: string, input: z.infer<typeof projectInput>) {
  return asUser(userId, async client => {
    const id = randomUUID();
    // RETURNING would apply SELECT RLS before the creator membership exists.
    await client.query("INSERT INTO collab.projects(id,organization_id,name,description,created_by) VALUES($1,$2,$3,$4,$5)", [id, input.organizationId, input.name, input.description, userId]);
    await client.query("INSERT INTO collab.project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,'maintainer')", [input.organizationId, id, userId]);
    // Cursor-style: importing a working directory creates the project AND binds
    // the directory, so the user can start editing/vibe-coding immediately.
    let binding: { id: string; projectId: string; localPath: string } | null = null;
    if (input.workingDirectory) {
      const { validateBindingPath } = await import("./local-binding");
      const { allowFileRoot } = await import("../file-access");
      const localPath = validateBindingPath(input.workingDirectory);
      try {
        const result = (await client.query("SELECT collab.set_project_local_binding($1,$2) AS result", [id, localPath])).rows[0].result as { id: string; projectId: string; localPath: string };
        binding = result;
        allowFileRoot(localPath);
      } catch (error) {
        if ((error as { code?: string }).code === "23505") throw new DomainError("local_binding_conflict", "此本地目录已关联到另一个项目，请先解绑或选择其他目录。", 409);
        throw error;
      }
    }
    await audit(client, input.organizationId, id, userId, "project.created", id);
    const project = (await client.query("SELECT * FROM collab.projects WHERE id=$1", [id])).rows[0];
    // Cursor-style: when importing a working directory, auto-create a default task
    // so the user can start vibe-coding immediately without manually creating a task.
    let defaultTask: { id: string; title: string } | null = null;
    if (input.workingDirectory) {
      const task = (await client.query(
        "INSERT INTO collab.tasks(organization_id,project_id,title,description,owner_id,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,title",
        [input.organizationId, id, "代码助手", "导入工作目录时自动创建。在这里直接与 AI 对话，让它帮你改代码、解释代码或执行任务。", userId, userId]
      )).rows[0];
      await audit(client, input.organizationId, id, userId, "task.created", task.id);
      defaultTask = task;
    }
    return binding ? { ...project, binding, defaultTask } : project;
  });
}

export function projectDetail(userId: string, projectId: string) {
  return asUser(userId, async client => {
    const role = await projectRole(client, projectId, "project.read");
    const project = (await client.query("SELECT * FROM collab.projects WHERE id=$1", [projectId])).rows[0];
    const tasks = (await client.query("SELECT t.*,u.name AS owner_name, EXISTS(SELECT 1 FROM collab.resolution_tasks rt WHERE rt.task_id=t.id) AS is_resolution, (pm.active AND m.active AND pm.role IN ('developer','maintainer')) AS owner_active FROM collab.tasks t JOIN public.\"user\" u ON u.id=t.owner_id JOIN collab.project_memberships pm ON pm.project_id=t.project_id AND pm.user_id=t.owner_id JOIN collab.memberships m ON m.organization_id=pm.organization_id AND m.user_id=pm.user_id WHERE t.project_id=$1 ORDER BY t.created_at DESC", [projectId])).rows;
    const members = (await client.query('SELECT pm.user_id,pm.role,u.name FROM collab.project_memberships pm JOIN public."user" u ON u.id=pm.user_id JOIN collab.memberships m ON m.organization_id=pm.organization_id AND m.user_id=pm.user_id WHERE pm.project_id=$1 AND pm.active AND m.active', [projectId])).rows;
    const dependencies = (await client.query("SELECT task_id,depends_on,kind FROM collab.task_dependencies WHERE project_id=$1", [projectId])).rows;
    const activity = (await client.query('SELECT a.id,a.action,a.resource_id,a.created_at,u.name AS actor_name FROM collab.audit_events a JOIN public."user" u ON u.id=a.actor_id WHERE a.project_id=$1 ORDER BY a.id DESC LIMIT 30', [projectId])).rows;
    return { project: { ...project, role }, tasks, members, dependencies, activity };
  });
}

export function projectAudit(userId: string, projectId: string, before?: string) {
  uuid.parse(projectId);
  if (before !== undefined && (!/^[1-9][0-9]{0,18}$/.test(before) || BigInt(before) > BigInt("9223372036854775807"))) throw new DomainError("invalid_cursor", "无效的审计游标。");
  return asUser(userId, async db => {
    await projectRole(db, projectId, "project.read");
    const rows = (await db.query('SELECT a.id,a.actor_id,u.name AS actor_name,a.action,a.resource_id,a.detail,a.created_at FROM collab.audit_events a JOIN public."user" u ON u.id=a.actor_id WHERE a.project_id=$1 AND ($2::bigint IS NULL OR a.id<$2) ORDER BY a.id DESC LIMIT 51', [projectId, before ?? null])).rows;
    const events = rows.slice(0, 50);
    return { events, nextCursor: rows.length > 50 ? events.at(-1)!.id as string : null };
  });
}
