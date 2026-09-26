-- Human approvals are distinct from AI-authored project data.
ALTER TABLE collab.tasks ADD COLUMN ownership_version bigint NOT NULL DEFAULT 1;
CREATE FUNCTION collab.track_task_owner() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='INSERT' THEN NEW.ownership_version:=1;
  ELSIF NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN NEW.ownership_version:=OLD.ownership_version+1; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER task_owner_generation BEFORE INSERT OR UPDATE OF owner_id ON collab.tasks FOR EACH ROW EXECUTE FUNCTION collab.track_task_owner();
REVOKE ALL ON FUNCTION collab.track_task_owner() FROM PUBLIC;

CREATE TABLE collab.contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, project_id uuid NOT NULL, repository_id uuid NOT NULL,
  producer_task_id uuid NOT NULL, key text NOT NULL CHECK(key ~ '^[a-z0-9][a-z0-9._-]{0,79}$'), current_revision_id uuid, version integer NOT NULL DEFAULT 0,
  UNIQUE(repository_id,key), UNIQUE(organization_id,project_id,id),
  FOREIGN KEY(organization_id,project_id,repository_id) REFERENCES collab.repositories(organization_id,project_id,id),
  FOREIGN KEY(organization_id,project_id,producer_task_id) REFERENCES collab.tasks(organization_id,project_id,id)
);
CREATE TABLE collab.contract_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, project_id uuid NOT NULL, contract_id uuid NOT NULL,
  parent_revision_id uuid, content jsonb NOT NULL, extra_tasks uuid[] NOT NULL,
  proposed_by text NOT NULL REFERENCES public."user"(id), idempotency_key uuid NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(contract_id,proposed_by,idempotency_key), UNIQUE(organization_id,project_id,id), UNIQUE(organization_id,project_id,contract_id,id),
  FOREIGN KEY(organization_id,project_id,contract_id) REFERENCES collab.contracts(organization_id,project_id,id)
);
CREATE TABLE collab.contract_proposal_tasks (
  organization_id uuid NOT NULL, project_id uuid NOT NULL, proposal_id uuid NOT NULL, task_id uuid NOT NULL,
  PRIMARY KEY(proposal_id,task_id),
  FOREIGN KEY(organization_id,project_id,proposal_id) REFERENCES collab.contract_proposals(organization_id,project_id,id),
  FOREIGN KEY(organization_id,project_id,task_id) REFERENCES collab.tasks(organization_id,project_id,id)
);
CREATE TABLE collab.contract_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, project_id uuid NOT NULL, proposal_id uuid NOT NULL, task_id uuid NOT NULL,
  version integer NOT NULL, decision text NOT NULL CHECK(decision IN ('approve','reject')), note text NOT NULL CHECK(length(note) BETWEEN 1 AND 2000),
  decided_by text NOT NULL REFERENCES public."user"(id), ownership_version bigint NOT NULL, organization_version bigint NOT NULL, project_version bigint NOT NULL,
  idempotency_key uuid NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(proposal_id,task_id,version), UNIQUE(proposal_id,task_id,decided_by,idempotency_key),
  FOREIGN KEY(proposal_id,task_id) REFERENCES collab.contract_proposal_tasks(proposal_id,task_id),
  FOREIGN KEY(organization_id,project_id,proposal_id) REFERENCES collab.contract_proposals(organization_id,project_id,id),
  FOREIGN KEY(organization_id,project_id,task_id) REFERENCES collab.tasks(organization_id,project_id,id)
);
CREATE TABLE collab.contract_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, project_id uuid NOT NULL, contract_id uuid NOT NULL, proposal_id uuid NOT NULL UNIQUE,
  version integer NOT NULL, body text NOT NULL, body_hash text NOT NULL CHECK(body_hash=encode(sha256(convert_to(body,'UTF8')),'hex')),
  approvals jsonb NOT NULL, overridden_tasks uuid[] NOT NULL, override_reason text,
  published_by text NOT NULL REFERENCES public."user"(id), idempotency_key uuid NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(contract_id,version), UNIQUE(contract_id,published_by,idempotency_key), UNIQUE(organization_id,project_id,contract_id,id),
  FOREIGN KEY(organization_id,project_id,contract_id,proposal_id) REFERENCES collab.contract_proposals(organization_id,project_id,contract_id,id)
);
ALTER TABLE collab.contracts ADD CONSTRAINT contract_current_scope FOREIGN KEY(organization_id,project_id,id,current_revision_id) REFERENCES collab.contract_revisions(organization_id,project_id,contract_id,id);
ALTER TABLE collab.contract_proposals ADD CONSTRAINT proposal_parent_scope FOREIGN KEY(organization_id,project_id,contract_id,parent_revision_id) REFERENCES collab.contract_revisions(organization_id,project_id,contract_id,id);
CREATE TABLE collab.task_contracts (
  organization_id uuid NOT NULL, project_id uuid NOT NULL, task_id uuid NOT NULL, contract_id uuid NOT NULL,
  PRIMARY KEY(task_id,contract_id),
  FOREIGN KEY(organization_id,project_id,task_id) REFERENCES collab.tasks(organization_id,project_id,id),
  FOREIGN KEY(organization_id,project_id,contract_id) REFERENCES collab.contracts(organization_id,project_id,id)
);
CREATE TABLE collab.run_contracts (
  organization_id uuid NOT NULL, project_id uuid NOT NULL, run_id uuid NOT NULL, contract_id uuid NOT NULL, revision_id uuid NOT NULL,
  PRIMARY KEY(run_id,contract_id),
  FOREIGN KEY(organization_id,project_id,run_id) REFERENCES collab.runs(organization_id,project_id,id),
  FOREIGN KEY(organization_id,project_id,contract_id,revision_id) REFERENCES collab.contract_revisions(organization_id,project_id,contract_id,id)
);
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['contracts','contract_proposals','contract_proposal_tasks','contract_decisions','contract_revisions','task_contracts','run_contracts'] LOOP
    EXECUTE format('ALTER TABLE collab.%I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('CREATE POLICY scoped_read ON collab.%I FOR SELECT USING(collab.project_role(project_id) IS NOT NULL)',name);
    EXECUTE format('GRANT SELECT ON collab.%I TO pi_collab_app',name);
  END LOOP;
END $$;

CREATE FUNCTION collab_worker.contract_requirements(task uuid) RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  WITH RECURSIVE ancestors(id) AS (SELECT task UNION SELECT d.depends_on FROM collab.task_dependencies d JOIN ancestors a ON d.task_id=a.id)
  SELECT DISTINCT tc.contract_id FROM ancestors a JOIN collab.task_contracts tc ON tc.task_id=a.id
$$;
CREATE FUNCTION collab_worker.contract_impact(contract uuid, extra uuid[]) RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  WITH RECURSIVE affected(id) AS (
    SELECT producer_task_id FROM collab.contracts WHERE id=contract
    UNION SELECT d.task_id FROM collab.task_dependencies d JOIN affected a ON d.depends_on=a.id
  ), seeds(id) AS (SELECT id FROM affected UNION SELECT task_id FROM collab.task_contracts WHERE contract_id=contract UNION SELECT unnest(extra)),
  closure(id) AS (SELECT id FROM seeds UNION SELECT d.task_id FROM collab.task_dependencies d JOIN closure a ON d.depends_on=a.id)
  SELECT COALESCE(array_agg(id ORDER BY id),'{}'::uuid[]) FROM closure
$$;
CREATE FUNCTION collab.propose_contract(task uuid, repository uuid, contract_key text, parent uuid, content jsonb, extra uuid[], request_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t collab.tasks; c collab.contracts; prior collab.contract_proposals; role text; affected uuid[]; request jsonb; proposal uuid:=gen_random_uuid(); field text;
BEGIN
  SELECT * INTO t FROM collab.tasks WHERE id=task;
  IF t.id IS NULL OR collab.project_role(t.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(t.organization_id::text,811));
  SELECT * INTO STRICT t FROM collab.tasks WHERE id=task;
  role:=collab.project_role(t.project_id);
  IF role IS NULL OR role NOT IN ('maintainer','developer') OR (role<>'maintainer' AND t.owner_id<>collab.actor()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
  IF collab.user_requires_mfa(collab.actor()) AND NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
  IF NOT EXISTS(SELECT 1 FROM collab.repositories WHERE id=repository AND project_id=t.project_id) THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
  IF request_key IS NULL OR contract_key IS NULL OR contract_key !~ '^[a-z0-9][a-z0-9._-]{0,79}$' OR content IS NULL OR jsonb_typeof(content)<>'object' OR pg_column_size(content)>49152 OR extra IS NULL OR cardinality(extra)>128
    OR NOT content ?& ARRAY['title','format','definition','compatibility','migrationGuide','mockJson'] OR (content-ARRAY['title','format','definition','compatibility','migrationGuide','mockJson'])<>'{}'::jsonb THEN RAISE EXCEPTION 'invalid_contract' USING ERRCODE='P0001'; END IF;
  FOREACH field IN ARRAY ARRAY['title','format','definition','compatibility','migrationGuide'] LOOP
    IF jsonb_typeof(content->field)<>'string' THEN RAISE EXCEPTION 'invalid_contract' USING ERRCODE='P0001'; END IF;
  END LOOP;
  IF length(btrim(content->>'title')) NOT BETWEEN 1 AND 120 OR length(btrim(content->>'definition')) NOT BETWEEN 1 AND 20000
    OR length(content->>'migrationGuide')>4000 OR content->>'format' NOT IN ('text','json-schema','openapi')
    OR content->>'compatibility' NOT IN ('initial','compatible','breaking') OR jsonb_typeof(content->'mockJson') NOT IN ('null','string')
    OR length(content->>'mockJson')>8000 OR (content->>'compatibility'='breaking' AND length(btrim(content->>'migrationGuide'))<10) THEN RAISE EXCEPTION 'invalid_contract' USING ERRCODE='P0001'; END IF;
  BEGIN
    IF content->>'format'<>'text' AND jsonb_typeof((content->>'definition')::jsonb)<>'object' THEN RAISE EXCEPTION 'invalid_contract'; END IF;
    IF content->>'mockJson' IS NOT NULL THEN PERFORM (content->>'mockJson')::jsonb; END IF;
  EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'invalid_contract' USING ERRCODE='P0001'; END;
  IF EXISTS(SELECT 1 FROM unnest(extra) extras(task_id) WHERE extras.task_id IS NULL OR NOT EXISTS(SELECT 1 FROM collab.tasks target WHERE target.id=extras.task_id AND target.project_id=t.project_id)) THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
  SELECT COALESCE(array_agg(DISTINCT id ORDER BY id),'{}'::uuid[]) INTO extra FROM unnest(extra) id;
  SELECT * INTO c FROM collab.contracts WHERE repository_id=repository AND key=contract_key;
  IF c.id IS NULL THEN
    IF parent IS NOT NULL THEN RAISE EXCEPTION 'stale_contract' USING ERRCODE='P0001'; END IF;
    INSERT INTO collab.contracts(organization_id,project_id,repository_id,producer_task_id,key) VALUES(t.organization_id,t.project_id,repository,task,contract_key) RETURNING * INTO c;
  ELSIF c.producer_task_id<>task THEN RAISE EXCEPTION 'contract_owner_mismatch' USING ERRCODE='P0001'; END IF;
  request:=jsonb_build_object('parent',parent,'content',content,'extra',extra);
  SELECT * INTO prior FROM collab.contract_proposals WHERE contract_id=c.id AND proposed_by=collab.actor() AND idempotency_key=request_key;
  IF FOUND THEN
    IF prior.payload<>request THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
    RETURN jsonb_build_object('proposalId',prior.id,'contractId',c.id,'replayed',true);
  END IF;
  IF c.current_revision_id IS DISTINCT FROM parent THEN RAISE EXCEPTION 'stale_contract' USING ERRCODE='P0001'; END IF;
  IF (parent IS NULL) IS DISTINCT FROM (content->>'compatibility'='initial') THEN RAISE EXCEPTION 'invalid_contract' USING ERRCODE='P0001'; END IF;
  affected:=collab_worker.contract_impact(c.id,extra);
  IF cardinality(affected)>128 THEN RAISE EXCEPTION 'contract_limit' USING ERRCODE='P0001'; END IF;
  INSERT INTO collab.contract_proposals(id,organization_id,project_id,contract_id,parent_revision_id,content,extra_tasks,proposed_by,idempotency_key,payload)
    VALUES(proposal,t.organization_id,t.project_id,c.id,parent,content,extra,collab.actor(),request_key,request);
  INSERT INTO collab.contract_proposal_tasks SELECT t.organization_id,t.project_id,proposal,id FROM unnest(affected) id;
  INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(t.organization_id,t.project_id,collab.actor(),'contract.proposed',proposal::text,jsonb_build_object('contractId',c.id,'affectedTasks',affected));
  RETURN jsonb_build_object('proposalId',proposal,'contractId',c.id,'replayed',false);
END
$$;

CREATE FUNCTION collab.decide_contract(proposal uuid, task uuid, expected_version integer, decision text, note text, request_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab.contract_proposals; t collab.tasks; prior collab.contract_decisions; ordinal integer; result uuid:=gen_random_uuid(); request jsonb; role text;
BEGIN
  SELECT * INTO p FROM collab.contract_proposals WHERE id=proposal;
  IF p.id IS NULL OR collab.project_role(p.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p.organization_id::text,811));
  SELECT * INTO t FROM collab.tasks WHERE id=task AND EXISTS(SELECT 1 FROM collab.contract_proposal_tasks WHERE proposal_id=proposal AND task_id=task);
  IF t.id IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
  role:=collab.project_role(p.project_id);
  IF role IS NULL OR role NOT IN ('maintainer','developer') OR t.owner_id<>collab.actor() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
  IF collab.user_requires_mfa(collab.actor()) AND NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
  IF request_key IS NULL OR expected_version IS NULL OR expected_version<0 OR decision IS NULL OR decision NOT IN ('approve','reject') OR note IS NULL OR length(btrim(note)) NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'invalid_contract' USING ERRCODE='P0001'; END IF;
  request:=jsonb_build_object('expectedVersion',expected_version,'decision',decision,'note',btrim(note));
  SELECT * INTO prior FROM collab.contract_decisions WHERE proposal_id=proposal AND task_id=task AND decided_by=collab.actor() AND idempotency_key=request_key;
  IF FOUND THEN
    IF prior.payload<>request THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
    RETURN jsonb_build_object('decisionId',prior.id,'version',prior.version,'replayed',true);
  END IF;
  IF EXISTS(SELECT 1 FROM collab.contract_revisions WHERE proposal_id=proposal) OR NOT EXISTS(SELECT 1 FROM collab.contracts WHERE id=p.contract_id AND current_revision_id IS NOT DISTINCT FROM p.parent_revision_id) THEN RAISE EXCEPTION 'stale_contract' USING ERRCODE='P0001'; END IF;
  SELECT COALESCE(max(version),0) INTO ordinal FROM collab.contract_decisions WHERE proposal_id=proposal AND task_id=task;
  IF ordinal<>expected_version THEN RAISE EXCEPTION 'stale_revision' USING ERRCODE='P0001'; END IF;
  INSERT INTO collab.contract_decisions(id,organization_id,project_id,proposal_id,task_id,version,decision,note,decided_by,ownership_version,organization_version,project_version,idempotency_key,payload)
    SELECT result,p.organization_id,p.project_id,proposal,task,ordinal+1,decision,btrim(note),collab.actor(),t.ownership_version,m.authorization_version,pm.authorization_version,request_key,request
    FROM collab.memberships m JOIN collab.project_memberships pm ON pm.organization_id=m.organization_id AND pm.user_id=m.user_id WHERE m.organization_id=p.organization_id AND m.user_id=collab.actor() AND pm.project_id=p.project_id;
  INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(p.organization_id,p.project_id,collab.actor(),'contract.decided',result::text,jsonb_build_object('proposalId',proposal,'taskId',task,'decision',decision));
  RETURN jsonb_build_object('decisionId',result,'version',ordinal+1,'replayed',false);
END
$$;

CREATE FUNCTION collab_worker.contract_approvals(proposal uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('taskId',t.id,'ownerId',t.owner_id,'decisionId',d.id,'version',COALESCE(d.version,0),'decision',d.decision,'note',d.note,'decidedBy',d.decided_by,
    'approved',COALESCE(d.decision='approve' AND t.owner_id=d.decided_by AND t.ownership_version=d.ownership_version AND m.active AND pm.active AND pm.role IN ('developer','maintainer') AND m.authorization_version=d.organization_version AND pm.authorization_version=d.project_version AND (m.role='member' OR u."twoFactorEnabled"),false)) ORDER BY t.id),'[]'::jsonb)
  FROM collab.contract_proposal_tasks pt JOIN collab.tasks t ON t.id=pt.task_id
  LEFT JOIN LATERAL (SELECT * FROM collab.contract_decisions WHERE proposal_id=proposal AND task_id=t.id ORDER BY version DESC LIMIT 1) d ON true
  LEFT JOIN collab.memberships m ON m.organization_id=t.organization_id AND m.user_id=d.decided_by
  LEFT JOIN collab.project_memberships pm ON pm.project_id=t.project_id AND pm.user_id=d.decided_by LEFT JOIN public."user" u ON u.id=d.decided_by WHERE pt.proposal_id=proposal
$$;
CREATE FUNCTION collab.contract_approvals(proposal uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT collab_worker.contract_approvals(proposal) WHERE EXISTS(SELECT 1 FROM collab.contract_proposals p WHERE p.id=proposal AND collab.project_role(p.project_id) IS NOT NULL)
$$;
CREATE FUNCTION collab.publish_contract(proposal uuid, request_key uuid, override_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab.contract_proposals; c collab.contracts; t collab.tasks; prior collab.contract_revisions; role text; request jsonb; affected uuid[]; expected uuid[]; missing uuid[]; approvals jsonb; result uuid:=gen_random_uuid(); r collab.runs;
BEGIN
  SELECT * INTO p FROM collab.contract_proposals WHERE id=proposal;
  IF p.id IS NULL OR collab.project_role(p.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p.organization_id::text,811));
  SELECT * INTO STRICT c FROM collab.contracts WHERE id=p.contract_id FOR UPDATE;
  SELECT * INTO STRICT t FROM collab.tasks WHERE id=c.producer_task_id;
  role:=collab.project_role(p.project_id);
  IF role IS NULL OR role NOT IN ('maintainer','developer') OR (role<>'maintainer' AND t.owner_id<>collab.actor()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
  IF collab.user_requires_mfa(collab.actor()) AND NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
  IF request_key IS NULL OR (override_reason IS NOT NULL AND length(btrim(override_reason)) NOT BETWEEN 10 AND 2000) THEN RAISE EXCEPTION 'invalid_contract' USING ERRCODE='P0001'; END IF;
  IF override_reason IS NOT NULL AND role<>'maintainer' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
  request:=jsonb_build_object('proposalId',proposal,'overrideReason',CASE WHEN override_reason IS NOT NULL THEN btrim(override_reason) END);
  SELECT * INTO prior FROM collab.contract_revisions WHERE contract_id=c.id AND published_by=collab.actor() AND idempotency_key=request_key;
  IF FOUND THEN
    IF prior.payload<>request THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
    RETURN jsonb_build_object('revisionId',prior.id,'version',prior.version,'replayed',true);
  END IF;
  IF c.current_revision_id IS DISTINCT FROM p.parent_revision_id OR EXISTS(SELECT 1 FROM collab.contract_revisions WHERE proposal_id=proposal) THEN RAISE EXCEPTION 'stale_contract' USING ERRCODE='P0001'; END IF;
  affected:=collab_worker.contract_impact(c.id,p.extra_tasks);
  SELECT array_agg(task_id ORDER BY task_id) INTO expected FROM collab.contract_proposal_tasks WHERE proposal_id=proposal;
  IF affected IS DISTINCT FROM expected THEN RAISE EXCEPTION 'contract_scope_changed' USING ERRCODE='P0001'; END IF;
  IF EXISTS(SELECT 1 FROM unnest(affected) task WHERE (SELECT count(*) FROM (SELECT collab_worker.contract_requirements(task) UNION SELECT c.id) requirements)>32) THEN RAISE EXCEPTION 'contract_limit' USING ERRCODE='P0001'; END IF;
  approvals:=collab_worker.contract_approvals(proposal);
  SELECT COALESCE(array_agg((item->>'taskId')::uuid),'{}'::uuid[]) INTO missing FROM jsonb_array_elements(approvals) item WHERE NOT (item->>'approved')::boolean;
  IF cardinality(missing)>0 AND override_reason IS NULL THEN RAISE EXCEPTION 'contract_confirmation_required' USING ERRCODE='P0001'; END IF;
  INSERT INTO collab.contract_revisions(id,organization_id,project_id,contract_id,proposal_id,version,body,body_hash,approvals,overridden_tasks,override_reason,published_by,idempotency_key,payload)
    VALUES(result,p.organization_id,p.project_id,c.id,proposal,c.version+1,p.content::text,encode(sha256(convert_to(p.content::text,'UTF8')),'hex'),approvals,missing,btrim(override_reason),collab.actor(),request_key,request);
  UPDATE collab.contracts SET current_revision_id=result,version=version+1 WHERE id=c.id;
  INSERT INTO collab.task_contracts SELECT p.organization_id,p.project_id,id,c.id FROM unnest(affected) id ON CONFLICT DO NOTHING;
  UPDATE collab.tasks SET version=version+1,updated_at=now() WHERE id=ANY(affected);
  INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(p.organization_id,p.project_id,collab.actor(),'contract.published',result::text,jsonb_build_object('contractId',c.id,'version',c.version+1,'overriddenTasks',missing,'overrideReason',btrim(override_reason)));
  FOR r IN SELECT * FROM collab.runs WHERE task_id=ANY(affected) AND status IN ('queued','starting','running','waiting_input','stopping','reconciling') ORDER BY id LOOP
    PERFORM collab_worker.emit(r.id,'contract.published',jsonb_build_object('contractId',c.id,'revisionId',result));
  END LOOP;
  RETURN jsonb_build_object('revisionId',result,'version',c.version+1,'replayed',false);
END
$$;

CREATE FUNCTION collab_worker.contract_pins(run uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('contractId',c.id,'key',c.key,'revisionId',v.id,'version',v.version,'body',v.body,'bodyHash',v.body_hash) ORDER BY c.id),'[]'::jsonb)
    FROM collab.run_contracts rc JOIN collab.contracts c ON c.id=rc.contract_id JOIN collab.contract_revisions v ON v.id=rc.revision_id WHERE rc.run_id=run
$$;
CREATE FUNCTION collab_worker.contracts_current(run uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT NOT EXISTS(
    SELECT 1 FROM collab_worker.contract_requirements((SELECT task_id FROM collab.runs WHERE id=run)) required
      JOIN collab.contracts c ON c.id=required LEFT JOIN collab.run_contracts rc ON rc.run_id=run AND rc.contract_id=c.id WHERE rc.revision_id IS DISTINCT FROM c.current_revision_id
  ) AND NOT EXISTS(SELECT 1 FROM collab.run_contracts rc JOIN collab.contracts c ON c.id=rc.contract_id WHERE rc.run_id=run AND rc.revision_id IS DISTINCT FROM c.current_revision_id)
$$;
CREATE OR REPLACE FUNCTION collab_worker.dependencies_current(run uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  WITH RECURSIVE lineage(id) AS (
    SELECT run UNION SELECT result.source_run_id FROM lineage l JOIN collab.run_dependencies d ON d.run_id=l.id JOIN collab.task_results result ON result.id=d.result_id
  ) SELECT NOT EXISTS(SELECT 1 FROM lineage l JOIN collab.runs r ON r.id=l.id JOIN collab.tasks t ON t.id=r.task_id
    WHERE NOT r.dependency_protocol OR r.dependency_version IS DISTINCT FROM t.dependency_version OR NOT collab_worker.contracts_current(r.id)
      OR EXISTS(SELECT 1 FROM collab.run_dependencies d JOIN collab.tasks upstream ON upstream.id=d.depends_on
        WHERE d.run_id=r.id AND (d.result_id IS NULL OR d.result_id IS DISTINCT FROM upstream.current_result_id OR EXISTS(SELECT 1 FROM collab.result_withdrawals WHERE result_id=d.result_id))))
$$;
ALTER FUNCTION collab.submit_run(uuid,uuid,text,text,text,uuid,integer,uuid,uuid) RENAME TO submit_run_results_v1;
REVOKE EXECUTE ON FUNCTION collab.submit_run_results_v1(uuid,uuid,text,text,text,uuid,integer,uuid,uuid) FROM pi_collab_app;
CREATE FUNCTION collab.submit_run(task uuid, repository uuid, base text, message text, runtime_mode text, request_key uuid, expected_version integer, model_profile uuid, snapshot uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE accepted jsonb; r collab.runs;
BEGIN
  accepted:=collab.submit_run_results_v1(task,repository,base,message,runtime_mode,request_key,expected_version,model_profile,snapshot);
  IF NOT (accepted->>'replayed')::boolean THEN
    SELECT * INTO STRICT r FROM collab.runs WHERE id=(accepted->>'runId')::uuid;
    IF (SELECT count(*) FROM collab_worker.contract_requirements(task))>32 THEN RAISE EXCEPTION 'contract_limit' USING ERRCODE='P0001'; END IF;
    IF runtime_mode<>'native' AND EXISTS(SELECT 1 FROM collab_worker.contract_requirements(task)) THEN RAISE EXCEPTION 'contract_runtime_unsupported' USING ERRCODE='P0001'; END IF;
    INSERT INTO collab.run_contracts SELECT r.organization_id,r.project_id,r.id,c.id,c.current_revision_id FROM collab.contracts c WHERE c.id IN (SELECT collab_worker.contract_requirements(task));
  END IF;
  RETURN accepted;
END
$$;
ALTER FUNCTION collab.publish_task_result(uuid,uuid,integer,uuid,text) RENAME TO publish_task_result_inputs_v1;
REVOKE EXECUTE ON FUNCTION collab.publish_task_result_inputs_v1(uuid,uuid,integer,uuid,text) FROM pi_collab_app;
CREATE FUNCTION collab.publish_task_result(task uuid, validation uuid, expected_version integer, request_key uuid, note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE accepted jsonb;
BEGIN
  accepted:=collab.publish_task_result_inputs_v1(task,validation,expected_version,request_key,note);
  IF NOT (accepted->>'replayed')::boolean AND EXISTS(SELECT 1 FROM collab.validations v JOIN collab.snapshots s ON s.id=v.snapshot_id WHERE v.id=validation AND COALESCE(v.evidence->'contracts','[]'::jsonb) IS DISTINCT FROM collab_worker.contract_pins(s.run_id)) THEN RAISE EXCEPTION 'result_validation_unavailable' USING ERRCODE='P0001'; END IF;
  RETURN accepted;
END
$$;

REVOKE ALL ON FUNCTION collab_worker.contract_requirements(uuid),collab_worker.contract_impact(uuid,uuid[]),collab_worker.contract_approvals(uuid),collab_worker.contract_pins(uuid),collab_worker.contracts_current(uuid),collab.propose_contract(uuid,uuid,text,uuid,jsonb,uuid[],uuid),collab.decide_contract(uuid,uuid,integer,text,text,uuid),collab.contract_approvals(uuid),collab.publish_contract(uuid,uuid,text),collab.submit_run(uuid,uuid,text,text,text,uuid,integer,uuid,uuid),collab.publish_task_result(uuid,uuid,integer,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.propose_contract(uuid,uuid,text,uuid,jsonb,uuid[],uuid),collab.decide_contract(uuid,uuid,integer,text,text,uuid),collab.contract_approvals(uuid),collab.publish_contract(uuid,uuid,text),collab.submit_run(uuid,uuid,text,text,text,uuid,integer,uuid,uuid),collab.publish_task_result(uuid,uuid,integer,uuid,text) TO pi_collab_app;

-- Version-aware dispatch preserves older workers for jobs without contract inputs.
CREATE FUNCTION collab_worker.claim_with_contracts(executor uuid, runtime_mode text, results_supported boolean, snapshots_supported boolean, contracts_supported boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
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
  RETURN jsonb_build_object('run',to_jsonb(r)||jsonb_build_object('epoch',r.epoch::text),'workspace',to_jsonb(w)||jsonb_build_object('epoch',w.epoch::text),'dependencies',collab_worker.dependency_pins(r.id),'contracts',collab_worker.contract_pins(r.id));
END
$$;
CREATE FUNCTION collab_worker.claim_validation_inputs(executor uuid, result_inputs_supported boolean, contract_inputs_supported boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
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
  RETURN (SELECT jsonb_build_object('id',v.id,'executorId',executor,'epoch',v.epoch::text,'snapshotId',v.snapshot_id,'manifestHash',v.manifest_hash,'profileId',v.profile_id,'repositoryId',p.repository_id,'config',p.config) FROM collab.validation_profiles p WHERE p.id=v.profile_id);
END
$$;
CREATE OR REPLACE FUNCTION collab_worker.claim_with_results(executor uuid, runtime_mode text, results_supported boolean, snapshots_supported boolean) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT collab_worker.claim_with_contracts(executor,runtime_mode,results_supported,snapshots_supported,false)
$$;
CREATE FUNCTION collab_worker.claim_contract_aware(executor uuid, runtime_mode text) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT collab_worker.claim_with_contracts(executor,runtime_mode,true,true,true)
$$;
CREATE OR REPLACE FUNCTION collab_worker.claim_validation_compatible(executor uuid, result_inputs_supported boolean) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT collab_worker.claim_validation_inputs(executor,result_inputs_supported,false)
$$;
CREATE FUNCTION collab_worker.claim_validation_with_contracts(executor uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT collab_worker.claim_validation_inputs(executor,true,true)
$$;
CREATE OR REPLACE FUNCTION collab_worker.pending_snapshots() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT COALESCE(jsonb_agg(item),'[]'::jsonb) FROM jsonb_array_elements(collab_worker.pending_snapshots_v1()) item
  WHERE NOT EXISTS(SELECT 1 FROM collab.run_dependencies WHERE run_id=(item->>'runId')::uuid) AND NOT EXISTS(SELECT 1 FROM collab.run_contracts WHERE run_id=(item->>'runId')::uuid)
$$;
CREATE OR REPLACE FUNCTION collab_worker.pending_snapshots_with_results() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT COALESCE(jsonb_agg(item||jsonb_build_object('dependencies',collab_worker.dependency_pins((item->>'runId')::uuid))),'[]'::jsonb)
  FROM jsonb_array_elements(collab_worker.pending_snapshots_v1()) item WHERE NOT EXISTS(SELECT 1 FROM collab.run_contracts WHERE run_id=(item->>'runId')::uuid)
$$;
CREATE FUNCTION collab_worker.pending_snapshots_with_contracts() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT COALESCE(jsonb_agg(item||jsonb_build_object('dependencies',collab_worker.dependency_pins((item->>'runId')::uuid),'contracts',collab_worker.contract_pins((item->>'runId')::uuid))),'[]'::jsonb)
  FROM jsonb_array_elements(collab_worker.pending_snapshots_v1()) item
$$;
CREATE FUNCTION collab.required_contracts(task uuid) RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT collab_worker.contract_requirements(task) WHERE EXISTS(SELECT 1 FROM collab.tasks WHERE id=task AND collab.project_role(project_id) IS NOT NULL)
$$;
REVOKE ALL ON FUNCTION collab_worker.claim_with_contracts(uuid,text,boolean,boolean,boolean),collab_worker.claim_contract_aware(uuid,text),collab_worker.claim_validation_inputs(uuid,boolean,boolean),collab_worker.claim_validation_with_contracts(uuid),collab_worker.pending_snapshots_with_contracts(),collab.required_contracts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab_worker.claim_contract_aware(uuid,text),collab_worker.claim_validation_with_contracts(uuid),collab_worker.pending_snapshots_with_contracts() TO pi_collab_executor;
GRANT EXECUTE ON FUNCTION collab.required_contracts(uuid) TO pi_collab_app;
