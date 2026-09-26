-- Runtime and logical workspace storage budgets. Measurements never grant write authority.
CREATE TABLE collab_worker.runtime_policies (
 project_id uuid PRIMARY KEY REFERENCES collab.projects(id), version integer NOT NULL,
 ai_seconds integer NOT NULL CHECK(ai_seconds BETWEEN 1 AND 86400),
 terminal_seconds integer NOT NULL CHECK(terminal_seconds BETWEEN 1 AND 86400),
 workspace_bytes bigint NOT NULL CHECK(workspace_bytes BETWEEN 1048576 AND 1099511627776),
 member_bytes bigint NOT NULL, project_bytes bigint NOT NULL,
 CHECK(member_bytes>=workspace_bytes AND project_bytes>=member_bytes AND project_bytes<=10995116277760)
);
CREATE TABLE collab_worker.runtime_policy_operations (
 project_id uuid NOT NULL, actor_id text NOT NULL, request_key uuid NOT NULL, payload jsonb NOT NULL, result jsonb NOT NULL,
 PRIMARY KEY(project_id,actor_id,request_key)
);
CREATE TABLE collab_worker.run_execution_limits (
 run_id uuid PRIMARY KEY REFERENCES collab.runs(id), policy_version integer NOT NULL, timeout_seconds integer NOT NULL, workspace_bytes bigint NOT NULL
);
CREATE TABLE collab_worker.workspace_usage (
 workspace_id uuid PRIMARY KEY REFERENCES collab.workspaces(id), epoch bigint NOT NULL, bytes bigint CHECK(bytes>=0), error_code text, measured_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION collab_worker.runtime_policy(project uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('version',coalesce(p.version,0),'aiSeconds',coalesce(p.ai_seconds,1800),'terminalSeconds',coalesce(p.terminal_seconds,14400),
 'workspaceBytes',coalesce(p.workspace_bytes,2147483648),'memberBytes',coalesce(p.member_bytes,21474836480),'projectBytes',coalesce(p.project_bytes,107374182400))
 FROM (SELECT 1) seed LEFT JOIN collab_worker.runtime_policies p ON p.project_id=project
$$;
CREATE FUNCTION collab_worker.workspace_charge(workspace uuid) RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT CASE WHEN r.started_at IS NULL THEN 0 WHEN r.status IN ('starting','running','waiting_input','stopping','reconciling') OR u.error_code IS NOT NULL
 THEN greatest(coalesce(u.bytes,0),coalesce(l.workspace_bytes,2147483648)) ELSE coalesce(u.bytes,l.workspace_bytes,2147483648) END
 FROM collab.workspaces w JOIN collab.runs r ON r.workspace_id=w.id LEFT JOIN collab_worker.run_execution_limits l ON l.run_id=r.id LEFT JOIN collab_worker.workspace_usage u ON u.workspace_id=w.id WHERE w.id=workspace
$$;
CREATE FUNCTION collab_worker.storage_available(project uuid,person text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT NOT EXISTS(SELECT 1 FROM collab.workspaces blocked JOIN collab_worker.workspace_usage unknown_usage ON unknown_usage.workspace_id=blocked.id WHERE blocked.project_id=project AND unknown_usage.error_code IS NOT NULL) AND (p->>'workspaceBytes')::bigint+coalesce(sum(collab_worker.workspace_charge(w.id)),0)<=(p->>'projectBytes')::bigint
 AND (p->>'workspaceBytes')::bigint+coalesce(sum(collab_worker.workspace_charge(w.id)) FILTER(WHERE w.created_by=person),0)<=(p->>'memberBytes')::bigint
 FROM (SELECT collab_worker.runtime_policy(project) p) settings LEFT JOIN collab.workspaces w ON w.project_id=project GROUP BY p
$$;
ALTER FUNCTION collab_worker.capacity_available(uuid,text) RENAME TO capacity_available_v41;
CREATE FUNCTION collab_worker.capacity_available(project uuid,person text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT collab_worker.capacity_available_v41(project,person) AND collab_worker.storage_available(project,person)
$$;
CREATE FUNCTION collab.configure_runtime_policy(project uuid,input jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE org uuid; old collab_worker.runtime_policy_operations; policy jsonb; v integer; result jsonb;
BEGIN
 SELECT organization_id INTO org FROM collab.projects WHERE id=project;
 IF org IS NULL OR collab.project_role(project) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(org::text,811));
 IF collab.project_role(project) IS DISTINCT FROM 'maintainer' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001';END IF;
 IF NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001';END IF;
 SELECT * INTO old FROM collab_worker.runtime_policy_operations WHERE project_id=project AND actor_id=collab.actor() AND request_key=(input->>'idempotencyKey')::uuid;
 IF FOUND THEN IF old.payload IS DISTINCT FROM input THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001';END IF;RETURN old.result;END IF;
 policy:=collab_worker.runtime_policy(project);v:=(policy->>'version')::integer;
 IF v IS DISTINCT FROM (input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'stale_revision' USING ERRCODE='P0001';END IF;
 IF length(btrim(input->>'reason')) NOT BETWEEN 10 AND 2000 OR input->>'reason' IS NULL THEN RAISE EXCEPTION 'invalid_capacity' USING ERRCODE='P0001';END IF;
 INSERT INTO collab_worker.runtime_policies VALUES(project,v+1,(input->>'aiSeconds')::integer,(input->>'terminalSeconds')::integer,(input->>'workspaceBytes')::bigint,(input->>'memberBytes')::bigint,(input->>'projectBytes')::bigint)
 ON CONFLICT(project_id) DO UPDATE SET version=excluded.version,ai_seconds=excluded.ai_seconds,terminal_seconds=excluded.terminal_seconds,workspace_bytes=excluded.workspace_bytes,member_bytes=excluded.member_bytes,project_bytes=excluded.project_bytes;
 result:=jsonb_build_object('version',v+1);
 INSERT INTO collab_worker.runtime_policy_operations VALUES(project,collab.actor(),(input->>'idempotencyKey')::uuid,input,result);
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(org,project,collab.actor(),'runtime_policy.configured',project::text,input-'idempotencyKey');
 RETURN result;
END $$;
CREATE FUNCTION collab.runtime_policy_context(project uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF collab.project_role(project) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 RETURN collab_worker.runtime_policy(project)||jsonb_build_object('canManage',collab.project_role(project)='maintainer','storageAvailable',collab_worker.storage_available(project,collab.actor()),
 'chargedBytes',(SELECT coalesce(sum(collab_worker.workspace_charge(id)),0)::text FROM collab.workspaces WHERE project_id=project),
 'workspaces',(SELECT coalesce(jsonb_agg(row ORDER BY row.created_at DESC),'[]'::jsonb) FROM (
 SELECT w.id,t.title,u.name AS owner_name,w.status,w.created_at,usage.bytes::text,usage.measured_at,usage.error_code,collab_worker.workspace_charge(w.id)::text AS charged_bytes,l.timeout_seconds,l.workspace_bytes::text AS workspace_bytes
 FROM collab.workspaces w JOIN collab.tasks t ON t.id=w.task_id JOIN public."user" u ON u.id=w.created_by JOIN collab.runs r ON r.workspace_id=w.id LEFT JOIN collab_worker.run_execution_limits l ON l.run_id=r.id LEFT JOIN collab_worker.workspace_usage usage ON usage.workspace_id=w.id WHERE w.project_id=project ORDER BY w.created_at DESC LIMIT 100) row));
END $$;
DO $$
DECLARE previous text;updated text;
BEGIN
 SELECT pg_get_functiondef('collab_worker.claim_with_resolutions(uuid,text,boolean,boolean,boolean,boolean)'::regprocedure) INTO previous;
 updated:=replace(previous,'UPDATE collab.workspaces SET epoch=epoch+1',
 'INSERT INTO collab_worker.run_execution_limits(run_id,policy_version,timeout_seconds,workspace_bytes) SELECT r.id,(p->>''version'')::integer,(p->>CASE WHEN r.execution_kind=''terminal'' THEN ''terminalSeconds'' ELSE ''aiSeconds'' END)::integer,(p->>''workspaceBytes'')::bigint FROM (SELECT collab_worker.runtime_policy(r.project_id) p) fixed;
  UPDATE collab.workspaces SET epoch=epoch+1');
 updated:=replace(updated,'''resolution'',collab_worker.resolution_input(r.id)',
 '''resolution'',collab_worker.resolution_input(r.id),''limits'',(SELECT jsonb_build_object(''timeoutSeconds'',timeout_seconds,''workspaceBytes'',workspace_bytes,''policyVersion'',policy_version) FROM collab_worker.run_execution_limits WHERE run_id=r.id)');
 IF updated=previous THEN RAISE EXCEPTION 'Missing runtime limits claim boundary';END IF;EXECUTE updated;
END $$;
CREATE FUNCTION collab_worker.record_workspace_usage(workspace uuid,generation bigint,measured bigint,failure text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE w collab.workspaces;
BEGIN
 SELECT * INTO w FROM collab.workspaces WHERE id=workspace;
 IF w.id IS NULL OR w.epoch<>generation THEN RAISE EXCEPTION 'workspace_usage_stale' USING ERRCODE='P0001';END IF;
 IF measured<0 OR (failure IS NOT NULL AND failure NOT IN ('scan_limit','unavailable')) OR (failure IS NULL AND measured IS NULL) THEN RAISE EXCEPTION 'invalid_capacity' USING ERRCODE='P0001';END IF;
 INSERT INTO collab_worker.workspace_usage(workspace_id,epoch,bytes,error_code) VALUES(workspace,generation,measured,failure)
 ON CONFLICT(workspace_id) DO UPDATE SET epoch=excluded.epoch,bytes=CASE WHEN excluded.error_code IS NULL THEN excluded.bytes ELSE greatest(workspace_usage.bytes,excluded.bytes) END,error_code=excluded.error_code,measured_at=clock_timestamp();
END $$;
CREATE FUNCTION collab_worker.storage_scan_candidates(runtime_mode text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT coalesce(jsonb_agg(row),'[]'::jsonb) FROM (SELECT w.id,w.epoch::text FROM collab.workspaces w JOIN collab.runs r ON r.workspace_id=w.id LEFT JOIN collab_worker.workspace_usage u ON u.workspace_id=w.id
 WHERE w.runtime=runtime_mode AND w.status IN ('stopped','archived') AND r.started_at IS NOT NULL AND (u.measured_at IS NULL OR u.measured_at<clock_timestamp()-interval '10 minutes') ORDER BY u.measured_at NULLS FIRST,w.id LIMIT 2) row
$$;
REVOKE ALL ON ALL TABLES IN SCHEMA collab_worker FROM PUBLIC;
REVOKE ALL ON FUNCTION collab_worker.runtime_policy(uuid),collab_worker.workspace_charge(uuid),collab_worker.storage_available(uuid,text),collab_worker.capacity_available_v41(uuid,text),collab_worker.capacity_available(uuid,text),collab.configure_runtime_policy(uuid,jsonb),collab.runtime_policy_context(uuid),collab_worker.record_workspace_usage(uuid,bigint,bigint,text),collab_worker.storage_scan_candidates(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.configure_runtime_policy(uuid,jsonb),collab.runtime_policy_context(uuid) TO pi_collab_app;
GRANT EXECUTE ON FUNCTION collab_worker.record_workspace_usage(uuid,bigint,bigint,text),collab_worker.storage_scan_candidates(text) TO pi_collab_executor;
