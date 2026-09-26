import { asUser } from "./database";
import { projectRole, uuid } from "./projects";
import { mapConflicts, type MapTask, type MapDependency, type ProjectMapData } from "./project-map-model";

export function projectMap(userId: string, projectId: string): Promise<ProjectMapData> {
  uuid.parse(projectId);
  return asUser(userId, async db => {
    await projectRole(db, projectId, "project.read");
    // One statement gives tasks, live runs and edges a single MVCC snapshot.
    // Only public collaboration metadata is selected, never prompts, credentials or host paths.
    const { rows } = await db.query<{ tasks: MapTask[]; dependencies: MapDependency[]; capturedAt: string }>(`WITH nodes AS (
      SELECT t.id,t.title,t.status,t.owner_id,u.name AS owner_name,
        COALESCE(pm.active AND m.active AND pm.role IN ('developer','maintainer'),false) AS owner_active,
        CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object(
          'id',r.id,'status',r.status,'execution_kind',r.execution_kind,'dependency_state',collab.run_dependency_state(r.id),
          'started_at',r.started_at,'created_at',r.created_at,'requested_by',r.requested_by,'requested_name',actor.name,
          'workspace_status',w.status,'repository_id',w.repository_id,'repository_name',repo.name,
          'model_name',model.name,'model_id',model.model_id,'controller',collab.control_state(r.id)) END AS run,
        intent.declaration AS intent,
        CASE WHEN result.id IS NULL THEN NULL ELSE jsonb_build_object('id',result.id,'version',result.version,
          'current',NOT EXISTS(SELECT 1 FROM collab.result_withdrawals WHERE result_id=result.id)
            AND collab.run_dependency_state(result.source_run_id)='current') END AS result,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id',q.id,'status',q.status,'names',
          (SELECT COALESCE(jsonb_agg(resource.name ORDER BY resource.name),'[]'::jsonb) FROM collab.resources resource WHERE resource.id=ANY(q.resource_ids))) ORDER BY q.created_at)
          FROM collab.resource_requests q WHERE q.run_id=r.id AND q.status IN ('waiting','granted','releasing')),'[]'::jsonb) AS resources
      FROM collab.tasks t JOIN public."user" u ON u.id=t.owner_id
      LEFT JOIN collab.project_memberships pm ON pm.project_id=t.project_id AND pm.user_id=t.owner_id
      LEFT JOIN collab.memberships m ON m.organization_id=t.organization_id AND m.user_id=t.owner_id
      LEFT JOIN LATERAL (SELECT * FROM collab.runs WHERE task_id=t.id ORDER BY created_at DESC,id DESC LIMIT 1) r ON true
      LEFT JOIN public."user" actor ON actor.id=r.requested_by
      LEFT JOIN collab.workspaces w ON w.id=r.workspace_id
      LEFT JOIN collab.repositories repo ON repo.id=w.repository_id
      LEFT JOIN collab.model_profiles model ON model.id=r.model_profile_id
      LEFT JOIN LATERAL (SELECT declaration FROM collab.work_intents WHERE run_id=r.id ORDER BY revision DESC LIMIT 1) intent ON true
      LEFT JOIN collab.task_results result ON result.id=t.current_result_id
      WHERE t.project_id=$1 ORDER BY t.created_at DESC,t.id
    ) SELECT COALESCE((SELECT jsonb_agg(nodes) FROM nodes),'[]'::jsonb) AS tasks,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('task_id',task_id,'depends_on',depends_on,'kind',kind) ORDER BY task_id,depends_on)
        FROM collab.task_dependencies WHERE project_id=$1),'[]'::jsonb) AS dependencies,
      statement_timestamp()::text AS "capturedAt"`, [projectId]);
    // Recheck authorization after the read, including revocation during a slow query.
    await projectRole(db, projectId, "project.read");
    return { ...rows[0], ...mapConflicts(rows[0].tasks) };
  });
}
