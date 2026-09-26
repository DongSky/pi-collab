ALTER TABLE collab.tasks ADD COLUMN dependency_version bigint NOT NULL DEFAULT 1;
ALTER TABLE collab.tasks ADD COLUMN current_result_id uuid;
ALTER TABLE collab.runs ADD COLUMN dependency_protocol boolean NOT NULL DEFAULT false;
ALTER TABLE collab.runs ADD COLUMN dependency_version bigint;

CREATE TABLE collab.task_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, project_id uuid NOT NULL, task_id uuid NOT NULL,
  source_run_id uuid NOT NULL, snapshot_id uuid NOT NULL, validation_id uuid NOT NULL, version integer NOT NULL,
  manifest_hash text NOT NULL CHECK(manifest_hash ~ '^[a-f0-9]{64}$'), worktree_commit text NOT NULL CHECK(worktree_commit ~ '^[a-f0-9]{40}$'),
  published_by text NOT NULL REFERENCES public."user"(id), idempotency_key uuid NOT NULL, payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,project_id,task_id,id), UNIQUE(task_id,version), UNIQUE(published_by,task_id,idempotency_key),
  FOREIGN KEY(organization_id,project_id,task_id,snapshot_id) REFERENCES collab.snapshots(organization_id,project_id,task_id,id),
  FOREIGN KEY(organization_id,project_id,task_id,validation_id) REFERENCES collab.validations(organization_id,project_id,task_id,id),
  FOREIGN KEY(organization_id,project_id,source_run_id) REFERENCES collab.runs(organization_id,project_id,id)
);
ALTER TABLE collab.tasks ADD CONSTRAINT task_current_result_scope FOREIGN KEY(organization_id,project_id,id,current_result_id) REFERENCES collab.task_results(organization_id,project_id,task_id,id);
CREATE TABLE collab.result_withdrawals (
  result_id uuid PRIMARY KEY REFERENCES collab.task_results(id), organization_id uuid NOT NULL, project_id uuid NOT NULL, task_id uuid NOT NULL,
  withdrawn_by text NOT NULL REFERENCES public."user"(id), reason text NOT NULL CHECK(length(reason) BETWEEN 10 AND 2000), created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(organization_id,project_id,task_id,result_id) REFERENCES collab.task_results(organization_id,project_id,task_id,id)
);
CREATE TABLE collab.run_dependencies (
  organization_id uuid NOT NULL, project_id uuid NOT NULL, run_id uuid NOT NULL, depends_on uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('strict','soft')), result_id uuid,
  PRIMARY KEY(run_id,depends_on),
  FOREIGN KEY(organization_id,project_id,run_id) REFERENCES collab.runs(organization_id,project_id,id),
  FOREIGN KEY(organization_id,project_id,depends_on) REFERENCES collab.tasks(organization_id,project_id,id),
  FOREIGN KEY(organization_id,project_id,depends_on,result_id) REFERENCES collab.task_results(organization_id,project_id,task_id,id)
);
CREATE INDEX run_dependencies_result ON collab.run_dependencies(result_id);
ALTER TABLE collab.task_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE collab.result_withdrawals ENABLE ROW LEVEL SECURITY;
ALTER TABLE collab.run_dependencies ENABLE ROW LEVEL SECURITY;
CREATE POLICY task_results_read ON collab.task_results FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
CREATE POLICY result_withdrawals_read ON collab.result_withdrawals FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
CREATE POLICY run_dependencies_read ON collab.run_dependencies FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
GRANT SELECT ON collab.task_results,collab.result_withdrawals,collab.run_dependencies TO pi_collab_app;
REVOKE INSERT,DELETE ON collab.task_dependencies FROM pi_collab_app;
REVOKE UPDATE ON collab.tasks FROM pi_collab_app;
GRANT UPDATE(title,description,acceptance,status,version,updated_at) ON collab.tasks TO pi_collab_app;

CREATE FUNCTION collab.add_task_dependency(task uuid, upstream uuid, dependency_kind text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t collab.tasks; role text;
BEGIN
  SELECT * INTO t FROM collab.tasks WHERE id=task;
  IF t.id IS NULL OR collab.project_role(t.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(t.organization_id::text,811));
  PERFORM pg_advisory_xact_lock(hashtextextended(t.project_id::text,0));
  SELECT * INTO STRICT t FROM collab.tasks WHERE id=task FOR UPDATE;
  role := collab.project_role(t.project_id);
  IF role IS NULL OR role NOT IN ('maintainer','developer') OR (role<>'maintainer' AND t.owner_id<>collab.actor()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
  IF dependency_kind IS NULL OR dependency_kind NOT IN ('strict','soft') THEN RAISE EXCEPTION 'invalid_dependency' USING ERRCODE='P0001'; END IF;
  IF NOT EXISTS(SELECT 1 FROM collab.tasks WHERE id=upstream AND project_id=t.project_id) THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
  IF EXISTS(WITH RECURSIVE reachable(id) AS (SELECT upstream UNION SELECT d.depends_on FROM collab.task_dependencies d JOIN reachable r ON d.task_id=r.id) SELECT 1 FROM reachable WHERE id=task) THEN RAISE EXCEPTION 'dependency_cycle' USING ERRCODE='P0001'; END IF;
  IF (SELECT count(*) FROM collab.task_dependencies WHERE task_id=task)>=32 THEN RAISE EXCEPTION 'dependency_limit' USING ERRCODE='P0001'; END IF;
  INSERT INTO collab.task_dependencies(organization_id,project_id,task_id,depends_on,kind) VALUES(t.organization_id,t.project_id,task,upstream,dependency_kind);
  UPDATE collab.tasks SET dependency_version=dependency_version+1,version=version+1,updated_at=now() WHERE id=task;
  INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(t.organization_id,t.project_id,collab.actor(),'task.dependency_added',task::text,jsonb_build_object('dependsOn',upstream,'kind',dependency_kind));
  RETURN jsonb_build_object('success',true);
END
$$;

CREATE FUNCTION collab_worker.dependency_pins(run uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('taskId',d.depends_on,'kind',d.kind,'resultId',r.id,'snapshotId',r.snapshot_id,'manifestHash',r.manifest_hash,'worktreeCommit',r.worktree_commit) ORDER BY d.depends_on),'[]'::jsonb)
  FROM collab.run_dependencies d LEFT JOIN collab.task_results r ON r.id=d.result_id WHERE d.run_id=run
$$;
CREATE FUNCTION collab_worker.dependencies_current(run uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  WITH RECURSIVE lineage(id) AS (
    SELECT run UNION SELECT result.source_run_id FROM lineage l JOIN collab.run_dependencies d ON d.run_id=l.id JOIN collab.task_results result ON result.id=d.result_id
  ) SELECT NOT EXISTS(SELECT 1 FROM lineage l JOIN collab.runs r ON r.id=l.id JOIN collab.tasks t ON t.id=r.task_id
    WHERE NOT r.dependency_protocol OR r.dependency_version IS DISTINCT FROM t.dependency_version
      OR EXISTS(SELECT 1 FROM collab.run_dependencies d JOIN collab.tasks upstream ON upstream.id=d.depends_on
        WHERE d.run_id=r.id AND (d.result_id IS NULL OR d.result_id IS DISTINCT FROM upstream.current_result_id OR EXISTS(SELECT 1 FROM collab.result_withdrawals WHERE result_id=d.result_id))))
$$;
CREATE FUNCTION collab.run_dependency_state(run uuid) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab.runs;
BEGIN
  SELECT * INTO r FROM collab.runs WHERE id=run;
  IF r.id IS NULL OR collab.project_role(r.project_id) IS NULL THEN RETURN NULL; END IF;
  IF NOT r.dependency_protocol THEN RETURN 'untracked'; END IF;
  IF r.status='queued' AND EXISTS(SELECT 1 FROM collab.run_dependencies WHERE run_id=run AND kind='strict' AND result_id IS NULL) THEN RETURN 'waiting'; END IF;
  RETURN CASE WHEN collab_worker.dependencies_current(run) THEN 'current' ELSE 'needs_revalidation' END;
END
$$;

-- Freeze graph and available versions on admission. Only missing strict inputs
-- may be filled on dispatch; soft missing inputs remain explicit placeholders.
ALTER FUNCTION collab.submit_run(uuid,uuid,text,text,text,uuid,integer,uuid,uuid) RENAME TO submit_run_snapshot_v1;
REVOKE EXECUTE ON FUNCTION collab.submit_run_snapshot_v1(uuid,uuid,text,text,text,uuid,integer,uuid,uuid) FROM pi_collab_app;
CREATE FUNCTION collab.submit_run(task uuid, repository uuid, base text, message text, runtime_mode text, request_key uuid, expected_version integer, model_profile uuid, snapshot uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE accepted jsonb; r collab.runs;
BEGIN
  accepted := collab.submit_run_snapshot_v1(task,repository,base,message,runtime_mode,request_key,expected_version,model_profile,snapshot);
  IF NOT (accepted->>'replayed')::boolean THEN
    SELECT * INTO STRICT r FROM collab.runs WHERE id=(accepted->>'runId')::uuid;
    IF runtime_mode<>'native' AND EXISTS(SELECT 1 FROM collab.task_dependencies WHERE task_id=task) THEN RAISE EXCEPTION 'dependency_runtime_unsupported' USING ERRCODE='P0001'; END IF;
    UPDATE collab.runs SET dependency_protocol=true,dependency_version=(SELECT dependency_version FROM collab.tasks WHERE id=task) WHERE id=r.id;
    INSERT INTO collab.run_dependencies(organization_id,project_id,run_id,depends_on,kind,result_id)
      SELECT r.organization_id,r.project_id,r.id,d.depends_on,d.kind,result.id FROM collab.task_dependencies d JOIN collab.tasks upstream ON upstream.id=d.depends_on
      LEFT JOIN collab.task_results result ON result.id=upstream.current_result_id AND NOT EXISTS(SELECT 1 FROM collab.result_withdrawals WHERE result_id=result.id) AND collab_worker.dependencies_current(result.source_run_id)
      WHERE d.task_id=task;
  END IF;
  RETURN accepted;
END
$$;

CREATE FUNCTION collab.publish_task_result(task uuid, validation uuid, expected_version integer, request_key uuid, note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t collab.tasks; v collab.validations; s collab.snapshots; role text; previous collab.task_results; result uuid:=gen_random_uuid(); ordinal integer; request jsonb;
BEGIN
  SELECT * INTO t FROM collab.tasks WHERE id=task;
  IF t.id IS NULL OR collab.project_role(t.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(t.organization_id::text,811));
  SELECT * INTO STRICT t FROM collab.tasks WHERE id=task FOR UPDATE;
  role := collab.project_role(t.project_id);
  IF role IS NULL OR role NOT IN ('maintainer','developer') OR (role<>'maintainer' AND t.owner_id<>collab.actor()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
  IF collab.user_requires_mfa(collab.actor()) AND NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
  IF request_key IS NULL OR expected_version IS NULL OR validation IS NULL OR note IS NULL OR length(btrim(note)) NOT BETWEEN 1 AND 4000 THEN RAISE EXCEPTION 'invalid_task_result' USING ERRCODE='P0001'; END IF;
  request := jsonb_build_object('validationId',validation,'expectedVersion',expected_version,'note',btrim(note));
  SELECT * INTO previous FROM collab.task_results WHERE task_id=task AND published_by=collab.actor() AND idempotency_key=request_key;
  IF FOUND THEN
    IF previous.payload<>request THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
    RETURN jsonb_build_object('resultId',previous.id,'version',previous.version,'replayed',true);
  END IF;
  IF t.version<>expected_version THEN RAISE EXCEPTION 'stale_revision' USING ERRCODE='P0001'; END IF;
  SELECT * INTO v FROM collab.validations WHERE id=validation AND task_id=task AND status='passed';
  SELECT * INTO s FROM collab.snapshots WHERE id=v.snapshot_id AND status='ready';
  IF v.id IS NULL OR s.id IS NULL OR v.manifest_hash IS DISTINCT FROM s.manifest_hash OR NOT collab_worker.dependencies_current(s.run_id)
    OR v.evidence->'dependencies' IS DISTINCT FROM collab_worker.dependency_pins(s.run_id) THEN RAISE EXCEPTION 'result_validation_unavailable' USING ERRCODE='P0001'; END IF;
  SELECT COALESCE(max(version),0)+1 INTO ordinal FROM collab.task_results WHERE task_id=task;
  INSERT INTO collab.task_results(id,organization_id,project_id,task_id,source_run_id,snapshot_id,validation_id,version,manifest_hash,worktree_commit,published_by,idempotency_key,payload)
    VALUES(result,t.organization_id,t.project_id,task,s.run_id,s.id,v.id,ordinal,s.manifest_hash,v.evidence->>'worktreeCommit',collab.actor(),request_key,request);
  UPDATE collab.tasks SET current_result_id=result,version=version+1,updated_at=now() WHERE id=task;
  INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(t.organization_id,t.project_id,collab.actor(),'task.result_published',result::text,jsonb_build_object('taskId',task,'version',ordinal,'validationId',validation));
  RETURN jsonb_build_object('resultId',result,'version',ordinal,'replayed',false);
END
$$;

CREATE FUNCTION collab.withdraw_task_result(result uuid, reason text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab.task_results; t collab.tasks; role text;
BEGIN
  SELECT * INTO r FROM collab.task_results WHERE id=result;
  IF r.id IS NULL OR collab.project_role(r.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(r.organization_id::text,811));
  SELECT * INTO STRICT t FROM collab.tasks WHERE id=r.task_id FOR UPDATE;
  role := collab.project_role(r.project_id);
  IF role IS NULL OR role NOT IN ('maintainer','developer') OR (role<>'maintainer' AND t.owner_id<>collab.actor()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
  IF collab.user_requires_mfa(collab.actor()) AND NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
  IF reason IS NULL OR length(btrim(reason)) NOT BETWEEN 10 AND 2000 THEN RAISE EXCEPTION 'invalid_withdrawal' USING ERRCODE='P0001'; END IF;
  IF NOT EXISTS(SELECT 1 FROM collab.result_withdrawals WHERE result_id=result) THEN
    INSERT INTO collab.result_withdrawals(result_id,organization_id,project_id,task_id,withdrawn_by,reason) VALUES(result,r.organization_id,r.project_id,r.task_id,collab.actor(),btrim(reason));
    UPDATE collab.tasks SET version=version+1,updated_at=now() WHERE id=r.task_id;
    INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(r.organization_id,r.project_id,collab.actor(),'task.result_withdrawn',result::text,jsonb_build_object('reason',btrim(reason)));
  END IF;
  RETURN jsonb_build_object('resultId',result,'withdrawn',true);
END
$$;

CREATE FUNCTION collab_worker.claim_with_results(executor uuid, runtime_mode text, results_supported boolean, snapshots_supported boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab.runs; w collab.workspaces; locked_orgs uuid[] := '{}';
BEGIN
  PERFORM pg_advisory_xact_lock(82467104);
  -- Organization lock precedes run locks; never invert membership/stop ordering.
  FOR r IN SELECT * FROM collab.runs WHERE status='queued' ORDER BY created_at,id LOOP
    IF NOT pg_try_advisory_xact_lock(hashtextextended(r.organization_id::text,811)) THEN CONTINUE; END IF;
    IF NOT r.organization_id=ANY(locked_orgs) THEN locked_orgs := array_append(locked_orgs,r.organization_id); END IF;
    SELECT * INTO STRICT r FROM collab.runs WHERE id=r.id FOR UPDATE;
    IF r.status<>'queued' THEN CONTINUE; END IF;
    IF NOT collab_worker.authorized(r.id) THEN PERFORM collab_worker.request_stop(r.id,'authorization_revoked'); END IF;
  END LOOP;
  SELECT candidate.* INTO r FROM collab.runs candidate JOIN collab.workspaces workspace ON workspace.id=candidate.workspace_id
  WHERE candidate.status='queued' AND workspace.runtime=runtime_mode AND (snapshots_supported OR workspace.source_snapshot_id IS NULL)
    AND (results_supported OR NOT candidate.dependency_protocol) AND collab_worker.authorized(candidate.id)
    AND (candidate.dependency_protocol OR NOT EXISTS(SELECT 1 FROM collab.task_dependencies WHERE task_id=candidate.task_id))
    AND NOT EXISTS(SELECT 1 FROM collab.run_dependencies d JOIN collab.tasks upstream ON upstream.id=d.depends_on
      WHERE d.run_id=candidate.id AND d.kind='strict' AND (EXISTS(SELECT 1 FROM collab.result_withdrawals WHERE result_id=d.result_id)
        OR (d.result_id IS NULL AND (upstream.current_result_id IS NULL OR EXISTS(SELECT 1 FROM collab.result_withdrawals WHERE result_id=upstream.current_result_id)
          OR NOT EXISTS(SELECT 1 FROM collab.task_results available WHERE available.id=upstream.current_result_id AND collab_worker.dependencies_current(available.source_run_id))))))
    AND (SELECT count(*) FROM collab.runs a WHERE a.project_id=candidate.project_id AND a.status IN ('starting','running','waiting_input','stopping','reconciling'))<8
    AND (SELECT count(*) FROM collab.runs a WHERE a.requested_by=candidate.requested_by AND a.status IN ('starting','running','waiting_input','stopping','reconciling'))<2
    AND candidate.organization_id=ANY(locked_orgs)
  ORDER BY (SELECT count(*) FROM collab.runs a WHERE a.requested_by=candidate.requested_by AND a.status IN ('starting','running','waiting_input','stopping','reconciling')),candidate.created_at,candidate.id
  LIMIT 1 FOR UPDATE OF candidate SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE collab.run_dependencies d SET result_id=upstream.current_result_id FROM collab.tasks upstream WHERE d.run_id=r.id AND d.depends_on=upstream.id AND d.kind='strict' AND d.result_id IS NULL;
  UPDATE collab.workspaces SET epoch=epoch+1,lease_owner=executor,lease_expires_at=clock_timestamp()+interval '30 seconds',status='busy' WHERE id=r.workspace_id RETURNING * INTO w;
  UPDATE collab.runs SET status='starting',executor_id=executor,epoch=w.epoch,revision=revision+1,started_at=now() WHERE id=r.id RETURNING * INTO r;
  UPDATE collab.commands SET status='dispatched',updated_at=now() WHERE run_id=r.id AND kind='start';
  PERFORM collab_worker.emit(r.id,'run.starting',jsonb_build_object('epoch',w.epoch,'dependencies',collab_worker.dependency_pins(r.id)));
  RETURN jsonb_build_object('run',to_jsonb(r)||jsonb_build_object('epoch',r.epoch::text),'workspace',to_jsonb(w)||jsonb_build_object('epoch',w.epoch::text),'dependencies',collab_worker.dependency_pins(r.id));
END
$$;
CREATE OR REPLACE FUNCTION collab_worker.claim_compatible(executor uuid, runtime_mode text, snapshots_supported boolean) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT collab_worker.claim_with_results(executor,runtime_mode,false,snapshots_supported)
$$;
CREATE FUNCTION collab_worker.claim_result_aware(executor uuid, runtime_mode text) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT collab_worker.claim_with_results(executor,runtime_mode,true,true)
$$;

-- Old snapshot workers cannot omit dependency provenance during a rolling upgrade.
ALTER FUNCTION collab_worker.pending_snapshots() RENAME TO pending_snapshots_v1;
REVOKE EXECUTE ON FUNCTION collab_worker.pending_snapshots_v1() FROM pi_collab_executor;
CREATE FUNCTION collab_worker.pending_snapshots() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT COALESCE(jsonb_agg(item),'[]'::jsonb) FROM jsonb_array_elements(collab_worker.pending_snapshots_v1()) item
  WHERE NOT EXISTS(SELECT 1 FROM collab.run_dependencies WHERE run_id=(item->>'runId')::uuid)
$$;
CREATE FUNCTION collab_worker.pending_snapshots_with_results() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT COALESCE(jsonb_agg(item||jsonb_build_object('dependencies',collab_worker.dependency_pins((item->>'runId')::uuid))),'[]'::jsonb)
  FROM jsonb_array_elements(collab_worker.pending_snapshots_v1()) item
$$;

REVOKE ALL ON FUNCTION collab.add_task_dependency(uuid,uuid,text),collab_worker.dependency_pins(uuid),collab_worker.dependencies_current(uuid),collab.run_dependency_state(uuid),collab.submit_run(uuid,uuid,text,text,text,uuid,integer,uuid,uuid),collab.publish_task_result(uuid,uuid,integer,uuid,text),collab.withdraw_task_result(uuid,text),collab_worker.claim_with_results(uuid,text,boolean,boolean),collab_worker.claim_result_aware(uuid,text),collab_worker.pending_snapshots(),collab_worker.pending_snapshots_with_results() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.add_task_dependency(uuid,uuid,text),collab.run_dependency_state(uuid),collab.submit_run(uuid,uuid,text,text,text,uuid,integer,uuid,uuid),collab.publish_task_result(uuid,uuid,integer,uuid,text),collab.withdraw_task_result(uuid,text) TO pi_collab_app;
GRANT EXECUTE ON FUNCTION collab_worker.claim_result_aware(uuid,text),collab_worker.pending_snapshots(),collab_worker.pending_snapshots_with_results() TO pi_collab_executor;

CREATE FUNCTION collab_worker.claim_validation_compatible(executor uuid, result_inputs_supported boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v collab.validations; outcome text;
BEGIN
  IF executor IS NULL THEN RAISE EXCEPTION 'invalid_validation' USING ERRCODE='P0001'; END IF;
  PERFORM pg_advisory_xact_lock(82467109);
  FOR v IN SELECT * FROM collab.validations WHERE (status='running' AND lease_expires_at<=clock_timestamp()) OR (status='queued' AND NOT collab_worker.validation_authorized(id)) ORDER BY organization_id,id LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(v.organization_id::text,811));
    SELECT * INTO STRICT v FROM collab.validations WHERE id=v.id FOR UPDATE;
    IF v.status='running' AND v.lease_expires_at<=clock_timestamp() THEN outcome := 'unknown';
    ELSIF v.status='queued' AND NOT collab_worker.validation_authorized(v.id) THEN outcome := 'revoked';
    ELSE CONTINUE; END IF;
    UPDATE collab.validations SET status=outcome,error_code=CASE WHEN outcome='unknown' THEN 'validation_lease_expired' ELSE 'authorization_changed' END,finished_at=now() WHERE id=v.id;
    INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id) VALUES(v.organization_id,v.project_id,v.requested_by,'validation.'||outcome,v.id::text);
  END LOOP;
  SELECT candidate.* INTO v FROM collab.validations candidate JOIN collab.snapshots s ON s.id=candidate.snapshot_id
    WHERE candidate.status='queued' AND collab_worker.validation_authorized(candidate.id)
    AND (result_inputs_supported OR NOT EXISTS(SELECT 1 FROM collab.run_dependencies WHERE run_id=s.run_id))
    AND (SELECT count(*) FROM collab.validations a WHERE a.project_id=candidate.project_id AND a.status IN ('running','unknown'))<2
    AND NOT EXISTS(SELECT 1 FROM collab.validations a WHERE a.requested_by=candidate.requested_by AND a.status IN ('running','unknown'))
    ORDER BY candidate.created_at,candidate.id LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v.organization_id::text,811));
  SELECT * INTO STRICT v FROM collab.validations WHERE id=v.id FOR UPDATE;
  IF v.status<>'queued' OR NOT collab_worker.validation_authorized(v.id) THEN RETURN NULL; END IF;
  UPDATE collab.validations SET status='running',epoch=epoch+1,executor_id=executor,lease_expires_at=clock_timestamp()+interval '30 seconds',started_at=now() WHERE id=v.id RETURNING * INTO v;
  INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id) VALUES(v.organization_id,v.project_id,v.requested_by,'validation.running',v.id::text);
  RETURN (SELECT jsonb_build_object('id',v.id,'executorId',executor,'epoch',v.epoch::text,'snapshotId',v.snapshot_id,'manifestHash',v.manifest_hash,'profileId',v.profile_id,'repositoryId',p.repository_id,'config',p.config) FROM collab.validation_profiles p WHERE p.id=v.profile_id);
END
$$;
CREATE OR REPLACE FUNCTION collab_worker.claim_validation(executor uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT collab_worker.claim_validation_compatible(executor,false)
$$;
CREATE FUNCTION collab_worker.claim_validation_with_results(executor uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT collab_worker.claim_validation_compatible(executor,true)
$$;
REVOKE ALL ON FUNCTION collab_worker.claim_validation_compatible(uuid,boolean),collab_worker.claim_validation_with_results(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab_worker.claim_validation_with_results(uuid) TO pi_collab_executor;
