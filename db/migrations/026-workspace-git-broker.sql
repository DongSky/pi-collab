-- Native workspace writes are private Git-service jobs, never Web filesystem writes.
CREATE TABLE collab_git.workspace_operations (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, project_id uuid NOT NULL, task_id uuid NOT NULL,
 run_id uuid NOT NULL, workspace_id uuid NOT NULL, actor_id text NOT NULL REFERENCES public."user"(id),
 organization_version bigint NOT NULL, project_version bigint NOT NULL, task_version integer NOT NULL, run_revision bigint NOT NULL,
 idempotency_key uuid NOT NULL, request jsonb NOT NULL, admission jsonb NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','attention','applied','aborted')),
 mode text NOT NULL DEFAULT 'execute' CHECK(mode IN ('execute','reconcile')),
 operator_id text NOT NULL REFERENCES public."user"(id), operator_org_version bigint NOT NULL, operator_project_version bigint NOT NULL,
 stop_requested boolean NOT NULL DEFAULT false, launch_intent boolean NOT NULL DEFAULT false,
 claim_id uuid, backend_pid integer, gate_txid bigint, gate_kind text,
 effect_request jsonb, acknowledgement jsonb, observation jsonb, failure text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 UNIQUE(run_id,actor_id,idempotency_key),
 FOREIGN KEY(organization_id,project_id,run_id) REFERENCES collab.runs(organization_id,project_id,id),
 FOREIGN KEY(organization_id,project_id,task_id,workspace_id) REFERENCES collab.workspaces(organization_id,project_id,task_id,id)
);
CREATE UNIQUE INDEX workspace_git_one_owner ON collab_git.workspace_operations(workspace_id) WHERE status NOT IN ('applied','aborted');
CREATE TABLE collab_git.workspace_actions (
 operation_id uuid NOT NULL REFERENCES collab_git.workspace_operations(id), actor_id text NOT NULL REFERENCES public."user"(id),
 idempotency_key uuid NOT NULL, kind text NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(operation_id,actor_id,idempotency_key)
);

CREATE FUNCTION collab_git.workspace_authority(task uuid, actor text, org_version bigint DEFAULT NULL, project_version bigint DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM collab.tasks t JOIN collab.memberships m ON m.organization_id=t.organization_id AND m.user_id=actor
 JOIN collab.project_memberships pm ON pm.project_id=t.project_id AND pm.user_id=m.user_id JOIN public."user" u ON u.id=m.user_id
 WHERE t.id=task AND m.active AND pm.active AND pm.role IN ('maintainer','developer') AND (pm.role='maintainer' OR t.owner_id=actor)
 AND (NOT collab.user_requires_mfa(actor) OR u."twoFactorEnabled")
 AND (org_version IS NULL OR m.authorization_version=org_version) AND (project_version IS NULL OR pm.authorization_version=project_version))
$$;
CREATE FUNCTION collab_git.workspace_result(operation uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('jobId',id,'runId',run_id,'kind',request->>'kind','status',status,'mode',mode,'stopRequested',stop_requested,
 'failure',failure,'createdAt',created_at,'finishedAt',finished_at,'actorId',actor_id,
 'effect',CASE WHEN acknowledgement IS NOT NULL THEN jsonb_build_object('phase',acknowledgement->>'phase','commit',effect_request->>'commit') END)
 FROM collab_git.workspace_operations WHERE id=operation
$$;
CREATE FUNCTION collab.workspace_git_operations(run uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM collab.runs WHERE id=run AND collab.project_role(project_id) IS NOT NULL) THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 RETURN (SELECT COALESCE(jsonb_agg(collab_git.workspace_result(id) ORDER BY created_at DESC,id),'[]'::jsonb)
 FROM (SELECT id,created_at FROM collab_git.workspace_operations WHERE run_id=run ORDER BY created_at DESC,id LIMIT 50) jobs);
END $$;
CREATE FUNCTION collab.request_workspace_git(run uuid, request_key uuid, payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab.runs; w collab.workspaces; t collab.tasks; prior collab_git.workspace_operations; operation uuid:=gen_random_uuid();
 ov bigint; pv bigint; item jsonb; fixed jsonb; person text; at_time text;
BEGIN
 SELECT * INTO r FROM collab.runs WHERE id=run;
 IF r.id IS NULL OR collab.project_role(r.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(r.organization_id::text,811));
 PERFORM 1 FROM public."user" WHERE id=collab.actor() FOR SHARE;
 SELECT * INTO STRICT r FROM collab.runs WHERE id=run FOR UPDATE;
 SELECT * INTO STRICT t FROM collab.tasks WHERE id=r.task_id FOR SHARE;
 SELECT * INTO STRICT w FROM collab.workspaces WHERE id=r.workspace_id FOR SHARE;
 IF NOT collab_git.workspace_authority(t.id,collab.actor()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF request_key IS NULL OR payload IS NULL OR jsonb_typeof(payload)<>'object' OR pg_column_size(payload)>65536
 OR COALESCE(payload->>'kind','') NOT IN ('stage','commit') OR payload->'acknowledge' IS DISTINCT FROM 'true'::jsonb
 OR jsonb_typeof(payload->'revision') IS DISTINCT FROM 'string' OR jsonb_typeof(payload->'expectedRunRevision') IS DISTINCT FROM 'string'
 OR COALESCE(payload->>'revision','')!~'^[a-f0-9]{64}$' OR COALESCE(payload->>'expectedRunRevision','')!~'^[1-9][0-9]{0,17}$'
 OR (payload-ARRAY['kind','revision','expectedRunRevision','acknowledge','selections','message'])<>'{}'::jsonb
 THEN RAISE EXCEPTION 'invalid_workspace_git' USING ERRCODE='P0001'; END IF;
 IF payload->>'kind'='stage' THEN
  IF payload ? 'message' OR jsonb_typeof(payload->'selections') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'invalid_workspace_git' USING ERRCODE='P0001'; END IF;
  IF jsonb_array_length(payload->'selections') NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'invalid_workspace_git' USING ERRCODE='P0001'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(payload->'selections') LOOP
   IF jsonb_typeof(item)<>'object' OR (item-ARRAY['path','direction','hunks'])<>'{}'::jsonb OR jsonb_typeof(item->'path') IS DISTINCT FROM 'string'
   OR length(item->>'path') NOT BETWEEN 1 AND 1024 OR item->>'path' ~ '[\\[:cntrl:]:]'
   OR EXISTS(SELECT 1 FROM unnest(string_to_array(item->>'path','/')) part WHERE part IN ('','.','..') OR lower(part)='.git' OR part ~ '[. ]$')
   OR COALESCE(item->>'direction','') NOT IN ('stage','unstage')
   OR (item->'hunks' IS DISTINCT FROM '"file"'::jsonb AND jsonb_typeof(item->'hunks') IS DISTINCT FROM 'array') THEN RAISE EXCEPTION 'invalid_workspace_git' USING ERRCODE='P0001'; END IF;
   IF jsonb_typeof(item->'hunks')='array' THEN
    IF jsonb_array_length(item->'hunks') NOT BETWEEN 1 AND 256 OR EXISTS(SELECT 1 FROM jsonb_array_elements(item->'hunks') h WHERE jsonb_typeof(h)<>'string' OR h#>>'{}'!~'^[a-f0-9]{64}$') THEN RAISE EXCEPTION 'invalid_workspace_git' USING ERRCODE='P0001'; END IF;
   END IF;
  END LOOP;
 ELSE
  IF payload ? 'selections' OR jsonb_typeof(payload->'message') IS DISTINCT FROM 'string' OR length(btrim(payload->>'message')) NOT BETWEEN 1 AND 8000
  OR length(payload->>'message')>8000 OR position(chr(13) IN payload->>'message')>0 THEN RAISE EXCEPTION 'invalid_workspace_git' USING ERRCODE='P0001'; END IF;
 END IF;
 SELECT * INTO prior FROM collab_git.workspace_operations WHERE run_id=run AND actor_id=collab.actor() AND idempotency_key=request_key;
 IF FOUND THEN
  IF prior.request<>payload THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
  RETURN collab_git.workspace_result(prior.id)||jsonb_build_object('replayed',true);
 END IF;
 IF r.revision::text<>payload->>'expectedRunRevision' THEN RAISE EXCEPTION 'stale_revision' USING ERRCODE='P0001'; END IF;
 IF r.status NOT IN ('completed','failed','cancelled') OR w.status<>'stopped' OR w.runtime<>'native' OR r.executor_id IS NULL OR r.epoch<1 THEN RAISE EXCEPTION 'workspace_not_stopped' USING ERRCODE='P0001'; END IF;
 IF EXISTS(SELECT 1 FROM collab_git.workspace_operations WHERE workspace_id=w.id AND status NOT IN ('applied','aborted'))
 OR EXISTS(SELECT 1 FROM collab.snapshots WHERE workspace_id=w.id AND status='pending') THEN RAISE EXCEPTION 'workspace_git_busy' USING ERRCODE='P0001'; END IF;
 IF (SELECT count(*) FROM collab_git.workspace_operations WHERE project_id=r.project_id AND status NOT IN ('applied','aborted'))>=20 THEN RAISE EXCEPTION 'workspace_git_limit' USING ERRCODE='P0001'; END IF;
 SELECT authorization_version INTO ov FROM collab.memberships WHERE organization_id=r.organization_id AND user_id=collab.actor();
 SELECT authorization_version INTO pv FROM collab.project_memberships WHERE project_id=r.project_id AND user_id=collab.actor();
 fixed:=jsonb_build_object('operationId',operation,'kind',payload->>'kind','revision',payload->>'revision',
 'source',jsonb_build_object('workspaceId',w.id,'identity',jsonb_build_object('runId',r.id,'executorId',r.executor_id,'epoch',r.epoch::text)));
 IF payload->>'kind'='stage' THEN fixed:=fixed||jsonb_build_object('selections',payload->'selections');
 ELSE
  -- Member attribution is server-derived. Sanitize display names, never accept author/email from a caller.
  SELECT left(btrim(regexp_replace(name,U&'[<>[:cntrl:]\200b-\200f\2028-\202e\2066-\2069\feff]','','g')),100) INTO person FROM public."user" WHERE id=collab.actor();
  person:=COALESCE(NULLIF(person,''),'Member'); at_time:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  fixed:=fixed||jsonb_build_object('identity',jsonb_build_object('operationId',operation,'actorId',collab.actor(),'displayName',person,'requestedAt',at_time,'message',payload->>'message'));
 END IF;
 INSERT INTO collab_git.workspace_operations(id,organization_id,project_id,task_id,run_id,workspace_id,actor_id,organization_version,project_version,task_version,run_revision,idempotency_key,request,admission,operator_id,operator_org_version,operator_project_version)
 VALUES(operation,r.organization_id,r.project_id,t.id,r.id,w.id,collab.actor(),ov,pv,t.version,r.revision,request_key,payload,fixed,collab.actor(),ov,pv);
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(r.organization_id,r.project_id,collab.actor(),'workspace_git.requested',operation::text,jsonb_build_object('runId',r.id,'kind',payload->>'kind','revision',payload->>'revision'));
 RETURN collab_git.workspace_result(operation)||jsonb_build_object('replayed',false);
END $$;

-- Snapshot publication finishes before Git admission. Duplicate late captures
-- can only read/reuse a ready immutable artifact; failed/revoked jobs cannot publish.
CREATE FUNCTION collab_git.guard_snapshot_workspace() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text,811));
 IF EXISTS(SELECT 1 FROM collab_git.workspace_operations WHERE workspace_id=NEW.workspace_id AND status NOT IN ('applied','aborted')) THEN RAISE EXCEPTION 'workspace_git_busy' USING ERRCODE='P0001'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER snapshot_workspace_git BEFORE INSERT ON collab.snapshots FOR EACH ROW EXECUTE FUNCTION collab_git.guard_snapshot_workspace();

CREATE FUNCTION collab.workspace_git_action(operation uuid, action text, reason text, request_key uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s collab_git.workspace_operations; prior collab_git.workspace_actions; ov bigint; pv bigint;
BEGIN
 SELECT * INTO s FROM collab_git.workspace_operations WHERE id=operation;
 IF s.id IS NULL OR collab.project_role(s.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(s.organization_id::text,811)); PERFORM 1 FROM public."user" WHERE id=collab.actor() FOR SHARE;
 IF NOT collab_git.workspace_authority(s.task_id,collab.actor()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF action IS NULL OR action NOT IN ('cancel','reconcile') OR reason IS NULL OR length(btrim(reason)) NOT BETWEEN 10 AND 2000 OR request_key IS NULL THEN RAISE EXCEPTION 'invalid_workspace_git' USING ERRCODE='P0001'; END IF;
 SELECT * INTO prior FROM collab_git.workspace_actions WHERE operation_id=operation AND actor_id=collab.actor() AND idempotency_key=request_key;
 IF FOUND THEN
  IF prior.kind<>action OR prior.reason<>btrim(reason) THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
  RETURN collab_git.workspace_result(operation)||jsonb_build_object('replayed',true);
 END IF;
 SELECT * INTO STRICT s FROM collab_git.workspace_operations WHERE id=operation FOR UPDATE;
 IF s.status NOT IN ('applied','aborted') THEN
  IF action='cancel' AND s.status IN ('queued','running') THEN
   UPDATE collab_git.workspace_operations SET stop_requested=true,updated_at=now() WHERE id=operation;
  ELSE
   IF NOT pg_try_advisory_xact_lock(hashtextextended(operation::text,918276437)) THEN RAISE EXCEPTION 'workspace_git_busy' USING ERRCODE='P0001'; END IF;
   SELECT authorization_version INTO ov FROM collab.memberships WHERE organization_id=s.organization_id AND user_id=collab.actor();
   SELECT authorization_version INTO pv FROM collab.project_memberships WHERE project_id=s.project_id AND user_id=collab.actor();
   UPDATE collab_git.workspace_operations SET status='queued',mode='reconcile',operator_id=collab.actor(),operator_org_version=ov,operator_project_version=pv,
    stop_requested=true,claim_id=NULL,backend_pid=NULL,gate_txid=NULL,gate_kind=NULL,updated_at=now() WHERE id=operation;
  END IF;
 END IF;
 INSERT INTO collab_git.workspace_actions VALUES(operation,collab.actor(),request_key,action,btrim(reason),now());
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(s.organization_id,s.project_id,collab.actor(),'workspace_git.'||action||'_requested',operation::text,jsonb_build_object('reason',btrim(reason)));
 RETURN collab_git.workspace_result(operation)||jsonb_build_object('replayed',false);
END $$;

CREATE FUNCTION collab_git.claim_workspace() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s collab_git.workspace_operations; nonce uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(918276438);
 FOR s IN SELECT * FROM collab_git.workspace_operations WHERE status IN ('queued','running') ORDER BY updated_at,id LIMIT 100 LOOP
  IF NOT pg_try_advisory_lock(hashtextextended(s.id::text,918276437)) THEN CONTINUE; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(s.organization_id::text,811));
  SELECT * INTO STRICT s FROM collab_git.workspace_operations WHERE id=s.id FOR UPDATE;
  IF s.status='running' THEN
   UPDATE collab_git.workspace_operations SET status='attention',updated_at=now(),failure='workspace_git_broker_lost' WHERE id=s.id;
   INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(s.organization_id,s.project_id,s.operator_id,'workspace_git.broker_lost',s.id::text,'{}');
   PERFORM pg_advisory_unlock(hashtextextended(s.id::text,918276437)); RETURN jsonb_build_object('attentionJob',s.id);
  END IF;
  IF s.status<>'queued' THEN PERFORM pg_advisory_unlock(hashtextextended(s.id::text,918276437)); CONTINUE; END IF;
  nonce:=gen_random_uuid();
  UPDATE collab_git.workspace_operations SET status='running',claim_id=nonce,backend_pid=pg_backend_pid(),gate_txid=NULL,gate_kind=NULL,updated_at=now() WHERE id=s.id;
  RETURN jsonb_build_object('claimId',nonce,'jobId',s.id,'mode',s.mode,'admission',s.admission,'launchIntent',s.launch_intent,'effectRequest',s.effect_request);
 END LOOP;
 RETURN NULL;
END $$;
CREATE FUNCTION collab_git.lock_workspace(operation uuid, nonce uuid) RETURNS collab_git.workspace_operations LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s collab_git.workspace_operations;
BEGIN
 SELECT * INTO s FROM collab_git.workspace_operations WHERE id=operation;
 IF s.id IS NULL OR nonce IS NULL THEN RAISE EXCEPTION 'workspace_git_claim_lost' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(s.organization_id::text,811));
 SELECT * INTO STRICT s FROM collab_git.workspace_operations WHERE id=operation FOR UPDATE;
 IF s.status<>'running' OR s.claim_id IS DISTINCT FROM nonce OR s.backend_pid IS DISTINCT FROM pg_backend_pid() THEN RAISE EXCEPTION 'workspace_git_claim_lost' USING ERRCODE='P0001'; END IF;
 RETURN s;
END $$;
CREATE FUNCTION collab_git.workspace_grant(operation uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT NOT s.stop_requested AND s.mode='execute' AND collab_git.workspace_authority(s.task_id,s.actor_id,s.organization_version,s.project_version)
 AND t.version=s.task_version AND r.revision=s.run_revision AND r.status IN ('completed','failed','cancelled') AND w.status='stopped' AND w.runtime='native'
 AND s.admission->'source'=jsonb_build_object('workspaceId',w.id,'identity',jsonb_build_object('runId',r.id,'executorId',r.executor_id,'epoch',r.epoch::text))
 FROM collab_git.workspace_operations s JOIN collab.tasks t ON t.id=s.task_id JOIN collab.runs r ON r.id=s.run_id JOIN collab.workspaces w ON w.id=s.workspace_id WHERE s.id=operation
$$;
CREATE FUNCTION collab_git.begin_workspace(operation uuid, nonce uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s collab_git.workspace_operations;
BEGIN
 s:=collab_git.lock_workspace(operation,nonce); PERFORM 1 FROM public."user" WHERE id=s.actor_id FOR SHARE;
 IF s.launch_intent OR NOT collab_git.workspace_grant(operation) THEN RAISE EXCEPTION 'workspace_git_authority_changed' USING ERRCODE='P0001'; END IF;
 UPDATE collab_git.workspace_operations SET launch_intent=true WHERE id=operation;
 RETURN s.admission;
END $$;
CREATE FUNCTION collab_git.workspace_request_matches(admission jsonb, request jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT COALESCE(request IS NOT NULL AND request->'version'='1'::jsonb AND request->'operationId'=admission->'operationId'
 AND request->'source'=admission->'source' AND request->'kind'=admission->'kind' AND request->'revision'=admission->'revision'
 AND (CASE WHEN admission->>'kind'='stage' THEN request->'selections'=admission->'selections' AND request->'identity'='null'::jsonb
 ELSE request->'identity'=admission->'identity' AND request->'selections'='null'::jsonb END)
 AND request->>'planHash'~'^[a-f0-9]{64}$' AND request->>'head'~'^[a-f0-9]{40}$' AND request->>'indexHash'~'^[a-f0-9]{64}$',false)
$$;
CREATE FUNCTION collab_git.admit_workspace_effect(operation uuid, nonce uuid, request jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s collab_git.workspace_operations;
BEGIN
 s:=collab_git.lock_workspace(operation,nonce);
 IF NOT s.launch_intent OR s.effect_request IS NOT NULL OR s.mode<>'execute' OR NOT collab_git.workspace_request_matches(s.admission,request) THEN RAISE EXCEPTION 'invalid_workspace_git_evidence' USING ERRCODE='P0001'; END IF;
 UPDATE collab_git.workspace_operations SET effect_request=admit_workspace_effect.request WHERE id=operation;
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(s.organization_id,s.project_id,s.actor_id,'workspace_git.effect_intent',operation::text,jsonb_build_object('planHash',request->>'planHash'));
END $$;
CREATE FUNCTION collab_git.gate_workspace(operation uuid, nonce uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s collab_git.workspace_operations; allowed boolean;
BEGIN
 s:=collab_git.lock_workspace(operation,nonce); PERFORM 1 FROM public."user" WHERE id=s.operator_id FOR SHARE;
 PERFORM 1 FROM collab.runs WHERE id=s.run_id FOR SHARE;
 PERFORM 1 FROM collab.tasks WHERE id=s.task_id FOR SHARE;
 PERFORM 1 FROM collab.workspaces WHERE id=s.workspace_id FOR SHARE;
 IF s.mode='reconcile' THEN
  IF NOT collab_git.workspace_authority(s.task_id,s.operator_id,s.operator_org_version,s.operator_project_version) THEN RAISE EXCEPTION 'workspace_git_authority_changed' USING ERRCODE='P0001'; END IF;
  allowed:=false;
 ELSE
  IF s.effect_request IS NULL THEN RAISE EXCEPTION 'workspace_git_gate_required' USING ERRCODE='P0001'; END IF;
  allowed:=collab_git.workspace_grant(operation);
 END IF;
 UPDATE collab_git.workspace_operations SET gate_txid=txid_current(),gate_kind=CASE WHEN s.mode='reconcile' THEN 'reconcile' WHEN allowed THEN 'apply' ELSE 'close' END WHERE id=operation;
 RETURN allowed;
END $$;
CREATE FUNCTION collab_git.ack_workspace(operation uuid, nonce uuid, receipt jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s collab_git.workspace_operations;
BEGIN
 s:=collab_git.lock_workspace(operation,nonce);
 IF s.gate_txid IS DISTINCT FROM txid_current() OR s.gate_kind<>'apply' OR s.gate_kind IS NULL THEN RAISE EXCEPTION 'workspace_git_gate_required' USING ERRCODE='P0001'; END IF;
 IF receipt->'request' IS DISTINCT FROM s.effect_request OR receipt->>'phase' IS DISTINCT FROM 'applied' THEN RAISE EXCEPTION 'invalid_workspace_git_evidence' USING ERRCODE='P0001'; END IF;
 -- This acknowledges the effect only. Occupancy remains until cleanup AND exit.
 UPDATE collab_git.workspace_operations SET acknowledgement=receipt WHERE id=operation;
END $$;
CREATE FUNCTION collab_git.finish_workspace(operation uuid, nonce uuid, observed jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s collab_git.workspace_operations; receipt jsonb; phase text;
BEGIN
 s:=collab_git.lock_workspace(operation,nonce); receipt:=observed->'state'; phase:=receipt->>'phase';
 IF s.mode='reconcile' AND (s.gate_txid IS DISTINCT FROM txid_current() OR s.gate_kind IS DISTINCT FROM 'reconcile') THEN RAISE EXCEPTION 'workspace_git_gate_required' USING ERRCODE='P0001'; END IF;
 IF NOT s.launch_intent OR observed->'settled' IS DISTINCT FROM 'true'::jsonb OR observed->'writerExited' IS DISTINCT FROM 'true'::jsonb
 OR receipt->'released' IS DISTINCT FROM 'true'::jsonb OR phase IS NULL OR phase NOT IN ('applied','aborted')
 OR NOT collab_git.workspace_request_matches(s.admission,receipt->'request')
 OR (s.effect_request IS NOT NULL AND s.effect_request IS DISTINCT FROM receipt->'request')
 OR (phase='applied' AND (s.effect_request IS NULL OR (s.mode='execute' AND s.acknowledgement IS NULL)))
 OR (s.acknowledgement IS NOT NULL AND phase<>'applied') THEN RAISE EXCEPTION 'invalid_workspace_git_evidence' USING ERRCODE='P0001'; END IF;
 UPDATE collab_git.workspace_operations SET status=phase,observation=observed,acknowledgement=CASE WHEN phase='applied' THEN receipt ELSE acknowledgement END,
 failure=NULL,finished_at=now(),updated_at=now() WHERE id=operation;
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(s.organization_id,s.project_id,s.operator_id,'workspace_git.'||phase,operation::text,jsonb_build_object('requestedBy',s.actor_id,'receiptOid',observed->>'oid','planHash',receipt->'request'->>'planHash','commit',receipt->'request'->>'commit'));
 RETURN collab_git.workspace_result(operation);
END $$;
CREATE FUNCTION collab_git.fail_workspace(operation uuid, nonce uuid, failure_code text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s collab_git.workspace_operations; outcome text;
BEGIN
 s:=collab_git.lock_workspace(operation,nonce);
 IF failure_code IS NULL OR failure_code!~'^[a-z_]{1,120}$' THEN RAISE EXCEPTION 'invalid_workspace_git_evidence' USING ERRCODE='P0001'; END IF;
 outcome:=CASE WHEN s.launch_intent THEN 'attention' ELSE 'aborted' END;
 UPDATE collab_git.workspace_operations SET status=outcome,failure=failure_code,updated_at=now(),finished_at=CASE WHEN outcome='aborted' THEN now() END WHERE id=operation;
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(s.organization_id,s.project_id,s.operator_id,'workspace_git.'||outcome,operation::text,jsonb_build_object('failure',failure_code));
 RETURN collab_git.workspace_result(operation);
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA collab_git FROM PUBLIC;
REVOKE ALL ON FUNCTION collab.request_workspace_git(uuid,uuid,jsonb),collab.workspace_git_operations(uuid),collab.workspace_git_action(uuid,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.request_workspace_git(uuid,uuid,jsonb),collab.workspace_git_operations(uuid),collab.workspace_git_action(uuid,text,text,uuid) TO pi_collab_app;
GRANT EXECUTE ON FUNCTION collab_git.claim_workspace(),collab_git.begin_workspace(uuid,uuid),collab_git.admit_workspace_effect(uuid,uuid,jsonb),collab_git.gate_workspace(uuid,uuid),collab_git.ack_workspace(uuid,uuid,jsonb),collab_git.finish_workspace(uuid,uuid,jsonb),collab_git.fail_workspace(uuid,uuid,text) TO pi_collab_git;
