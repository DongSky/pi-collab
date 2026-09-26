-- Recovery observes stopped writers; it never changes unknown tool outcomes to success.
ALTER TABLE collab.workspaces ADD COLUMN archived_at timestamptz;
ALTER TABLE collab.workspaces ADD COLUMN retain_until timestamptz;
CREATE TABLE collab.run_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, project_id uuid NOT NULL, run_id uuid NOT NULL,
  requested_by text NOT NULL REFERENCES public."user"(id), idempotency_key uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('recover','archive')), payload jsonb NOT NULL,
  organization_version bigint NOT NULL, project_version bigint NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','blocked','resolved','revoked')),
  result_code text, receipt_hash text CHECK(receipt_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  UNIQUE(requested_by,run_id,idempotency_key),
  FOREIGN KEY(organization_id,project_id,run_id) REFERENCES collab.runs(organization_id,project_id,id)
);
CREATE UNIQUE INDEX run_actions_one_pending ON collab.run_actions(run_id) WHERE status='pending';
ALTER TABLE collab.run_actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY run_actions_read ON collab.run_actions FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
GRANT SELECT ON collab.run_actions TO pi_collab_app;

CREATE FUNCTION collab.manage_run(run uuid, action text, request_key uuid, expected_revision bigint, reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab.runs; w collab.workspaces; p collab.projects; previous collab.run_actions; request jsonb; action_id uuid := gen_random_uuid(); org_version bigint; member_version bigint;
BEGIN
  SELECT * INTO r FROM collab.runs WHERE id=run;
  IF r.id IS NULL OR collab.project_role(r.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
  -- Organization authority is serialized before run/workspace/task locks.
  p := collab.require_project_management(r.project_id);
  SELECT * INTO STRICT r FROM collab.runs WHERE id=run FOR UPDATE;
  IF action IS NULL OR action NOT IN ('recover','archive') OR reason IS NULL OR length(btrim(reason)) NOT BETWEEN 10 AND 2000 OR expected_revision IS NULL OR request_key IS NULL THEN RAISE EXCEPTION 'invalid_run_action' USING ERRCODE='P0001'; END IF;
  request := jsonb_build_object('expectedRevision',expected_revision::text,'reason',btrim(reason));
  SELECT * INTO previous FROM collab.run_actions WHERE requested_by=collab.actor() AND run_id=run AND idempotency_key=request_key;
  IF FOUND THEN
    IF previous.kind<>action OR previous.payload<>request THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
    RETURN jsonb_build_object('actionId',previous.id,'runId',run,'status',previous.status,'replayed',true);
  END IF;
  IF r.revision<>expected_revision THEN RAISE EXCEPTION 'stale_revision' USING ERRCODE='P0001'; END IF;
  IF EXISTS(SELECT 1 FROM collab.run_actions WHERE run_id=run AND status='pending') THEN RAISE EXCEPTION 'recovery_pending' USING ERRCODE='P0001'; END IF;
  SELECT * INTO STRICT w FROM collab.workspaces WHERE id=r.workspace_id FOR UPDATE;
  IF action='recover' AND (r.status<>'reconciling' OR w.status<>'quarantined') THEN RAISE EXCEPTION 'run_not_reconciling' USING ERRCODE='P0001'; END IF;
  IF action='archive' AND (r.status NOT IN ('completed','failed','cancelled') OR w.status NOT IN ('stopped','archived')) THEN RAISE EXCEPTION 'workspace_not_stopped' USING ERRCODE='P0001'; END IF;
  SELECT authorization_version INTO org_version FROM collab.memberships WHERE organization_id=r.organization_id AND user_id=collab.actor();
  SELECT authorization_version INTO member_version FROM collab.project_memberships WHERE project_id=r.project_id AND user_id=collab.actor();
  INSERT INTO collab.run_actions(id,organization_id,project_id,run_id,requested_by,idempotency_key,kind,payload,organization_version,project_version,status,result_code,finished_at)
    VALUES(action_id,r.organization_id,r.project_id,run,collab.actor(),request_key,action,request,org_version,member_version,
      CASE WHEN action='archive' THEN 'resolved' ELSE 'pending' END,CASE WHEN action='archive' THEN 'archived' END,CASE WHEN action='archive' THEN now() END);
  IF action='archive' THEN
    -- Logical archive only. No directory, branch, evidence or referenced artifact is deleted.
    UPDATE collab.workspaces SET status='archived',archived_at=COALESCE(archived_at,now()),retain_until=COALESCE(retain_until,now()+interval '7 days') WHERE id=w.id;
    UPDATE collab.runs SET revision=revision+1 WHERE id=run;
  END IF;
  INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail)
    VALUES(r.organization_id,r.project_id,collab.actor(),CASE WHEN action='archive' THEN 'workspace.archived' ELSE 'run.recovery_requested' END,run::text,jsonb_build_object('actionId',action_id,'reason',btrim(reason)));
  PERFORM collab_worker.emit(run,CASE WHEN action='archive' THEN 'workspace.archived' ELSE 'run.recovery_requested' END,jsonb_build_object('actionId',action_id));
  RETURN jsonb_build_object('actionId',action_id,'runId',run,'status',CASE WHEN action='archive' THEN 'resolved' ELSE 'pending' END,'replayed',false);
END
$$;

CREATE FUNCTION collab_worker.pending_recoveries() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT COALESCE(jsonb_agg(item),'[]'::jsonb) FROM (
    SELECT jsonb_build_object('actionId',a.id,'runId',r.id,'workspaceId',w.id,'executorId',r.executor_id,'epoch',r.epoch::text,'runtime',w.runtime) AS item
    FROM collab.run_actions a JOIN collab.runs r ON r.id=a.run_id JOIN collab.workspaces w ON w.id=r.workspace_id
    WHERE a.status='pending' AND a.kind='recover' ORDER BY a.created_at,a.id LIMIT 32
  ) requests
$$;

CREATE FUNCTION collab_worker.resolve_recovery(action_id uuid, evidence_code text, evidence_hash text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a collab.run_actions; r collab.runs; resolved boolean; authorized boolean; result text;
BEGIN
  SELECT * INTO a FROM collab.run_actions WHERE id=action_id;
  IF a.id IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(a.organization_id::text,811));
  SELECT * INTO STRICT r FROM collab.runs WHERE id=a.run_id FOR UPDATE;
  SELECT * INTO STRICT a FROM collab.run_actions WHERE id=action_id FOR UPDATE;
  IF a.status<>'pending' THEN RETURN a.status; END IF;
  IF a.kind<>'recover' OR r.status<>'reconciling' THEN RAISE EXCEPTION 'run_not_reconciling' USING ERRCODE='P0001'; END IF;
  IF evidence_code IS NULL OR evidence_code NOT IN ('stop_confirmed','group_absent','writer_present','receipt_missing','receipt_invalid','launch_uncertain','boot_changed','inspection_unavailable','unsupported_runtime')
    OR (evidence_hash IS NOT NULL AND evidence_hash !~ '^[a-f0-9]{64}$') THEN RAISE EXCEPTION 'invalid_recovery_evidence' USING ERRCODE='P0001'; END IF;
  resolved := evidence_code IN ('stop_confirmed','group_absent');
  IF resolved AND evidence_hash IS NULL THEN RAISE EXCEPTION 'invalid_recovery_evidence' USING ERRCODE='P0001'; END IF;
  SELECT EXISTS(SELECT 1 FROM collab.memberships m JOIN collab.project_memberships pm ON pm.organization_id=m.organization_id AND pm.user_id=m.user_id
    JOIN public."user" u ON u.id=m.user_id WHERE m.organization_id=a.organization_id AND m.user_id=a.requested_by AND m.active AND m.authorization_version=a.organization_version
    AND pm.project_id=a.project_id AND pm.active AND pm.role='maintainer' AND pm.authorization_version=a.project_version AND (m.role='member' OR u."twoFactorEnabled")) INTO authorized;
  result := CASE WHEN NOT authorized THEN 'revoked' WHEN resolved THEN 'resolved' ELSE 'blocked' END;
  UPDATE collab.run_actions SET status=result,result_code=CASE WHEN authorized THEN evidence_code ELSE 'authorization_changed' END,receipt_hash=evidence_hash,finished_at=now() WHERE id=action_id;
  IF result='resolved' THEN
    UPDATE collab.runs SET status='cancelled',stop_reason='reconciled_without_replay',revision=revision+1,finished_at=now(),
      summary=COALESCE(summary,'{}'::jsonb)||jsonb_build_object('recovery',jsonb_build_object('actionId',action_id,'evidence',evidence_code,'externalEffects','unknown','replayed',false)) WHERE id=r.id;
    UPDATE collab.workspaces SET status='stopped',epoch=epoch+1,lease_owner=NULL,lease_expires_at=NULL WHERE id=r.workspace_id AND status='quarantined';
    -- Preserve unknown start/stop commands: process absence says nothing about external effects.
    UPDATE collab.tasks SET status='draft',version=version+1,updated_at=now() WHERE id=r.task_id AND status NOT IN ('done','cancelled');
  END IF;
  INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail)
    VALUES(r.organization_id,r.project_id,a.requested_by,'run.recovery_'||result,r.id::text,jsonb_build_object('actionId',action_id,'evidence',CASE WHEN authorized THEN evidence_code ELSE 'authorization_changed' END,'receiptHash',evidence_hash));
  PERFORM collab_worker.emit(r.id,'run.recovery_'||result,jsonb_build_object('actionId',action_id,'status',result));
  RETURN result;
END
$$;
REVOKE EXECUTE ON FUNCTION collab.manage_run(uuid,text,uuid,bigint,text),collab_worker.pending_recoveries(),collab_worker.resolve_recovery(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.manage_run(uuid,text,uuid,bigint,text) TO pi_collab_app;
GRANT EXECUTE ON FUNCTION collab_worker.pending_recoveries(),collab_worker.resolve_recovery(uuid,text,text) TO pi_collab_executor;
