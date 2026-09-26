-- Explicit dispatch only. Existing confirmations are never auto-enqueued.
ALTER TABLE collab_git.push_confirmations DROP CONSTRAINT push_confirmations_status_check;
ALTER TABLE collab_git.push_confirmations ADD CONSTRAINT push_confirmations_status_check CHECK(status IN ('reserved','withdrawn','consumed','quarantined'));
DROP INDEX collab_git.task_push_destination_owner;
CREATE UNIQUE INDEX task_push_destination_owner ON collab_git.push_confirmations(github_repository_id,ref) WHERE status IN ('reserved','quarantined');
CREATE TABLE collab_git.push_deliveries (
 id uuid PRIMARY KEY, confirmation_id uuid NOT NULL UNIQUE REFERENCES collab_git.push_confirmations(id), preview_id uuid NOT NULL UNIQUE REFERENCES collab_git.push_previews(id),
 organization_id uuid NOT NULL, project_id uuid NOT NULL, task_id uuid NOT NULL,
 actor_id text NOT NULL REFERENCES public."user"(id), organization_version bigint NOT NULL, project_version bigint NOT NULL,
 request_key uuid NOT NULL, request jsonb NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','acknowledged','rejected','not_sent','unknown','retired')),
 stop_requested boolean NOT NULL DEFAULT false, started boolean NOT NULL DEFAULT false, claim_id uuid, backend_pid integer,
 prepared_attempt jsonb, gate_attempt jsonb, gate_evidence jsonb, gate_evidence_hash text, gate_at timestamptz,
 result jsonb, failure text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 UNIQUE(confirmation_id,actor_id,request_key),
 FOREIGN KEY(organization_id,project_id,task_id) REFERENCES collab.tasks(organization_id,project_id,id)
);
CREATE TABLE collab_git.push_delivery_actions (
 delivery_id uuid NOT NULL REFERENCES collab_git.push_deliveries(id), actor_id text NOT NULL REFERENCES public."user"(id),
 request_key uuid NOT NULL, action text NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(delivery_id,actor_id,request_key)
);
CREATE FUNCTION collab_git.push_retire_authority(project uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM collab.projects p JOIN public."user" u ON u.id=collab.actor() WHERE p.id=project
 AND collab.org_role(p.organization_id) IN ('owner','admin') AND collab.project_role(p.id)='maintainer' AND u."twoFactorEnabled")
$$;
CREATE FUNCTION collab_git.push_delivery_result(delivery uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('jobId',id,'confirmationId',confirmation_id,'previewId',preview_id,'actorId',actor_id,'status',status,'stopRequested',stop_requested,
 'createdAt',created_at,'finishedAt',finished_at,'failure',failure,'gateAt',gate_at,'requestHash',gate_attempt->>'requestHash',
 'outcome',result->'outcome','credential',COALESCE(result->'credential','{"status":"unrecorded","expiresAt":null}'::jsonb),
 'canRetire',status='unknown' AND collab_git.push_retire_authority(project_id)) FROM collab_git.push_deliveries WHERE id=delivery
$$;
CREATE OR REPLACE FUNCTION collab_git.push_confirmation_result(confirmation uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',id,'previewId',preview_id,'actorId',actor_id,'status',status,'manifestHash',manifest_hash,'createdAt',created_at,'withdrawnAt',withdrawn_at,
 'valid',status='reserved' AND collab_git.push_confirmation_source_valid(preview_id) AND collab_git.workspace_authority(task_id,actor_id,organization_version,project_version),
 'destination',request->'destination','commitCount',jsonb_array_length(request->'commits'),
 'delivery',(SELECT collab_git.push_delivery_result(d.id) FROM collab_git.push_deliveries d WHERE d.confirmation_id=c.id)) FROM collab_git.push_confirmations c WHERE id=confirmation
$$;
CREATE OR REPLACE FUNCTION collab.task_push_confirmation_context(preview uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab_git.push_previews;
BEGIN
 SELECT * INTO p FROM collab_git.push_previews WHERE id=preview;
 IF p.id IS NULL OR collab.project_role(p.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 RETURN jsonb_build_object('scope',collab_git.push_confirmation_scope(preview),
 'canConfirm',collab_git.workspace_authority(p.task_id,collab.actor()) AND collab_git.push_confirmation_source_valid(preview)
 AND NOT EXISTS(SELECT 1 FROM collab_git.push_deliveries WHERE preview_id=preview),
 'canWithdraw',collab_git.workspace_authority(p.task_id,collab.actor()),
 'occupied',EXISTS(SELECT 1 FROM collab_git.push_confirmations WHERE github_repository_id=p.admission->'binding'->>'githubRepositoryId' AND ref=p.observation->'target'->>'ref' AND status IN ('reserved','quarantined')),
 'confirmations',(SELECT COALESCE(jsonb_agg(collab_git.push_confirmation_result(id) ORDER BY created_at DESC,id),'[]'::jsonb)
 FROM (SELECT id,created_at FROM collab_git.push_confirmations WHERE preview_id=preview ORDER BY created_at DESC,id LIMIT 50) records));
END $$;
CREATE FUNCTION collab_git.guard_push_destination() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('github.com/'||NEW.github_repository_id||'/'||NEW.ref,92816421));
  IF EXISTS(SELECT 1 FROM collab_git.push_confirmations WHERE github_repository_id=NEW.github_repository_id AND ref=NEW.ref AND status IN ('reserved','quarantined'))
  THEN RAISE EXCEPTION 'task_push_destination_busy' USING ERRCODE='P0001'; END IF;
  IF EXISTS(SELECT 1 FROM collab_git.push_deliveries WHERE preview_id=NEW.preview_id) THEN RAISE EXCEPTION 'task_push_delivery_exists' USING ERRCODE='P0001'; END IF;
 ELSIF NEW.status='withdrawn' AND OLD.status='reserved' AND EXISTS(SELECT 1 FROM collab_git.push_deliveries WHERE confirmation_id=OLD.id) THEN
  RAISE EXCEPTION 'task_push_delivery_owned' USING ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER push_destination_guard BEFORE INSERT OR UPDATE ON collab_git.push_confirmations FOR EACH ROW EXECUTE FUNCTION collab_git.guard_push_destination();

CREATE OR REPLACE FUNCTION collab.withdraw_task_push_confirmation(confirmation uuid, request_key uuid, reason text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s collab_git.push_confirmations; prior collab_git.push_confirmation_actions;
BEGIN
 SELECT * INTO s FROM collab_git.push_confirmations WHERE id=confirmation;
 IF s.id IS NULL OR collab.project_role(s.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(s.organization_id::text,811)); PERFORM 1 FROM public."user" WHERE id=collab.actor() FOR SHARE;
 PERFORM 1 FROM collab.tasks WHERE id=s.task_id FOR SHARE;
 IF NOT collab_git.workspace_authority(s.task_id,collab.actor()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF request_key IS NULL OR reason IS NULL OR length(btrim(reason)) NOT BETWEEN 10 AND 2000 THEN RAISE EXCEPTION 'invalid_task_push_confirmation' USING ERRCODE='P0001'; END IF;
 SELECT * INTO prior FROM collab_git.push_confirmation_actions WHERE confirmation_id=confirmation AND actor_id=collab.actor() AND push_confirmation_actions.request_key=withdraw_task_push_confirmation.request_key;
 IF FOUND THEN
  IF prior.reason<>btrim(reason) THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
  RETURN collab_git.push_confirmation_result(confirmation)||jsonb_build_object('replayed',true);
 END IF;
 IF EXISTS(SELECT 1 FROM collab_git.push_deliveries WHERE confirmation_id=confirmation) THEN RAISE EXCEPTION 'task_push_delivery_owned' USING ERRCODE='P0001'; END IF;
 UPDATE collab_git.push_confirmations SET status='withdrawn',withdrawn_at=now() WHERE id=confirmation AND status='reserved';
 INSERT INTO collab_git.push_confirmation_actions VALUES(confirmation,collab.actor(),request_key,btrim(reason),now());
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(s.organization_id,s.project_id,collab.actor(),'task_push.confirmation_withdrawn',confirmation::text,jsonb_build_object('reason',btrim(reason)));
 RETURN collab_git.push_confirmation_result(confirmation)||jsonb_build_object('replayed',false);
END $$;
CREATE FUNCTION collab.request_task_push_delivery(confirmation uuid, request_key uuid, payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c collab_git.push_confirmations; p collab_git.push_previews; prior collab_git.push_deliveries; operation uuid; ov bigint; pv bigint;
BEGIN
 SELECT * INTO c FROM collab_git.push_confirmations WHERE id=confirmation;
 IF c.id IS NULL OR collab.project_role(c.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(c.organization_id::text,811));
 PERFORM 1 FROM public."user" WHERE id IN (collab.actor(),c.actor_id) ORDER BY id FOR SHARE;
 PERFORM 1 FROM collab.tasks WHERE id=c.task_id FOR SHARE;
 IF NOT collab_git.workspace_authority(c.task_id,collab.actor()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF request_key IS NULL OR payload IS NULL OR jsonb_typeof(payload)<>'object' OR octet_length(payload::text)>4096
 OR (payload-ARRAY['manifestHash','acknowledgePush'])<>'{}'::jsonb OR payload->'acknowledgePush' IS DISTINCT FROM 'true'::jsonb
 OR jsonb_typeof(payload->'manifestHash') IS DISTINCT FROM 'string' OR COALESCE(payload->>'manifestHash','')!~'^[a-f0-9]{64}$'
 THEN RAISE EXCEPTION 'invalid_task_push_delivery' USING ERRCODE='P0001'; END IF;
 SELECT * INTO prior FROM collab_git.push_deliveries WHERE confirmation_id=confirmation AND actor_id=collab.actor() AND push_deliveries.request_key=request_task_push_delivery.request_key;
 IF FOUND THEN
  IF prior.request<>payload THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
  RETURN collab_git.push_delivery_result(prior.id)||jsonb_build_object('replayed',true);
 END IF;
 SELECT * INTO STRICT c FROM collab_git.push_confirmations WHERE id=confirmation FOR UPDATE;
 SELECT * INTO STRICT p FROM collab_git.push_previews WHERE id=c.preview_id;
 IF EXISTS(SELECT 1 FROM collab_git.push_deliveries WHERE preview_id=p.id) THEN RAISE EXCEPTION 'task_push_delivery_exists' USING ERRCODE='P0001'; END IF;
 IF c.status<>'reserved' OR c.manifest_hash<>payload->>'manifestHash' OR collab_git.push_confirmation_source_valid(p.id) IS DISTINCT FROM true
 OR NOT collab_git.workspace_authority(c.task_id,c.actor_id,c.organization_version,c.project_version)
 THEN RAISE EXCEPTION 'stale_task_push_confirmation' USING ERRCODE='P0001'; END IF;
 SELECT authorization_version INTO ov FROM collab.memberships WHERE organization_id=c.organization_id AND user_id=collab.actor();
 SELECT authorization_version INTO pv FROM collab.project_memberships WHERE project_id=c.project_id AND user_id=collab.actor();
 operation:=(p.admission->>'operationId')::uuid;
 INSERT INTO collab_git.push_deliveries(id,confirmation_id,preview_id,organization_id,project_id,task_id,actor_id,organization_version,project_version,request_key,request)
 VALUES(operation,c.id,p.id,c.organization_id,c.project_id,c.task_id,collab.actor(),ov,pv,request_key,payload);
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(c.organization_id,c.project_id,collab.actor(),'task_push.send_requested',operation::text,jsonb_build_object('confirmationId',c.id,'manifestHash',c.manifest_hash));
 RETURN collab_git.push_delivery_result(operation)||jsonb_build_object('replayed',false);
END $$;
CREATE FUNCTION collab.task_push_delivery_action(delivery uuid, request_key uuid, action text, reason text, acknowledge_unknown boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s collab_git.push_deliveries; prior collab_git.push_delivery_actions;
BEGIN
 SELECT * INTO s FROM collab_git.push_deliveries WHERE id=delivery;
 IF s.id IS NULL OR collab.project_role(s.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(s.organization_id::text,811)); PERFORM 1 FROM public."user" WHERE id=collab.actor() FOR SHARE;
 PERFORM 1 FROM collab.tasks WHERE id=s.task_id FOR SHARE;
 IF NOT collab_git.workspace_authority(s.task_id,collab.actor()) OR (action='retire' AND NOT collab_git.push_retire_authority(s.project_id)) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF request_key IS NULL OR action IS NULL OR action NOT IN ('cancel','retire') OR reason IS NULL OR length(btrim(reason)) NOT BETWEEN 10 AND 2000
 OR (action='retire' AND (acknowledge_unknown IS DISTINCT FROM true OR length(btrim(reason))<20)) OR (action='cancel' AND acknowledge_unknown IS DISTINCT FROM false)
 THEN RAISE EXCEPTION 'invalid_task_push_delivery' USING ERRCODE='P0001'; END IF;
 SELECT * INTO prior FROM collab_git.push_delivery_actions WHERE delivery_id=delivery AND actor_id=collab.actor() AND push_delivery_actions.request_key=task_push_delivery_action.request_key;
 IF FOUND THEN
  IF prior.action<>action OR prior.reason<>btrim(reason) THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
  RETURN collab_git.push_delivery_result(delivery)||jsonb_build_object('replayed',true);
 END IF;
 SELECT * INTO STRICT s FROM collab_git.push_deliveries WHERE id=delivery FOR UPDATE;
 IF action='retire' THEN
  IF s.status<>'unknown' THEN RAISE EXCEPTION 'task_push_not_unknown' USING ERRCODE='P0001'; END IF;
  UPDATE collab_git.push_deliveries SET status='retired',stop_requested=true,updated_at=now(),finished_at=now() WHERE id=delivery;
  UPDATE collab_git.push_confirmations SET status='quarantined' WHERE id=s.confirmation_id;
 ELSE UPDATE collab_git.push_deliveries SET stop_requested=true,updated_at=now() WHERE id=delivery AND status IN ('queued','running','unknown');
 END IF;
 INSERT INTO collab_git.push_delivery_actions VALUES(delivery,collab.actor(),request_key,action,btrim(reason),now());
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(s.organization_id,s.project_id,collab.actor(),'task_push.'||action||'_requested',delivery::text,jsonb_build_object('reason',btrim(reason),'remoteEffectStillUnknown',action='retire'));
 RETURN collab_git.push_delivery_result(delivery)||jsonb_build_object('replayed',false);
END $$;

CREATE FUNCTION collab_git.push_delivery_grant(delivery uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT COALESCE((SELECT NOT s.stop_requested AND c.status='reserved' AND collab_git.push_confirmation_source_valid(s.preview_id)
 AND c.manifest_hash=p.manifest_hash AND collab_git.workspace_authority(s.task_id,c.actor_id,c.organization_version,c.project_version)
 AND collab_git.workspace_authority(s.task_id,s.actor_id,s.organization_version,s.project_version)
 FROM collab_git.push_deliveries s JOIN collab_git.push_confirmations c ON c.id=s.confirmation_id JOIN collab_git.push_previews p ON p.id=s.preview_id WHERE s.id=delivery),false)
$$;
CREATE FUNCTION collab_git.claim_task_push_delivery() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s collab_git.push_deliveries; p collab_git.push_previews; nonce uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(92816423);
 FOR s IN SELECT * FROM collab_git.push_deliveries WHERE status IN ('queued','running') ORDER BY updated_at,id LIMIT 100 LOOP
  IF NOT pg_try_advisory_lock(hashtextextended(s.id::text,92816424)) THEN CONTINUE; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(s.organization_id::text,811)); SELECT * INTO STRICT s FROM collab_git.push_deliveries WHERE id=s.id FOR UPDATE;
  IF s.status='running' THEN
   UPDATE collab_git.push_deliveries SET status=CASE WHEN gate_at IS NULL THEN 'not_sent' ELSE 'unknown' END,failure='task_push_broker_lost',updated_at=now(),finished_at=now() WHERE id=s.id;
   IF s.gate_at IS NULL THEN UPDATE collab_git.push_confirmations SET status='consumed' WHERE id=s.confirmation_id; END IF;
   INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(s.organization_id,s.project_id,s.actor_id,'task_push.broker_lost',s.id::text,jsonb_build_object('gateRecorded',s.gate_at IS NOT NULL));
   PERFORM pg_advisory_unlock(hashtextextended(s.id::text,92816424)); RETURN collab_git.push_delivery_result(s.id)||jsonb_build_object('recovered',true);
  END IF;
  IF s.status<>'queued' THEN PERFORM pg_advisory_unlock(hashtextextended(s.id::text,92816424)); CONTINUE; END IF;
  nonce:=gen_random_uuid(); UPDATE collab_git.push_deliveries SET status='running',claim_id=nonce,backend_pid=pg_backend_pid(),updated_at=now() WHERE id=s.id;
  SELECT * INTO STRICT p FROM collab_git.push_previews WHERE id=s.preview_id;
  RETURN jsonb_build_object('jobId',s.id,'claimId',nonce,'organizationId',s.organization_id,'connectionId',p.connection_id,'previewId',p.id,
  'manifestHash',p.manifest_hash,'binding',p.admission->'binding','intent',p.manifest->'input'->'intent');
 END LOOP; RETURN NULL;
END $$;
CREATE FUNCTION collab_git.lock_task_push_delivery(delivery uuid, nonce uuid) RETURNS collab_git.push_deliveries LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s collab_git.push_deliveries;
BEGIN
 SELECT * INTO s FROM collab_git.push_deliveries WHERE id=delivery;
 IF s.id IS NULL OR nonce IS NULL THEN RAISE EXCEPTION 'task_push_claim_lost' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(s.organization_id::text,811)); SELECT * INTO STRICT s FROM collab_git.push_deliveries WHERE id=delivery FOR UPDATE;
 IF s.status<>'running' OR s.claim_id IS DISTINCT FROM nonce OR s.backend_pid IS DISTINCT FROM pg_backend_pid() THEN RAISE EXCEPTION 'task_push_claim_lost' USING ERRCODE='P0001'; END IF;
 RETURN s;
END $$;
CREATE FUNCTION collab_git.lock_task_push_authority(delivery uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s collab_git.push_deliveries; p collab_git.push_previews; c collab_git.push_confirmations;
BEGIN
 SELECT * INTO STRICT s FROM collab_git.push_deliveries WHERE id=delivery; SELECT * INTO STRICT p FROM collab_git.push_previews WHERE id=s.preview_id;
 SELECT * INTO STRICT c FROM collab_git.push_confirmations WHERE id=s.confirmation_id;
 PERFORM 1 FROM public."user" WHERE id IN (s.actor_id,c.actor_id) ORDER BY id FOR SHARE;
 PERFORM 1 FROM collab.tasks WHERE id=s.task_id FOR SHARE; PERFORM 1 FROM collab.runs WHERE id=p.run_id FOR SHARE;
 PERFORM 1 FROM collab.workspaces WHERE id=p.workspace_id FOR SHARE; PERFORM 1 FROM collab.github_bindings WHERE repository_id=p.repository_id FOR SHARE;
 PERFORM 1 FROM collab.github_installations WHERE id=p.connection_id FOR SHARE;
 IF NOT collab_git.push_delivery_grant(delivery) THEN RAISE EXCEPTION 'task_push_authority_changed' USING ERRCODE='P0001'; END IF;
END $$;
CREATE FUNCTION collab_git.begin_task_push_delivery(delivery uuid, nonce uuid, attempt jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s collab_git.push_deliveries; p collab_git.push_previews;
BEGIN
 s:=collab_git.lock_task_push_delivery(delivery,nonce); PERFORM collab_git.lock_task_push_authority(delivery); SELECT * INTO STRICT p FROM collab_git.push_previews WHERE id=s.preview_id;
 IF s.started OR attempt IS NULL OR jsonb_typeof(attempt)<>'object' OR octet_length(attempt::text)>8192
 OR (attempt-ARRAY['ref','packHash','requestHash','requestBytes']) IS DISTINCT FROM p.manifest->'input'->'intent'
 OR attempt->>'ref' IS DISTINCT FROM p.observation->'target'->>'ref'
 OR jsonb_typeof(attempt->'requestHash') IS DISTINCT FROM 'string' OR COALESCE(attempt->>'requestHash','')!~'^[a-f0-9]{64}$'
 OR jsonb_typeof(attempt->'packHash') IS DISTINCT FROM 'string' OR COALESCE(attempt->>'packHash','')!~'^[a-f0-9]{64}$'
 OR jsonb_typeof(attempt->'ref') IS DISTINCT FROM 'string'
 OR jsonb_typeof(attempt->'requestBytes') IS DISTINCT FROM 'number' OR COALESCE(attempt->>'requestBytes','')!~'^[1-9][0-9]{1,8}$'
 THEN RAISE EXCEPTION 'invalid_task_push_evidence' USING ERRCODE='P0001'; END IF;
 IF (attempt->>'requestBytes')::bigint NOT BETWEEN 32 AND 67112960 THEN RAISE EXCEPTION 'invalid_task_push_evidence' USING ERRCODE='P0001'; END IF;
 UPDATE collab_git.push_deliveries SET started=true,prepared_attempt=attempt,updated_at=now() WHERE id=delivery;
 RETURN (SELECT jsonb_build_object('appId',c.app_id,'installationId',c.installation_id,'accountId',c.account_id,'sealed',k.sealed)
 FROM collab.github_installations c JOIN collab_git.credentials k ON k.connection_id=c.id WHERE c.id=p.connection_id);
END $$;
CREATE FUNCTION collab_git.task_push_delivery_live(delivery uuid, nonce uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT COALESCE((SELECT status='running' AND claim_id=nonce AND backend_pid=pg_backend_pid() AND collab_git.push_delivery_grant(id) FROM collab_git.push_deliveries WHERE id=delivery),false)
$$;
CREATE FUNCTION collab_git.gate_task_push_delivery(delivery uuid, nonce uuid, attempt jsonb, evidence_text text, evidence_hash text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s collab_git.push_deliveries; p collab_git.push_previews; c collab.github_installations; e jsonb;
BEGIN
 s:=collab_git.lock_task_push_delivery(delivery,nonce); PERFORM collab_git.lock_task_push_authority(delivery);
 SELECT * INTO STRICT p FROM collab_git.push_previews WHERE id=s.preview_id; SELECT * INTO STRICT c FROM collab.github_installations WHERE id=p.connection_id;
 IF NOT s.started OR s.gate_at IS NOT NULL OR attempt IS DISTINCT FROM s.prepared_attempt OR evidence_text IS NULL OR octet_length(evidence_text)>65536
 OR evidence_hash IS NULL OR encode(sha256(convert_to(evidence_text,'UTF8')),'hex')<>evidence_hash THEN RAISE EXCEPTION 'invalid_task_push_evidence' USING ERRCODE='P0001'; END IF;
 e:=evidence_text::jsonb;
 IF e->'version' IS DISTINCT FROM '1'::jsonb OR e->'repository' IS DISTINCT FROM p.admission->'binding' OR e->'protected' IS DISTINCT FROM 'false'::jsonb
 OR e->'activeRules' IS DISTINCT FROM '0'::jsonb OR e->>'ref' IS DISTINCT FROM s.prepared_attempt->>'ref'
 OR e->'observedOld' IS DISTINCT FROM s.prepared_attempt->'expectedOld' OR e->'defaultSha' IS DISTINCT FROM p.observation->'target'->'defaultSha'
 OR e->'installation'->>'appId' IS DISTINCT FROM c.app_id OR e->'installation'->>'installationId' IS DISTINCT FROM c.installation_id
 OR e->'installation'->>'accountId' IS DISTINCT FROM c.account_id OR e->'installation'->'permissions'->>'contents' IS DISTINCT FROM 'write'
 OR jsonb_typeof(e->'verifiedAt') IS DISTINCT FROM 'string' OR COALESCE(e->>'verifiedAt','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$'
 THEN RAISE EXCEPTION 'invalid_task_push_evidence' USING ERRCODE='P0001'; END IF;
 IF (e->>'verifiedAt')::timestamptz NOT BETWEEN clock_timestamp()-interval '30 seconds' AND clock_timestamp()+interval '5 seconds' THEN RAISE EXCEPTION 'invalid_task_push_evidence' USING ERRCODE='P0001'; END IF;
 UPDATE collab_git.push_deliveries SET gate_attempt=attempt,gate_evidence=e,gate_evidence_hash=evidence_hash,gate_at=clock_timestamp(),updated_at=now() WHERE id=delivery;
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(s.organization_id,s.project_id,s.actor_id,'task_push.send_gate',delivery::text,jsonb_build_object('requestHash',attempt->>'requestHash','packHash',attempt->>'packHash','requestBytes',attempt->'requestBytes','evidenceHash',evidence_hash));
 RETURN true;
END $$;
CREATE FUNCTION collab_git.finish_task_push_delivery(delivery uuid, nonce uuid, receipt jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s collab_git.push_deliveries; effect text; result_status text;
BEGIN
 s:=collab_git.lock_task_push_delivery(delivery,nonce);
 IF NOT s.started OR receipt IS NULL OR jsonb_typeof(receipt)<>'object' OR octet_length(receipt::text)>65536
 OR NOT (receipt ?& ARRAY['outcome','failure','receiveStarted','evidence','credential'])
 OR (receipt-ARRAY['outcome','failure','receiveStarted','evidence','credential'])<>'{}'::jsonb
 OR jsonb_typeof(receipt->'receiveStarted') IS DISTINCT FROM 'boolean' OR jsonb_typeof(receipt->'credential') IS DISTINCT FROM 'object'
 OR NOT ((receipt->'credential') ?& ARRAY['status','expiresAt']) OR ((receipt->'credential')-ARRAY['status','expiresAt'])<>'{}'::jsonb
 OR COALESCE(receipt->'credential'->>'status','') NOT IN ('not_requested','issuance_unconfirmed','revoked','revocation_unconfirmed')
 OR (receipt->'credential'->'expiresAt' IS DISTINCT FROM 'null'::jsonb AND
 (jsonb_typeof(receipt->'credential'->'expiresAt') IS DISTINCT FROM 'string' OR COALESCE(receipt->'credential'->>'expiresAt','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$'))
 OR (receipt->'failure' IS DISTINCT FROM 'null'::jsonb AND (jsonb_typeof(receipt->'failure') IS DISTINCT FROM 'string' OR COALESCE(receipt->>'failure','')!~'^[a-z_]{1,120}$'))
 OR (receipt->'evidence' IS DISTINCT FROM 'null'::jsonb AND jsonb_typeof(receipt->'evidence') IS DISTINCT FROM 'object')
 THEN RAISE EXCEPTION 'invalid_task_push_evidence' USING ERRCODE='P0001'; END IF;
 effect:=receipt->'outcome'->>'status';
 IF receipt->'outcome' IS DISTINCT FROM 'null'::jsonb THEN
  IF jsonb_typeof(receipt->'outcome') IS DISTINCT FROM 'object' OR effect IS NULL OR effect NOT IN ('not_sent','acknowledged','rejected','unknown')
  THEN RAISE EXCEPTION 'invalid_task_push_evidence' USING ERRCODE='P0001'; END IF;
  IF effect='acknowledged' THEN
   IF ((receipt->'outcome')-ARRAY['status','newSha','responseHash'])<>'{}'::jsonb OR receipt->'outcome'->>'newSha' IS DISTINCT FROM s.prepared_attempt->>'newSha'
   THEN RAISE EXCEPTION 'invalid_task_push_evidence' USING ERRCODE='P0001'; END IF;
  ELSE
   IF ((receipt->'outcome')-CASE WHEN effect='rejected' THEN ARRAY['status','reason','responseHash'] ELSE ARRAY['status','reason'] END)<>'{}'::jsonb
   OR COALESCE(receipt->'outcome'->>'reason','') NOT IN
    (SELECT unnest(CASE effect WHEN 'not_sent' THEN ARRAY['remote_changed','authority_denied','cancelled'] WHEN 'rejected' THEN ARRAY['unpack_failed','ref_rejected'] ELSE ARRAY['response_unconfirmed'] END))
   THEN RAISE EXCEPTION 'invalid_task_push_evidence' USING ERRCODE='P0001'; END IF;
  END IF;
  IF effect IN ('acknowledged','rejected') AND (jsonb_typeof(receipt->'outcome'->'responseHash') IS DISTINCT FROM 'string' OR COALESCE(receipt->'outcome'->>'responseHash','')!~'^[a-f0-9]{64}$')
  THEN RAISE EXCEPTION 'invalid_task_push_evidence' USING ERRCODE='P0001'; END IF;
 END IF;
 IF receipt->'receiveStarted'='true'::jsonb THEN
  IF s.gate_at IS NULL OR receipt->'evidence' IS DISTINCT FROM s.gate_evidence OR effect IS NULL OR effect NOT IN ('acknowledged','rejected','unknown')
  OR receipt->'credential'->>'status' NOT IN ('revoked','revocation_unconfirmed') OR receipt->'credential'->'expiresAt'='null'::jsonb
  THEN RAISE EXCEPTION 'invalid_task_push_evidence' USING ERRCODE='P0001'; END IF;
  result_status:=effect;
 ELSE
  IF receipt->'outcome' IS DISTINCT FROM 'null'::jsonb AND (effect IS NULL OR effect NOT IN ('not_sent','unknown'))
  THEN RAISE EXCEPTION 'invalid_task_push_evidence' USING ERRCODE='P0001'; END IF;
  -- An unknown protocol result never grants release, even if a transport
  -- adapter reports no receive. Contradictory receipts fail closed.
  IF effect='unknown' AND s.gate_at IS NULL THEN RAISE EXCEPTION 'invalid_task_push_evidence' USING ERRCODE='P0001'; END IF;
  result_status:=CASE WHEN effect='unknown' THEN 'unknown' ELSE 'not_sent' END;
 END IF;
 UPDATE collab_git.push_deliveries SET status=result_status,result=receipt,failure=receipt->>'failure',updated_at=now(),finished_at=now() WHERE id=delivery;
 IF result_status<>'unknown' THEN UPDATE collab_git.push_confirmations SET status='consumed' WHERE id=s.confirmation_id; END IF;
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(s.organization_id,s.project_id,s.actor_id,'task_push.finished',delivery::text,jsonb_build_object('status',result_status,'credential',receipt->'credential'->>'status'));
 RETURN collab_git.push_delivery_result(delivery);
END $$;
CREATE FUNCTION collab_git.fail_task_push_delivery(delivery uuid, nonce uuid, code text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s collab_git.push_deliveries;
BEGIN
 s:=collab_git.lock_task_push_delivery(delivery,nonce);
 IF code IS NULL OR code!~'^[a-z_]{1,120}$' THEN RAISE EXCEPTION 'invalid_task_push_evidence' USING ERRCODE='P0001'; END IF;
 UPDATE collab_git.push_deliveries SET status=CASE WHEN gate_at IS NULL THEN 'not_sent' ELSE 'unknown' END,failure=code,updated_at=now(),finished_at=now() WHERE id=delivery;
 IF s.gate_at IS NULL THEN UPDATE collab_git.push_confirmations SET status='consumed' WHERE id=s.confirmation_id; END IF;
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(s.organization_id,s.project_id,s.actor_id,'task_push.failed',delivery::text,jsonb_build_object('gateRecorded',s.gate_at IS NOT NULL,'failure',code));
 RETURN collab_git.push_delivery_result(delivery);
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA collab_git FROM PUBLIC;
REVOKE ALL ON FUNCTION collab.request_task_push_delivery(uuid,uuid,jsonb),collab.task_push_delivery_action(uuid,uuid,text,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.request_task_push_delivery(uuid,uuid,jsonb),collab.task_push_delivery_action(uuid,uuid,text,text,boolean) TO pi_collab_app;
GRANT EXECUTE ON FUNCTION collab_git.claim_task_push_delivery(),collab_git.begin_task_push_delivery(uuid,uuid,jsonb),collab_git.task_push_delivery_live(uuid,uuid),collab_git.gate_task_push_delivery(uuid,uuid,jsonb,text,text),collab_git.finish_task_push_delivery(uuid,uuid,jsonb),collab_git.fail_task_push_delivery(uuid,uuid,text) TO pi_collab_git;
