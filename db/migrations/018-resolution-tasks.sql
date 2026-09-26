-- Human-owned repair tasks retain every original input while replacing its
-- whole composition. Older workers cannot consume the new provenance.
CREATE TABLE collab.resolution_tasks (
 task_id uuid PRIMARY KEY, organization_id uuid NOT NULL, project_id uuid NOT NULL,
 integration_id uuid NOT NULL UNIQUE, input jsonb NOT NULL,
 created_by text NOT NULL REFERENCES public."user"(id), idempotency_key uuid NOT NULL,
 request jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(created_by,integration_id,idempotency_key),
 FOREIGN KEY(organization_id,project_id,task_id) REFERENCES collab.tasks(organization_id,project_id,id),
 FOREIGN KEY(organization_id,project_id,integration_id) REFERENCES collab.integrations(organization_id,project_id,id),
 CHECK(jsonb_typeof(input)='object' AND pg_column_size(input)<=1048576)
);
ALTER TABLE collab.resolution_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY resolution_read ON collab.resolution_tasks FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
GRANT SELECT ON collab.resolution_tasks TO pi_collab_app;

CREATE FUNCTION collab_worker.resolution_input(run uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT rt.input FROM collab.resolution_tasks rt JOIN collab.runs r ON r.task_id=rt.task_id WHERE r.id=run
$$;
CREATE FUNCTION collab_worker.requires_resolution_protocol(run uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 -- Strict dependencies may still be unpinned while waiting in the queue.
 -- Inspect the result that dispatch would pin, under its organization lock.
 SELECT collab_worker.resolution_input(run) IS NOT NULL OR EXISTS(SELECT 1 FROM collab.run_dependencies d
  JOIN collab.tasks t ON t.id=d.depends_on JOIN collab.task_results r ON r.id=COALESCE(d.result_id,CASE WHEN d.kind='strict' THEN t.current_result_id END)
  JOIN collab.resolution_tasks rt ON rt.task_id=r.task_id WHERE d.run_id=run)
$$;
-- Deliberately nonrecursive: dependency lineage below checks every original run.
-- Calling integration_current here would recurse through resolution results.
CREATE FUNCTION collab_worker.resolution_current(task uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT NOT EXISTS(SELECT 1 FROM collab.resolution_tasks rt JOIN collab.integrations i ON i.id=rt.integration_id JOIN collab.repositories repo ON repo.id=i.repository_id
 WHERE rt.task_id=task AND (i.status<>'conflicted' OR i.policy_id IS NULL OR NOT collab_worker.integration_authorized(i.id)
 OR i.policy_id IS DISTINCT FROM collab_worker.current_integration_policy(i.repository_id,i.target_branch)
 OR i.target_sha<>repo.base_sha OR i.target_branch<>repo.default_branch
 OR EXISTS(SELECT 1 FROM collab.integration_sources s JOIN collab.tasks t ON t.id=s.task_id WHERE s.integration_id=i.id AND
   (t.current_result_id IS DISTINCT FROM s.result_id OR EXISTS(SELECT 1 FROM collab.result_withdrawals WHERE result_id=s.result_id)))))
$$;
CREATE OR REPLACE FUNCTION collab_worker.dependencies_current(run uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 WITH RECURSIVE lineage(id) AS (
  SELECT run UNION SELECT result.source_run_id FROM lineage l JOIN collab.run_dependencies d ON d.run_id=l.id JOIN collab.task_results result ON result.id=d.result_id
 ) SELECT NOT EXISTS(SELECT 1 FROM lineage l JOIN collab.runs r ON r.id=l.id JOIN collab.tasks t ON t.id=r.task_id
  WHERE NOT r.dependency_protocol OR r.dependency_version IS DISTINCT FROM t.dependency_version OR NOT collab_worker.contracts_current(r.id)
   OR NOT collab_worker.resolution_current(t.id)
   OR EXISTS(SELECT 1 FROM collab.run_dependencies d JOIN collab.tasks upstream ON upstream.id=d.depends_on
    WHERE d.run_id=r.id AND (d.result_id IS NULL OR d.result_id IS DISTINCT FROM upstream.current_result_id OR EXISTS(SELECT 1 FROM collab.result_withdrawals WHERE result_id=d.result_id))))
$$;
CREATE FUNCTION collab.create_resolution_task(candidate uuid, target_owner text, title text, reason text, request_key uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i collab.integrations; prior collab.resolution_tasks; role text; task uuid:=gen_random_uuid(); payload jsonb; pinned jsonb;
BEGIN
 SELECT * INTO i FROM collab.integrations WHERE id=candidate;
 IF i.id IS NULL OR collab.project_role(i.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(i.organization_id::text,811));
 PERFORM pg_advisory_xact_lock(hashtextextended(i.project_id::text,0));
 SELECT * INTO STRICT i FROM collab.integrations WHERE id=candidate;
 role:=collab.project_role(i.project_id);
 IF role IS NULL OR role NOT IN ('maintainer','developer') OR (role<>'maintainer' AND target_owner IS DISTINCT FROM collab.actor()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF collab.user_requires_mfa(collab.actor()) AND NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
 IF title IS NULL OR length(btrim(title)) NOT BETWEEN 1 AND 200 OR reason IS NULL OR length(btrim(reason)) NOT BETWEEN 10 AND 2000 OR request_key IS NULL OR target_owner IS NULL THEN RAISE EXCEPTION 'invalid_resolution' USING ERRCODE='P0001'; END IF;
 payload:=jsonb_build_object('ownerId',target_owner,'title',btrim(title),'reason',btrim(reason));
 SELECT * INTO prior FROM collab.resolution_tasks WHERE integration_id=candidate;
 IF FOUND THEN
  IF prior.created_by<>collab.actor() OR prior.idempotency_key<>request_key THEN RAISE EXCEPTION 'resolution_exists' USING ERRCODE='P0001'; END IF;
  IF prior.request<>payload THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
  RETURN jsonb_build_object('taskId',prior.task_id,'replayed',true);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM collab.project_memberships pm JOIN collab.memberships m ON m.organization_id=pm.organization_id AND m.user_id=pm.user_id
  WHERE pm.project_id=i.project_id AND pm.user_id=target_owner AND pm.active AND m.active AND pm.role IN ('maintainer','developer')) THEN RAISE EXCEPTION 'invalid_owner' USING ERRCODE='P0001'; END IF;
 IF i.status<>'conflicted' OR i.policy_id IS NULL OR NOT collab_worker.integration_authorized(i.id) OR NOT collab_worker.integration_current(i.id)
  OR jsonb_typeof(i.evidence->'conflict') IS DISTINCT FROM 'object' OR jsonb_typeof(i.evidence->'merges') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'resolution_source_unavailable' USING ERRCODE='P0001'; END IF;
 pinned:=jsonb_build_object('version',1,'taskId',task,'integrationId',i.id,'inputHash',i.input_hash,'repositoryId',i.repository_id,'targetBranch',i.target_branch,'targetSha',i.target_sha,
  'profileId',i.profile_id,'policyId',i.policy_id,'sources',i.sources,'merges',i.evidence->'merges','conflict',i.evidence->'conflict');
 INSERT INTO collab.tasks(id,organization_id,project_id,title,description,acceptance,owner_id,created_by)
 VALUES(task,i.organization_id,i.project_id,btrim(title),btrim(reason),'Resolve the complete pinned combination, explain all conflict choices, pass required checks and obtain fresh independent reviews.',target_owner,collab.actor());
 INSERT INTO collab.task_dependencies SELECT i.organization_id,i.project_id,task,s.task_id,'strict' FROM collab.integration_sources s WHERE s.integration_id=i.id;
 INSERT INTO collab.resolution_tasks VALUES(task,i.organization_id,i.project_id,i.id,pinned,collab.actor(),request_key,payload,now());
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail)
 VALUES(i.organization_id,i.project_id,collab.actor(),'resolution.created',task::text,jsonb_build_object('integrationId',i.id,'ownerId',target_owner,'reason',btrim(reason),'inputHash',i.input_hash));
 RETURN jsonb_build_object('taskId',task,'replayed',false);
END $$;
CREATE FUNCTION collab_worker.freeze_resolution_dependencies() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM collab.resolution_tasks WHERE task_id=CASE WHEN TG_OP='DELETE' THEN OLD.task_id ELSE NEW.task_id END)
  OR (TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM collab.resolution_tasks WHERE task_id=OLD.task_id)) THEN RAISE EXCEPTION 'resolution_dependencies_fixed' USING ERRCODE='P0001'; END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER freeze_resolution_dependencies BEFORE INSERT OR UPDATE OR DELETE ON collab.task_dependencies FOR EACH ROW EXECUTE FUNCTION collab_worker.freeze_resolution_dependencies();

ALTER FUNCTION collab.submit_run(uuid,uuid,text,text,text,uuid,integer,uuid,uuid) RENAME TO submit_run_contracts_v17;
REVOKE EXECUTE ON FUNCTION collab.submit_run_contracts_v17(uuid,uuid,text,text,text,uuid,integer,uuid,uuid) FROM pi_collab_app;
CREATE FUNCTION collab.submit_run(task uuid, repository uuid, base text, message text, runtime_mode text, request_key uuid, expected_version integer, model_profile uuid, snapshot uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE accepted jsonb; rt collab.resolution_tasks; run uuid;
BEGIN
 accepted:=collab.submit_run_contracts_v17(task,repository,base,message,runtime_mode,request_key,expected_version,model_profile,snapshot);
 SELECT * INTO rt FROM collab.resolution_tasks WHERE task_id=task;
 IF rt.task_id IS NOT NULL AND NOT (accepted->>'replayed')::boolean THEN
  run:=(accepted->>'runId')::uuid;
  IF runtime_mode<>'native' OR rt.input->>'repositoryId'<>repository::text OR rt.input->>'targetSha'<>base THEN RAISE EXCEPTION 'resolution_source_unavailable' USING ERRCODE='P0001'; END IF;
  IF NOT collab_worker.resolution_current(task) OR NOT collab_worker.dependencies_current(run)
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(rt.input->'sources') source WHERE NOT EXISTS(SELECT 1 FROM collab.run_dependencies d WHERE d.run_id=run AND d.depends_on::text=source->>'taskId' AND d.result_id::text=source->>'resultId')) THEN RAISE EXCEPTION 'resolution_source_unavailable' USING ERRCODE='P0001'; END IF;
 END IF;
 RETURN accepted;
END $$;
ALTER FUNCTION collab_worker.authorized(uuid) RENAME TO authorized_v17;
CREATE FUNCTION collab_worker.authorized(run uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT collab_worker.authorized_v17(run) AND (collab_worker.resolution_input(run) IS NULL OR collab_worker.dependencies_current(run))
$$;
ALTER FUNCTION collab.request_validation(uuid,uuid,uuid) RENAME TO request_validation_v17;
REVOKE EXECUTE ON FUNCTION collab.request_validation_v17(uuid,uuid,uuid) FROM pi_collab_app;
CREATE FUNCTION collab.request_validation(snapshot uuid, profile uuid, request_key uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE accepted jsonb; source_run uuid; pinned jsonb;
BEGIN
 accepted:=collab.request_validation_v17(snapshot,profile,request_key);
 SELECT run_id INTO source_run FROM collab.snapshots WHERE id=snapshot; pinned:=collab_worker.resolution_input(source_run);
 IF pinned IS NOT NULL AND NOT (accepted->>'replayed')::boolean AND (pinned->>'profileId'<>profile::text OR NOT collab_worker.dependencies_current(source_run)) THEN RAISE EXCEPTION 'resolution_validation_required' USING ERRCODE='P0001'; END IF;
 RETURN accepted;
END $$;
ALTER FUNCTION collab_worker.validation_authorized(uuid) RENAME TO validation_authorized_v17;
CREATE FUNCTION collab_worker.validation_authorized(validation uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT collab_worker.validation_authorized_v17(validation) AND NOT EXISTS(SELECT 1 FROM collab.validations v JOIN collab.snapshots s ON s.id=v.snapshot_id
  JOIN collab.resolution_tasks rt ON rt.task_id=s.task_id WHERE v.id=validation AND (NOT collab_worker.dependencies_current(s.run_id) OR v.profile_id::text<>rt.input->>'profileId'))
$$;

CREATE TABLE collab.resolution_publications (
 result_id uuid PRIMARY KEY REFERENCES collab.task_results(id), organization_id uuid NOT NULL, project_id uuid NOT NULL, task_id uuid NOT NULL,
 acknowledged_by text NOT NULL REFERENCES public."user"(id), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,project_id,task_id,result_id) REFERENCES collab.task_results(organization_id,project_id,task_id,id)
);
ALTER TABLE collab.resolution_publications ENABLE ROW LEVEL SECURITY;
CREATE POLICY resolution_publication_read ON collab.resolution_publications FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
GRANT SELECT ON collab.resolution_publications TO pi_collab_app;
ALTER FUNCTION collab.publish_task_result(uuid,uuid,integer,uuid,text) RENAME TO publish_task_result_v17;
REVOKE EXECUTE ON FUNCTION collab.publish_task_result_v17(uuid,uuid,integer,uuid,text) FROM pi_collab_app;
CREATE FUNCTION collab.publish_task_result(task uuid, validation uuid, expected_version integer, request_key uuid, note text, acknowledge_resolution boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE accepted jsonb; pinned jsonb; v collab.validations; t collab.tasks;
BEGIN
 accepted:=collab.publish_task_result_v17(task,validation,expected_version,request_key,note);
 SELECT input INTO pinned FROM collab.resolution_tasks WHERE task_id=task;
 IF pinned IS NOT NULL THEN
  IF acknowledge_resolution IS DISTINCT FROM true OR length(btrim(note))<10 THEN RAISE EXCEPTION 'resolution_acknowledgement_required' USING ERRCODE='P0001'; END IF;
  IF NOT (accepted->>'replayed')::boolean THEN
   SELECT * INTO STRICT v FROM collab.validations WHERE id=validation;
   IF v.evidence->'resolution' IS DISTINCT FROM pinned OR v.profile_id::text<>pinned->>'profileId'
    OR v.evidence->'resolutionMarkersAbsent' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'resolution_validation_required' USING ERRCODE='P0001'; END IF;
   SELECT * INTO STRICT t FROM collab.tasks WHERE id=task;
   INSERT INTO collab.resolution_publications VALUES((accepted->>'resultId')::uuid,t.organization_id,t.project_id,task,collab.actor(),now());
   INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(t.organization_id,t.project_id,collab.actor(),'resolution.published',task::text,jsonb_build_object('resultId',accepted->>'resultId','integrationId',pinned->>'integrationId','acknowledgedAllConflictChoices',true));
  END IF;
 ELSIF acknowledge_resolution IS DISTINCT FROM false THEN RAISE EXCEPTION 'invalid_task_result' USING ERRCODE='P0001'; END IF;
 RETURN accepted;
END $$;

REVOKE ALL ON FUNCTION collab.create_resolution_task(uuid,text,text,text,uuid),collab.submit_run(uuid,uuid,text,text,text,uuid,integer,uuid,uuid),collab.request_validation(uuid,uuid,uuid),collab.publish_task_result(uuid,uuid,integer,uuid,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.create_resolution_task(uuid,text,text,text,uuid),collab.submit_run(uuid,uuid,text,text,text,uuid,integer,uuid,uuid),collab.request_validation(uuid,uuid,uuid),collab.publish_task_result(uuid,uuid,integer,uuid,text,boolean) TO pi_collab_app;

CREATE FUNCTION collab_worker.covered_results(result uuid) RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 WITH RECURSIVE covered(id) AS (
  SELECT s.result_id FROM collab.task_results r JOIN collab.resolution_tasks rt ON rt.task_id=r.task_id JOIN collab.integration_sources s ON s.integration_id=rt.integration_id WHERE r.id=result
  UNION SELECT s.result_id FROM covered c JOIN collab.task_results r ON r.id=c.id JOIN collab.resolution_tasks rt ON rt.task_id=r.task_id JOIN collab.integration_sources s ON s.integration_id=rt.integration_id
 ) SELECT id FROM covered
$$;
CREATE FUNCTION collab_worker.composition_plan(all_results uuid[], roots uuid[]) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE survivors uuid[]; result uuid; dependency uuid; replacement uuid; mapped uuid[]; mappings jsonb:='{}';
BEGIN
 SELECT array_agg(id ORDER BY id) INTO survivors FROM unnest(all_results) id WHERE NOT EXISTS(SELECT 1 FROM unnest(all_results) parent CROSS JOIN LATERAL collab_worker.covered_results(parent) covered WHERE covered=id);
 IF cardinality(survivors)>32 THEN RAISE EXCEPTION 'integration_limit' USING ERRCODE='P0001'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(roots) id WHERE NOT id=ANY(survivors))
  OR EXISTS(SELECT covered FROM unnest(survivors) parent CROSS JOIN LATERAL collab_worker.covered_results(parent) covered GROUP BY covered HAVING count(*)>1) THEN RAISE EXCEPTION 'resolution_overlap' USING ERRCODE='P0001'; END IF;
 FOREACH result IN ARRAY survivors LOOP
  mapped:='{}';
  FOR dependency IN SELECT d.result_id FROM collab.task_results r JOIN collab.run_dependencies d ON d.run_id=r.source_run_id WHERE r.id=result LOOP
   IF dependency IS NULL THEN RAISE EXCEPTION 'integration_source_unavailable' USING ERRCODE='P0001'; END IF;
   IF dependency IN (SELECT collab_worker.covered_results(result)) THEN CONTINUE; END IF;
   IF dependency=ANY(survivors) THEN replacement:=dependency;
   ELSE SELECT parent INTO replacement FROM unnest(survivors) parent WHERE dependency IN (SELECT collab_worker.covered_results(parent)); END IF;
   IF replacement IS NULL OR replacement=result THEN RAISE EXCEPTION 'integration_source_unavailable' USING ERRCODE='P0001'; END IF;
   IF NOT replacement=ANY(mapped) THEN mapped:=array_append(mapped,replacement); END IF;
  END LOOP;
  SELECT COALESCE(array_agg(id ORDER BY id),'{}'::uuid[]) INTO mapped FROM unnest(mapped) id;
  mappings:=mappings||jsonb_build_object(result::text,to_jsonb(mapped));
 END LOOP;
 RETURN jsonb_build_object('results',to_jsonb(survivors),'dependencies',mappings);
END $$;
CREATE OR REPLACE FUNCTION collab_worker.integration_contributor(candidate uuid, person text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 WITH RECURSIVE lineage(id) AS (
  SELECT result_id FROM collab.integration_sources WHERE integration_id=candidate
  UNION SELECT d.result_id FROM lineage l JOIN collab.task_results r ON r.id=l.id JOIN collab.run_dependencies d ON d.run_id=r.source_run_id WHERE d.result_id IS NOT NULL
 ) SELECT EXISTS(SELECT 1 FROM collab.integrations WHERE id=candidate AND requested_by=person)
 OR EXISTS(SELECT 1 FROM lineage l JOIN collab.task_results r ON r.id=l.id JOIN collab.runs run ON run.id=r.source_run_id WHERE r.published_by=person OR run.requested_by=person)
$$;


-- Explicit capability negotiation keeps every older worker entry point safe.
CREATE FUNCTION collab_worker.claim_with_resolutions(executor uuid, runtime_mode text, results_supported boolean, snapshots_supported boolean, contracts_supported boolean, resolutions_supported boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
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
    AND (resolutions_supported OR NOT collab_worker.requires_resolution_protocol(candidate.id))
    AND (contracts_supported OR NOT EXISTS(SELECT 1 FROM collab.run_contracts WHERE run_id=candidate.id))
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
  RETURN jsonb_build_object('run',to_jsonb(r)||jsonb_build_object('epoch',r.epoch::text),'workspace',to_jsonb(w)||jsonb_build_object('epoch',w.epoch::text),'dependencies',collab_worker.dependency_pins(r.id),'contracts',collab_worker.contract_pins(r.id),'resolution',collab_worker.resolution_input(r.id));
END
$$;
CREATE FUNCTION collab_worker.claim_validation_resolutions(executor uuid, result_inputs_supported boolean, contract_inputs_supported boolean, resolution_inputs_supported boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
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
    AND (resolution_inputs_supported OR NOT collab_worker.requires_resolution_protocol(s.run_id))
    AND (contract_inputs_supported OR NOT EXISTS(SELECT 1 FROM collab.run_contracts WHERE run_id=s.run_id))
    AND (SELECT count(*) FROM collab.validations a WHERE a.project_id=candidate.project_id AND a.status IN ('running','unknown'))<2
    AND NOT EXISTS(SELECT 1 FROM collab.validations a WHERE a.requested_by=candidate.requested_by AND a.status IN ('running','unknown'))
    ORDER BY candidate.created_at,candidate.id LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v.organization_id::text,811));
  SELECT * INTO STRICT v FROM collab.validations WHERE id=v.id FOR UPDATE;
  IF v.status<>'queued' OR NOT collab_worker.validation_authorized(v.id) THEN RETURN NULL; END IF;
  UPDATE collab.validations SET status='running',epoch=epoch+1,executor_id=executor,lease_expires_at=clock_timestamp()+interval '30 seconds',started_at=now() WHERE id=v.id RETURNING * INTO v;
  INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id) VALUES(v.organization_id,v.project_id,v.requested_by,'validation.running',v.id::text);
  RETURN (SELECT jsonb_build_object('id',v.id,'executorId',executor,'epoch',v.epoch::text,'snapshotId',v.snapshot_id,'manifestHash',v.manifest_hash,'profileId',v.profile_id,'repositoryId',p.repository_id,'config',p.config,'resolution',collab_worker.resolution_input((SELECT run_id FROM collab.snapshots WHERE id=v.snapshot_id))) FROM collab.validation_profiles p WHERE p.id=v.profile_id);
END
$$;
CREATE OR REPLACE FUNCTION collab_worker.finish_validation(executor uuid, validation uuid, generation bigint, requested_outcome text, result jsonb, failure text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v collab.validations; outcome text; configuration jsonb;
BEGIN
  SELECT * INTO v FROM collab.validations WHERE id=validation;
  IF v.id IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v.organization_id::text,811));
  SELECT * INTO STRICT v FROM collab.validations WHERE id=validation FOR UPDATE;
  IF v.executor_id IS DISTINCT FROM executor OR v.epoch IS DISTINCT FROM generation THEN RAISE EXCEPTION 'validation_lease_lost' USING ERRCODE='P0001'; END IF;
  IF v.status<>'running' THEN RETURN v.status; END IF;
  IF v.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'validation_lease_lost' USING ERRCODE='P0001'; END IF;
  IF requested_outcome IS NULL OR requested_outcome NOT IN ('passed','failed','cancelled','unknown') OR pg_column_size(result)>2097152 OR length(failure)>120 THEN RAISE EXCEPTION 'invalid_validation' USING ERRCODE='P0001'; END IF;
  SELECT config INTO STRICT configuration FROM collab.validation_profiles WHERE id=v.profile_id;
  IF result IS NOT NULL AND (jsonb_typeof(result) IS DISTINCT FROM 'object' OR result->>'validationId' IS DISTINCT FROM v.id::text OR result->>'snapshotId' IS DISTINCT FROM v.snapshot_id::text OR result->>'manifestHash' IS DISTINCT FROM v.manifest_hash OR result->>'profileId' IS DISTINCT FROM v.profile_id::text OR result->'config' IS DISTINCT FROM configuration) THEN RAISE EXCEPTION 'invalid_validation' USING ERRCODE='P0001'; END IF;
  IF result IS NOT NULL AND COALESCE(result->'resolution','null'::jsonb) IS DISTINCT FROM COALESCE(collab_worker.resolution_input((SELECT run_id FROM collab.snapshots WHERE id=v.snapshot_id)),'null'::jsonb) THEN RAISE EXCEPTION 'invalid_validation' USING ERRCODE='P0001'; END IF;
  IF requested_outcome='passed' AND EXISTS(SELECT 1 FROM collab.resolution_tasks WHERE task_id=v.task_id) AND result->'resolutionMarkersAbsent' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'invalid_validation' USING ERRCODE='P0001'; END IF;
  IF requested_outcome='passed' THEN
    IF result IS NULL OR result->>'outcome' IS DISTINCT FROM 'passed' OR jsonb_typeof(result->'steps') IS DISTINCT FROM 'array' OR failure IS NOT NULL THEN RAISE EXCEPTION 'invalid_validation' USING ERRCODE='P0001'; END IF;
    IF jsonb_array_length(result->'steps')<>jsonb_array_length(configuration->'steps') OR EXISTS(SELECT 1 FROM jsonb_array_elements(result->'steps') step WHERE step->'exitCode' IS DISTINCT FROM '0'::jsonb OR step->'cleanupConfirmed' IS DISTINCT FROM 'true'::jsonb OR step->'sourceUnchanged' IS DISTINCT FROM 'true'::jsonb OR step->'error' IS DISTINCT FROM 'null'::jsonb) THEN RAISE EXCEPTION 'invalid_validation' USING ERRCODE='P0001'; END IF;
    IF COALESCE(result->>'worktreeCommit','') !~ '^[a-f0-9]{40}$' OR COALESCE(result->>'configHash','') !~ '^[a-f0-9]{64}$'
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(result->'steps') WITH ORDINALITY AS step(value,position)
        WHERE jsonb_build_object('tool',value->'tool','args',value->'args','timeoutSeconds',value->'timeoutSeconds') IS DISTINCT FROM configuration->'steps'->(position::integer-1)) THEN RAISE EXCEPTION 'invalid_validation' USING ERRCODE='P0001'; END IF;
  END IF;
  outcome := CASE WHEN requested_outcome='unknown' THEN 'unknown' WHEN NOT collab_worker.validation_authorized(validation) THEN 'revoked' WHEN v.stop_requested THEN 'cancelled' ELSE requested_outcome END;
  UPDATE collab.validations SET status=outcome,evidence=result,error_code=CASE WHEN outcome='revoked' THEN 'authorization_changed' ELSE failure END,finished_at=now() WHERE id=validation;
  INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(v.organization_id,v.project_id,v.requested_by,'validation.'||outcome,v.id::text,jsonb_build_object('snapshotId',v.snapshot_id,'manifestHash',v.manifest_hash));
  RETURN outcome;
END
$$;

CREATE OR REPLACE FUNCTION collab_worker.claim_with_contracts(executor uuid, runtime_mode text, results_supported boolean, snapshots_supported boolean, contracts_supported boolean) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT collab_worker.claim_with_resolutions(executor,runtime_mode,results_supported,snapshots_supported,contracts_supported,false)
$$;
CREATE FUNCTION collab_worker.claim_resolution_aware(executor uuid, runtime_mode text) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT collab_worker.claim_with_resolutions(executor,runtime_mode,true,true,true,true)
$$;
CREATE OR REPLACE FUNCTION collab_worker.claim_validation_inputs(executor uuid, result_inputs_supported boolean, contract_inputs_supported boolean) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT collab_worker.claim_validation_resolutions(executor,result_inputs_supported,contract_inputs_supported,false)
$$;
CREATE FUNCTION collab_worker.claim_validation_with_resolutions(executor uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT collab_worker.claim_validation_resolutions(executor,true,true,true)
$$;
CREATE OR REPLACE FUNCTION collab_worker.pending_snapshots_with_contracts() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT COALESCE(jsonb_agg(item||jsonb_build_object('dependencies',collab_worker.dependency_pins((item->>'runId')::uuid),'contracts',collab_worker.contract_pins((item->>'runId')::uuid))),'[]'::jsonb)
 FROM jsonb_array_elements(collab_worker.pending_snapshots_v1()) item WHERE NOT collab_worker.requires_resolution_protocol((item->>'runId')::uuid)
$$;
CREATE FUNCTION collab_worker.pending_snapshots_with_resolutions() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT COALESCE(jsonb_agg(item||jsonb_build_object('dependencies',collab_worker.dependency_pins((item->>'runId')::uuid),'contracts',collab_worker.contract_pins((item->>'runId')::uuid),'resolution',collab_worker.resolution_input((item->>'runId')::uuid))),'[]'::jsonb)
 FROM jsonb_array_elements(collab_worker.pending_snapshots_v1()) item
$$;


CREATE OR REPLACE FUNCTION collab_worker.request_integration_v16(repository uuid, target text, results uuid[], profile uuid, request_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE repo collab.repositories; prior collab.integrations; roots uuid[]; remaining uuid[]; emitted uuid[]:='{}'; sources jsonb:='[]'; r collab.task_results; deps uuid[]; source jsonb; candidate uuid:=gen_random_uuid(); config jsonb; role text; plan jsonb;
BEGIN
 SELECT * INTO repo FROM collab.repositories WHERE id=repository;
 IF repo.id IS NULL OR collab.project_role(repo.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(repo.organization_id::text,811)); SELECT * INTO STRICT repo FROM collab.repositories WHERE id=repository;
 role:=collab.project_role(repo.project_id);
 IF role IS NULL OR role NOT IN ('maintainer','developer') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF collab.user_requires_mfa(collab.actor()) AND NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
 IF results IS NULL OR cardinality(results) NOT BETWEEN 1 AND 32 OR request_key IS NULL OR target IS NULL OR profile IS NULL OR EXISTS(SELECT 1 FROM unnest(results) x WHERE x IS NULL) THEN RAISE EXCEPTION 'invalid_integration' USING ERRCODE='P0001'; END IF;
 SELECT array_agg(DISTINCT x ORDER BY x) INTO roots FROM unnest(results) x;
 IF cardinality(roots)<>cardinality(results) THEN RAISE EXCEPTION 'invalid_integration' USING ERRCODE='P0001'; END IF;
 SELECT * INTO prior FROM collab.integrations WHERE repository_id=repository AND requested_by=collab.actor() AND idempotency_key=request_key;
 IF FOUND THEN
  IF prior.root_result_ids<>roots OR prior.target_sha<>target OR prior.profile_id<>profile THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
  RETURN jsonb_build_object('integrationId',prior.id,'status',prior.status,'replayed',true);
 END IF;
 IF repo.base_sha<>target THEN RAISE EXCEPTION 'integration_stale' USING ERRCODE='P0001'; END IF;
 SELECT p.config INTO config FROM collab.validation_profiles p WHERE id=profile AND repository_id=repository AND project_id=repo.project_id;
 IF config IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 IF (SELECT count(*) FROM collab.integrations WHERE project_id=repo.project_id AND status IN ('queued','integrating','checking','unknown'))>=20 THEN RAISE EXCEPTION 'integration_limit' USING ERRCODE='P0001'; END IF;
 WITH RECURSIVE chosen(id) AS (SELECT unnest(roots) UNION SELECT d.result_id FROM chosen c JOIN collab.task_results rr ON rr.id=c.id JOIN collab.run_dependencies d ON d.run_id=rr.source_run_id WHERE d.result_id IS NOT NULL)
 SELECT array_agg(id ORDER BY id) INTO remaining FROM chosen;
 IF cardinality(remaining)>256 THEN RAISE EXCEPTION 'integration_limit' USING ERRCODE='P0001'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(remaining) chosen_id WHERE NOT EXISTS(SELECT 1 FROM collab.task_results tr JOIN collab.tasks t ON t.id=tr.task_id JOIN collab.snapshots s ON s.id=tr.snapshot_id JOIN collab.workspaces w ON w.id=s.workspace_id
   WHERE tr.id=chosen_id AND tr.project_id=repo.project_id AND t.current_result_id=tr.id AND w.repository_id=repository AND s.status='ready' AND s.manifest_hash=tr.manifest_hash AND w.runtime='native'
   AND NOT EXISTS(SELECT 1 FROM collab.result_withdrawals WHERE result_id=tr.id) AND collab_worker.dependencies_current(tr.source_run_id))) THEN RAISE EXCEPTION 'integration_source_unavailable' USING ERRCODE='P0001'; END IF;
 plan:=collab_worker.composition_plan(remaining,roots);
 SELECT array_agg(value::uuid) INTO remaining FROM jsonb_array_elements_text(plan->'results');
 WHILE cardinality(remaining)>0 LOOP
  SELECT * INTO r FROM collab.task_results tr WHERE tr.id=ANY(remaining) AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(plan->'dependencies'->tr.id::text) dep WHERE NOT dep::uuid=ANY(emitted)) ORDER BY tr.task_id,tr.id LIMIT 1;
  IF r.id IS NULL THEN RAISE EXCEPTION 'integration_source_unavailable' USING ERRCODE='P0001'; END IF;
  SELECT COALESCE(array_agg(value::uuid ORDER BY value),'{}'::uuid[]) INTO deps FROM jsonb_array_elements_text(plan->'dependencies'->r.id::text);
  SELECT jsonb_build_object('resultId',r.id,'taskId',r.task_id,'snapshotId',r.snapshot_id,'manifestHash',r.manifest_hash,'worktreeCommit',r.worktree_commit,'baseSha',w.base_sha,'dependencyResultIds',to_jsonb(deps)) INTO source FROM collab.snapshots s JOIN collab.workspaces w ON w.id=s.workspace_id WHERE s.id=r.snapshot_id;
  sources:=sources||jsonb_build_array(source); emitted:=array_append(emitted,r.id); remaining:=array_remove(remaining,r.id);
 END LOOP;
 INSERT INTO collab.integrations(id,organization_id,project_id,repository_id,target_branch,target_sha,profile_id,root_result_ids,sources,input_hash,requested_by,organization_version,project_version,idempotency_key)
 VALUES(candidate,repo.organization_id,repo.project_id,repository,repo.default_branch,target,profile,roots,sources,
 encode(sha256(convert_to(jsonb_build_object('repositoryId',repository,'targetBranch',repo.default_branch,'targetSha',target,'profileId',profile,'config',config,'sources',sources)::text,'UTF8')),'hex'),
 collab.actor(),(SELECT authorization_version FROM collab.memberships WHERE organization_id=repo.organization_id AND user_id=collab.actor()),(SELECT authorization_version FROM collab.project_memberships WHERE project_id=repo.project_id AND user_id=collab.actor()),request_key);
 INSERT INTO collab.integration_sources SELECT repo.organization_id,repo.project_id,candidate,(value->>'taskId')::uuid,(value->>'resultId')::uuid,ordinality FROM jsonb_array_elements(sources) WITH ORDINALITY;
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(repo.organization_id,repo.project_id,collab.actor(),'integration.queued',candidate::text,jsonb_build_object('roots',roots,'targetSha',target,'profileId',profile));
 RETURN jsonb_build_object('integrationId',candidate,'status','queued','replayed',false);
END $$;


CREATE OR REPLACE FUNCTION collab_worker.pending_snapshots_with_results() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT COALESCE(jsonb_agg(item||jsonb_build_object('dependencies',collab_worker.dependency_pins((item->>'runId')::uuid))),'[]'::jsonb)
 FROM jsonb_array_elements(collab_worker.pending_snapshots_v1()) item
 WHERE NOT EXISTS(SELECT 1 FROM collab.run_contracts WHERE run_id=(item->>'runId')::uuid) AND NOT collab_worker.requires_resolution_protocol((item->>'runId')::uuid)
$$;

CREATE FUNCTION collab_worker.claim_integration_compatible(executor uuid, resolutions_supported boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i collab.integrations; outcome text;
BEGIN
 IF executor IS NULL THEN RAISE EXCEPTION 'invalid_integration' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(82467116);
 FOR i IN SELECT * FROM collab.integrations WHERE status IN ('queued','integrating','checking') ORDER BY created_at,id LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended(i.organization_id::text,811)); SELECT * INTO STRICT i FROM collab.integrations WHERE id=i.id FOR UPDATE;
  outcome:=NULL;
  IF i.status IN ('integrating','checking') AND i.lease_expires_at<=clock_timestamp() THEN outcome:='unknown';
  ELSIF i.status='queued' AND NOT collab_worker.integration_authorized(i.id) THEN outcome:='revoked';
  ELSIF i.status='queued' AND NOT collab_worker.integration_current(i.id) THEN outcome:='stale'; END IF;
  IF outcome IS NOT NULL THEN UPDATE collab.integrations SET status=outcome,error_code='integration_'||outcome,finished_at=now() WHERE id=i.id; END IF;
 END LOOP;
 SELECT * INTO i FROM collab.integrations q WHERE q.status='queued' AND (resolutions_supported OR NOT EXISTS(SELECT 1 FROM collab.integration_sources s JOIN collab.task_results r ON r.id=s.result_id JOIN collab.resolution_tasks rt ON rt.task_id=r.task_id WHERE s.integration_id=q.id))
 AND NOT EXISTS(SELECT 1 FROM collab.integrations busy WHERE busy.repository_id=q.repository_id AND busy.target_branch=q.target_branch AND busy.status IN ('integrating','checking','unknown'))
 AND NOT EXISTS(SELECT 1 FROM collab.integrations earlier WHERE earlier.repository_id=q.repository_id AND earlier.target_branch=q.target_branch AND earlier.status='queued' AND (earlier.created_at,earlier.id)<(q.created_at,q.id))
 ORDER BY q.created_at,q.id LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 UPDATE collab.integrations SET status='integrating',executor_id=executor,epoch=epoch+1,lease_expires_at=clock_timestamp()+interval '30 seconds',started_at=now() WHERE id=i.id RETURNING * INTO i;
 RETURN (SELECT jsonb_build_object('id',i.id,'executorId',executor,'epoch',i.epoch::text,'repositoryId',i.repository_id,'targetBranch',i.target_branch,'targetSha',i.target_sha,'inputHash',i.input_hash,'profileId',i.profile_id,'checkId',i.check_id,'config',p.config,'sources',i.sources) FROM collab.validation_profiles p WHERE p.id=i.profile_id);
END $$;
CREATE OR REPLACE FUNCTION collab_worker.claim_integration(executor uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT collab_worker.claim_integration_compatible(executor,false)
$$;
CREATE FUNCTION collab_worker.claim_integration_with_resolutions(executor uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT collab_worker.claim_integration_compatible(executor,true)
$$;
-- Kernels are private; only compatibility adapters are executor capabilities.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA collab_worker FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab_worker.claim_resolution_aware(uuid,text),collab_worker.claim_validation_with_resolutions(uuid),collab_worker.pending_snapshots_with_resolutions() TO pi_collab_executor;
GRANT EXECUTE ON FUNCTION collab_worker.claim_integration_with_resolutions(uuid) TO pi_collab_executor;
