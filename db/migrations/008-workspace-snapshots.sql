CREATE TABLE collab.snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, project_id uuid NOT NULL, task_id uuid NOT NULL,
  run_id uuid NOT NULL, workspace_id uuid NOT NULL, requested_by text NOT NULL REFERENCES public."user"(id),
  idempotency_key uuid NOT NULL, payload jsonb NOT NULL, context jsonb NOT NULL,
  organization_version bigint NOT NULL, project_version bigint NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','failed','revoked')),
  manifest_hash text CHECK(manifest_hash ~ '^[a-f0-9]{64}$'), summary jsonb, error_code text,
  created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  UNIQUE(requested_by,run_id,idempotency_key), UNIQUE(organization_id,project_id,task_id,id),
  FOREIGN KEY(organization_id,project_id,run_id) REFERENCES collab.runs(organization_id,project_id,id),
  FOREIGN KEY(organization_id,project_id,task_id,workspace_id) REFERENCES collab.workspaces(organization_id,project_id,task_id,id)
);
CREATE UNIQUE INDEX snapshots_one_pending ON collab.snapshots(run_id) WHERE status='pending';
CREATE INDEX snapshots_task ON collab.snapshots(task_id,created_at DESC);
ALTER TABLE collab.snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY snapshots_read ON collab.snapshots FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
GRANT SELECT ON collab.snapshots TO pi_collab_app;
ALTER TABLE collab.workspaces ADD COLUMN source_snapshot_id uuid;
ALTER TABLE collab.workspaces ADD CONSTRAINT workspace_snapshot_scope FOREIGN KEY(organization_id,project_id,task_id,source_snapshot_id) REFERENCES collab.snapshots(organization_id,project_id,task_id,id);

CREATE FUNCTION collab.request_snapshot(run uuid, request_key uuid, expected_revision bigint, note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab.runs; t collab.tasks; w collab.workspaces; role text; previous collab.snapshots; request jsonb; snapshot uuid := gen_random_uuid(); org_version bigint; member_version bigint;
BEGIN
  SELECT * INTO r FROM collab.runs WHERE id=run;
  IF r.id IS NULL OR collab.project_role(r.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(r.organization_id::text,811));
  SELECT * INTO STRICT r FROM collab.runs WHERE id=run FOR UPDATE;
  SELECT * INTO STRICT t FROM collab.tasks WHERE id=r.task_id;
  role := collab.project_role(r.project_id);
  IF role IS NULL OR role NOT IN ('maintainer','developer') OR (role<>'maintainer' AND t.owner_id<>collab.actor()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
  IF collab.user_requires_mfa(collab.actor()) AND NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
  IF request_key IS NULL OR expected_revision IS NULL OR note IS NULL OR length(btrim(note)) NOT BETWEEN 1 AND 4000 THEN RAISE EXCEPTION 'invalid_snapshot' USING ERRCODE='P0001'; END IF;
  request := jsonb_build_object('expectedRevision',expected_revision::text,'note',btrim(note));
  SELECT * INTO previous FROM collab.snapshots WHERE run_id=run AND requested_by=collab.actor() AND idempotency_key=request_key;
  IF FOUND THEN
    IF previous.payload<>request THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
    RETURN jsonb_build_object('snapshotId',previous.id,'status',previous.status,'replayed',true);
  END IF;
  IF r.revision<>expected_revision THEN RAISE EXCEPTION 'stale_revision' USING ERRCODE='P0001'; END IF;
  SELECT * INTO STRICT w FROM collab.workspaces WHERE id=r.workspace_id;
  IF r.status NOT IN ('completed','failed','cancelled') OR w.status NOT IN ('stopped','archived') THEN RAISE EXCEPTION 'workspace_not_stopped' USING ERRCODE='P0001'; END IF;
  IF EXISTS(SELECT 1 FROM collab.snapshots WHERE run_id=run AND status='pending') THEN RAISE EXCEPTION 'snapshot_pending' USING ERRCODE='P0001'; END IF;
  SELECT authorization_version INTO org_version FROM collab.memberships WHERE organization_id=r.organization_id AND user_id=collab.actor();
  SELECT authorization_version INTO member_version FROM collab.project_memberships WHERE project_id=r.project_id AND user_id=collab.actor();
  INSERT INTO collab.snapshots(id,organization_id,project_id,task_id,run_id,workspace_id,requested_by,idempotency_key,payload,context,organization_version,project_version)
    VALUES(snapshot,r.organization_id,r.project_id,r.task_id,run,r.workspace_id,collab.actor(),request_key,request,
      jsonb_build_object('title',t.title,'description',t.description,'acceptance',t.acceptance,'prompt',r.prompt,'status',r.status),org_version,member_version);
  INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(r.organization_id,r.project_id,collab.actor(),'snapshot.requested',snapshot::text,jsonb_build_object('runId',run));
  PERFORM collab_worker.emit(run,'snapshot.requested',jsonb_build_object('snapshotId',snapshot));
  RETURN jsonb_build_object('snapshotId',snapshot,'status','pending','replayed',false);
END
$$;

CREATE FUNCTION collab_worker.pending_snapshots() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT COALESCE(jsonb_agg(item),'[]'::jsonb) FROM (
    SELECT jsonb_build_object('id',s.id,'runId',s.run_id,'workspaceId',s.workspace_id,'repositoryId',w.repository_id,'baseSha',w.base_sha,
      'note',s.payload->>'note','context',s.context,'executorId',r.executor_id,'epoch',r.epoch::text,'runtime',w.runtime,
      'parentSnapshot',(SELECT jsonb_build_object('id',parent.id,'manifestHash',parent.manifest_hash) FROM collab.snapshots parent WHERE parent.id=w.source_snapshot_id)) AS item
    FROM collab.snapshots s JOIN collab.runs r ON r.id=s.run_id JOIN collab.workspaces w ON w.id=s.workspace_id
    WHERE s.status='pending' ORDER BY s.created_at,s.id LIMIT 4
  ) requests
$$;
CREATE FUNCTION collab_worker.complete_snapshot(snapshot uuid, manifest_digest text, result jsonb, failure text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s collab.snapshots; r collab.runs; allowed boolean; outcome text;
BEGIN
  SELECT * INTO s FROM collab.snapshots WHERE id=snapshot;
  IF s.id IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(s.organization_id::text,811));
  SELECT * INTO STRICT r FROM collab.runs WHERE id=s.run_id FOR UPDATE;
  SELECT * INTO STRICT s FROM collab.snapshots WHERE id=snapshot FOR UPDATE;
  IF s.status<>'pending' THEN RETURN s.status; END IF;
  IF manifest_digest IS NOT NULL AND manifest_digest !~ '^[a-f0-9]{64}$' OR pg_column_size(result)>1048576 OR length(failure)>120 THEN RAISE EXCEPTION 'invalid_snapshot' USING ERRCODE='P0001'; END IF;
  SELECT EXISTS(SELECT 1 FROM collab.memberships m JOIN collab.project_memberships pm ON pm.organization_id=m.organization_id AND pm.user_id=m.user_id
    JOIN public."user" u ON u.id=m.user_id JOIN collab.tasks t ON t.id=s.task_id
    WHERE m.organization_id=s.organization_id AND m.user_id=s.requested_by AND m.active AND m.authorization_version=s.organization_version
      AND pm.project_id=s.project_id AND pm.active AND pm.authorization_version=s.project_version AND pm.role IN ('developer','maintainer')
      AND (pm.role='maintainer' OR t.owner_id=s.requested_by) AND (m.role='member' OR u."twoFactorEnabled")) INTO allowed;
  IF r.status NOT IN ('completed','failed','cancelled') OR NOT EXISTS(SELECT 1 FROM collab.workspaces WHERE id=s.workspace_id AND status IN ('stopped','archived')) THEN allowed := false; END IF;
  outcome := CASE WHEN NOT allowed THEN 'revoked' WHEN manifest_digest IS NOT NULL AND result IS NOT NULL AND failure IS NULL THEN 'ready' ELSE 'failed' END;
  UPDATE collab.snapshots SET status=outcome,manifest_hash=CASE WHEN outcome='ready' THEN manifest_digest END,summary=CASE WHEN outcome='ready' THEN result END,
    error_code=CASE WHEN outcome='revoked' THEN 'authorization_changed' WHEN outcome='failed' THEN COALESCE(failure,'snapshot_failed') END,finished_at=now() WHERE id=snapshot;
  INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(s.organization_id,s.project_id,s.requested_by,'snapshot.'||outcome,snapshot::text,jsonb_build_object('runId',s.run_id,'manifestHash',CASE WHEN outcome='ready' THEN manifest_digest END));
  PERFORM collab_worker.emit(s.run_id,'snapshot.'||outcome,jsonb_build_object('snapshotId',snapshot,'status',outcome));
  RETURN outcome;
END
$$;

CREATE FUNCTION collab.submit_run(task uuid, repository uuid, base text, message text, runtime_mode text, request_key uuid, expected_version integer, model_profile uuid, snapshot uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE accepted jsonb; r collab.runs; w collab.workspaces; source collab.snapshots;
BEGIN
  accepted := collab.submit_run(task,repository,base,message,runtime_mode,request_key,expected_version,model_profile);
  SELECT * INTO STRICT r FROM collab.runs WHERE id=(accepted->>'runId')::uuid;
  SELECT * INTO STRICT w FROM collab.workspaces WHERE id=r.workspace_id;
  IF (accepted->>'replayed')::boolean THEN
    IF w.source_snapshot_id IS DISTINCT FROM snapshot THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
  ELSIF snapshot IS NOT NULL THEN
    SELECT s.* INTO source FROM collab.snapshots s JOIN collab.workspaces origin ON origin.id=s.workspace_id
      WHERE s.id=snapshot AND s.task_id=task AND s.project_id=r.project_id AND s.status='ready' AND origin.repository_id=repository AND origin.base_sha=base;
    IF source.id IS NULL OR runtime_mode<>'native' THEN RAISE EXCEPTION 'snapshot_unavailable' USING ERRCODE='P0001'; END IF;
    UPDATE collab.workspaces SET source_snapshot_id=snapshot WHERE id=w.id;
    INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(r.organization_id,r.project_id,collab.actor(),'snapshot.restore_requested',snapshot::text,jsonb_build_object('runId',r.id,'manifestHash',source.manifest_hash));
  END IF;
  RETURN accepted;
END
$$;
CREATE FUNCTION collab_worker.restore_snapshot(executor uuid, run uuid, generation bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab.runs;
BEGIN
  r := collab_worker.assert_lease(executor,run,generation);
  IF NOT collab_worker.authorized(run) OR r.status<>'starting' THEN RAISE EXCEPTION 'run_not_executable' USING ERRCODE='P0001'; END IF;
  RETURN (SELECT jsonb_build_object('id',s.id,'manifestHash',s.manifest_hash) FROM collab.workspaces w JOIN collab.snapshots s ON s.id=w.source_snapshot_id WHERE w.id=r.workspace_id AND s.status='ready');
END
$$;
REVOKE EXECUTE ON FUNCTION collab.request_snapshot(uuid,uuid,bigint,text),collab_worker.pending_snapshots(),collab_worker.complete_snapshot(uuid,text,jsonb,text),collab.submit_run(uuid,uuid,text,text,text,uuid,integer,uuid,uuid),collab_worker.restore_snapshot(uuid,uuid,bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION collab.submit_run(uuid,uuid,text,text,text,uuid,integer,uuid) FROM pi_collab_app;
GRANT EXECUTE ON FUNCTION collab.request_snapshot(uuid,uuid,bigint,text),collab.submit_run(uuid,uuid,text,text,text,uuid,integer,uuid,uuid) TO pi_collab_app;
GRANT EXECUTE ON FUNCTION collab_worker.pending_snapshots(),collab_worker.complete_snapshot(uuid,text,jsonb,text),collab_worker.restore_snapshot(uuid,uuid,bigint) TO pi_collab_executor;

-- During rollout, older executors must never silently start snapshot jobs from
-- the repository base. Keep their existing entry point limited to fresh runs.
CREATE FUNCTION collab_worker.claim_compatible(executor uuid, runtime_mode text, snapshots_supported boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab.runs; w collab.workspaces;
BEGIN
  -- A short admission lock protects shared quota counters, never agent execution.
  PERFORM pg_advisory_xact_lock(82467104);
  FOR r IN SELECT * FROM collab.runs WHERE status='queued' AND NOT collab_worker.authorized(id) ORDER BY id FOR UPDATE SKIP LOCKED LOOP
    PERFORM collab_worker.request_stop(r.id,'authorization_revoked');
  END LOOP;
  SELECT candidate.* INTO r FROM collab.runs candidate JOIN collab.workspaces workspace ON workspace.id=candidate.workspace_id
  WHERE candidate.status='queued' AND workspace.runtime=runtime_mode AND (snapshots_supported OR workspace.source_snapshot_id IS NULL) AND collab_worker.authorized(candidate.id)
    AND NOT EXISTS(SELECT 1 FROM collab.task_dependencies d JOIN collab.tasks upstream ON upstream.id=d.depends_on WHERE d.task_id=candidate.task_id AND d.kind='strict' AND upstream.status<>'done')
    AND (SELECT count(*) FROM collab.runs a WHERE a.project_id=candidate.project_id AND a.status IN ('starting','running','waiting_input','stopping','reconciling'))<8
    AND (SELECT count(*) FROM collab.runs a WHERE a.requested_by=candidate.requested_by AND a.status IN ('starting','running','waiting_input','stopping','reconciling'))<2
  ORDER BY (SELECT count(*) FROM collab.runs a WHERE a.requested_by=candidate.requested_by AND a.status IN ('starting','running','waiting_input','stopping','reconciling')),candidate.created_at,candidate.id
  LIMIT 1 FOR UPDATE OF candidate SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE collab.workspaces SET epoch=epoch+1,lease_owner=executor,lease_expires_at=clock_timestamp()+interval '30 seconds',status='busy' WHERE id=r.workspace_id RETURNING * INTO w;
  UPDATE collab.runs SET status='starting',executor_id=executor,epoch=w.epoch,revision=revision+1,started_at=now() WHERE id=r.id RETURNING * INTO r;
  UPDATE collab.commands SET status='dispatched',updated_at=now() WHERE run_id=r.id AND kind='start';
  PERFORM collab_worker.emit(r.id,'run.starting',jsonb_build_object('epoch',w.epoch));
  RETURN jsonb_build_object('run',to_jsonb(r)||jsonb_build_object('epoch',r.epoch::text),'workspace',to_jsonb(w)||jsonb_build_object('epoch',w.epoch::text));
END
$$;
CREATE OR REPLACE FUNCTION collab_worker.claim(executor uuid, runtime_mode text) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT collab_worker.claim_compatible(executor,runtime_mode,false)
$$;
CREATE FUNCTION collab_worker.claim_snapshot_aware(executor uuid, runtime_mode text) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT collab_worker.claim_compatible(executor,runtime_mode,true)
$$;
REVOKE EXECUTE ON FUNCTION collab_worker.claim_compatible(uuid,text,boolean),collab_worker.claim_snapshot_aware(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab_worker.claim_snapshot_aware(uuid,text) TO pi_collab_executor;
