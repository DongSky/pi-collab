-- Explicit draft creation from immutable read-only proposals. No automatic
-- adoption, retry, review, CI or merge permission is created by these records.
CREATE TABLE collab_git.pull_deliveries (
 id uuid PRIMARY KEY REFERENCES collab_git.pull_proposals(id),
 organization_id uuid NOT NULL, project_id uuid NOT NULL, task_id uuid NOT NULL,
 actor_id text NOT NULL REFERENCES public."user"(id), organization_version bigint NOT NULL, project_version bigint NOT NULL,
 request_key uuid NOT NULL, request jsonb NOT NULL,
 github_repository_id text NOT NULL, ref text NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','created','rejected','not_created','unknown','retired')),
 stop_requested boolean NOT NULL DEFAULT false, started boolean NOT NULL DEFAULT false, claim_id uuid, backend_pid integer,
 gate_at timestamptz, gate_evidence jsonb, gate_evidence_text text, gate_evidence_hash text,
 result jsonb, result_text text, result_hash text, failure text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 UNIQUE(id,actor_id,request_key),
 FOREIGN KEY(organization_id,project_id,task_id) REFERENCES collab.tasks(organization_id,project_id,id)
);
CREATE TABLE collab_git.pull_delivery_actions (
 delivery_id uuid NOT NULL REFERENCES collab_git.pull_deliveries(id), actor_id text NOT NULL REFERENCES public."user"(id),
 request_key uuid NOT NULL, action text NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(delivery_id,actor_id,request_key)
);

-- Stable GitHub repository identity, not local project/binding identity.
-- Block old writers while their existing reservations are installed atomically.
LOCK TABLE collab_git.push_confirmations IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE collab_git.head_reservations (
 github_repository_id text NOT NULL, ref text NOT NULL, PRIMARY KEY(github_repository_id,ref),
 push_confirmation_id uuid UNIQUE REFERENCES collab_git.push_confirmations(id),
 pull_delivery_id uuid UNIQUE REFERENCES collab_git.pull_deliveries(id),
 quarantined boolean NOT NULL DEFAULT false,
 CHECK((push_confirmation_id IS NULL)<>(pull_delivery_id IS NULL))
);
INSERT INTO collab_git.head_reservations(github_repository_id,ref,push_confirmation_id,quarantined)
 SELECT github_repository_id,ref,id,status='quarantined' FROM collab_git.push_confirmations WHERE status IN ('reserved','quarantined');
CREATE FUNCTION collab_git.mirror_push_head() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('github.com/'||NEW.github_repository_id||'/'||NEW.ref,92816421));
 IF NEW.status IN ('reserved','quarantined') THEN
  INSERT INTO collab_git.head_reservations(github_repository_id,ref,push_confirmation_id,quarantined)
  VALUES(NEW.github_repository_id,NEW.ref,NEW.id,NEW.status='quarantined')
  ON CONFLICT(github_repository_id,ref) DO UPDATE SET quarantined=EXCLUDED.quarantined
  WHERE head_reservations.push_confirmation_id=NEW.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'task_push_destination_busy' USING ERRCODE='P0001'; END IF;
 ELSE
  DELETE FROM collab_git.head_reservations WHERE push_confirmation_id=NEW.id AND NOT quarantined;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER shared_push_head AFTER INSERT OR UPDATE ON collab_git.push_confirmations FOR EACH ROW EXECUTE FUNCTION collab_git.mirror_push_head();
CREATE OR REPLACE FUNCTION collab.task_push_confirmation_context(preview uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab_git.push_previews;
BEGIN
 SELECT * INTO p FROM collab_git.push_previews WHERE id=preview;
 IF p.id IS NULL OR collab.project_role(p.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 RETURN jsonb_build_object('scope',collab_git.push_confirmation_scope(preview),
 'canConfirm',collab_git.workspace_authority(p.task_id,collab.actor()) AND collab_git.push_confirmation_source_valid(preview)
 AND NOT EXISTS(SELECT 1 FROM collab_git.push_deliveries WHERE preview_id=preview),
 'canWithdraw',collab_git.workspace_authority(p.task_id,collab.actor()),
 'occupied',EXISTS(SELECT 1 FROM collab_git.head_reservations WHERE github_repository_id=p.admission->'binding'->>'githubRepositoryId' AND ref=p.observation->'target'->>'ref'),
 'confirmations',(SELECT COALESCE(jsonb_agg(collab_git.push_confirmation_result(id) ORDER BY created_at DESC,id),'[]'::jsonb)
 FROM (SELECT id,created_at FROM collab_git.push_confirmations WHERE preview_id=preview ORDER BY created_at DESC,id LIMIT 50) records));
END $$;

-- Initial ChangeRequest attribution and immutable provider observations. These
-- are not complete reviewed revisions: no full diff hash, CI or approval yet.
CREATE TABLE collab_git.pull_changes (
 id uuid PRIMARY KEY REFERENCES collab_git.pull_deliveries(id),
 github_repository_id text NOT NULL, pull_id text NOT NULL, pull_number bigint NOT NULL,
 node_id text NOT NULL, url text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(github_repository_id,pull_id), UNIQUE(github_repository_id,pull_number)
);
CREATE TABLE collab_git.pull_change_observations (
 change_id uuid NOT NULL REFERENCES collab_git.pull_changes(id), sequence integer NOT NULL CHECK(sequence>=1),
 kind text NOT NULL CHECK(kind IN ('creation','followup')), source_sha text NOT NULL, target_sha text NOT NULL,
 evidence jsonb NOT NULL, evidence_text text NOT NULL, evidence_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(change_id,sequence)
);
CREATE FUNCTION collab_git.pull_delivery_grant(delivery uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT COALESCE((SELECT NOT d.stop_requested AND p.status='ready' AND collab_git.pull_proposal_grant(p.id)
 AND collab_git.workspace_authority(d.task_id,d.actor_id,d.organization_version,d.project_version)
 AND EXISTS(SELECT 1 FROM collab_git.head_reservations h WHERE h.github_repository_id=d.github_repository_id AND h.ref=d.ref AND h.pull_delivery_id=d.id AND NOT h.quarantined)
 FROM collab_git.pull_deliveries d JOIN collab_git.pull_proposals p ON p.id=d.id WHERE d.id=delivery),false)
$$;
CREATE FUNCTION collab_git.pull_delivery_result(delivery uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('jobId',d.id,'actorId',d.actor_id,'actorName',(SELECT name FROM public."user" WHERE id=d.actor_id),
 'status',d.status,'stopRequested',d.stop_requested,'createdAt',d.created_at,'finishedAt',d.finished_at,'failure',d.failure,
 'gateAt',d.gate_at,'requestHash',d.request->>'requestHash','resultHash',d.result_hash,'outcome',d.result->'outcome',
 'credential',COALESCE(d.result->'credential','{"status":"unrecorded","expiresAt":null}'::jsonb),
 'canRetire',d.status='unknown' AND collab_git.push_retire_authority(d.project_id),
 'changeRequest',(SELECT jsonb_build_object('id',c.id,'pullId',c.pull_id,'number',c.pull_number,'nodeId',c.node_id,'url',c.url,
 'observations',(SELECT COALESCE(jsonb_agg(jsonb_build_object('sequence',o.sequence,'kind',o.kind,'sourceSha',o.source_sha,'targetSha',o.target_sha,
 'evidence',o.evidence,'evidenceText',o.evidence_text,'evidenceHash',o.evidence_hash) ORDER BY o.sequence),'[]'::jsonb)
 FROM collab_git.pull_change_observations o WHERE o.change_id=c.id)) FROM collab_git.pull_changes c WHERE c.id=d.id))
 FROM collab_git.pull_deliveries d WHERE d.id=delivery
$$;
CREATE FUNCTION collab.task_pull_delivery_context(proposal uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab_git.pull_proposals;
BEGIN
 SELECT * INTO p FROM collab_git.pull_proposals WHERE id=proposal;
 IF p.id IS NULL OR collab.project_role(p.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 RETURN jsonb_build_object('canControl',collab_git.workspace_authority(p.task_id,collab.actor()),
 'canCreate',p.status='ready' AND collab_git.pull_proposal_grant(p.id) AND collab_git.workspace_authority(p.task_id,collab.actor())
 AND NOT EXISTS(SELECT 1 FROM collab_git.pull_deliveries WHERE id=proposal),
 'occupied',EXISTS(SELECT 1 FROM collab_git.head_reservations WHERE github_repository_id=p.admission->'binding'->>'githubRepositoryId' AND ref=p.attempt->>'ref'),
 'delivery',collab_git.pull_delivery_result(proposal));
END $$;
CREATE FUNCTION collab.request_task_pull_delivery(proposal uuid, request_key uuid, payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab_git.pull_proposals; prior collab_git.pull_deliveries; ov bigint; pv bigint; remote_id text; head_ref text;
BEGIN
 SELECT * INTO p FROM collab_git.pull_proposals WHERE id=proposal;
 IF p.id IS NULL OR collab.project_role(p.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p.organization_id::text,811));
 PERFORM 1 FROM public."user" WHERE id IN (collab.actor(),p.actor_id) ORDER BY id FOR SHARE;
 PERFORM 1 FROM collab.tasks WHERE id=p.task_id FOR SHARE;
 IF NOT collab_git.workspace_authority(p.task_id,collab.actor()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF request_key IS NULL OR payload IS NULL OR jsonb_typeof(payload)<>'object' OR octet_length(payload::text)>4096
 OR (payload-ARRAY['requestHash','observationHash','acknowledgeContent','acknowledgeNotification','acknowledgeVersions'])<>'{}'::jsonb
 OR payload->'acknowledgeContent' IS DISTINCT FROM 'true'::jsonb OR payload->'acknowledgeNotification' IS DISTINCT FROM 'true'::jsonb
 OR payload->'acknowledgeVersions' IS DISTINCT FROM 'true'::jsonb
 OR jsonb_typeof(payload->'requestHash') IS DISTINCT FROM 'string' OR COALESCE(payload->>'requestHash','')!~'^[a-f0-9]{64}$'
 OR jsonb_typeof(payload->'observationHash') IS DISTINCT FROM 'string' OR COALESCE(payload->>'observationHash','')!~'^[a-f0-9]{64}$'
 THEN RAISE EXCEPTION 'invalid_task_pull_delivery' USING ERRCODE='P0001'; END IF;
 SELECT * INTO prior FROM collab_git.pull_deliveries WHERE id=proposal;
 IF FOUND THEN
  IF prior.actor_id<>collab.actor() OR prior.request_key<>request_task_pull_delivery.request_key THEN RAISE EXCEPTION 'task_pull_delivery_exists' USING ERRCODE='P0001'; END IF;
  IF prior.request<>payload THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
  RETURN collab_git.pull_delivery_result(proposal)||jsonb_build_object('replayed',true);
 END IF;
 IF p.status<>'ready' OR collab_git.pull_proposal_grant(p.id) IS DISTINCT FROM true
 OR p.attempt->>'requestHash' IS DISTINCT FROM payload->>'requestHash' OR p.observation_hash IS DISTINCT FROM payload->>'observationHash'
 THEN RAISE EXCEPTION 'stale_task_pull_proposal' USING ERRCODE='P0001'; END IF;
 IF (SELECT count(*) FROM collab_git.pull_deliveries WHERE project_id=p.project_id AND status IN ('queued','running'))>=20
 THEN RAISE EXCEPTION 'task_pull_delivery_limit' USING ERRCODE='P0001'; END IF;
 remote_id:=p.admission->'binding'->>'githubRepositoryId'; head_ref:=p.attempt->>'ref';
 PERFORM pg_advisory_xact_lock(hashtextextended('github.com/'||remote_id||'/'||head_ref,92816421));
 IF EXISTS(SELECT 1 FROM collab_git.head_reservations WHERE github_repository_id=remote_id AND ref=head_ref)
 THEN RAISE EXCEPTION 'task_push_destination_busy' USING ERRCODE='P0001'; END IF;
 SELECT authorization_version INTO ov FROM collab.memberships WHERE organization_id=p.organization_id AND user_id=collab.actor();
 SELECT authorization_version INTO pv FROM collab.project_memberships WHERE project_id=p.project_id AND user_id=collab.actor();
 INSERT INTO collab_git.pull_deliveries(id,organization_id,project_id,task_id,actor_id,organization_version,project_version,request_key,request,github_repository_id,ref)
 VALUES(proposal,p.organization_id,p.project_id,p.task_id,collab.actor(),ov,pv,request_key,payload,remote_id,head_ref);
 INSERT INTO collab_git.head_reservations(github_repository_id,ref,pull_delivery_id) VALUES(remote_id,head_ref,proposal);
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail)
 VALUES(p.organization_id,p.project_id,collab.actor(),'task_pull.creation_requested',proposal::text,payload);
 RETURN collab_git.pull_delivery_result(proposal)||jsonb_build_object('replayed',false);
END $$;
CREATE FUNCTION collab.task_pull_delivery_action(delivery uuid, request_key uuid, action text, reason text, acknowledge_unknown boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE d collab_git.pull_deliveries; prior collab_git.pull_delivery_actions;
BEGIN
 SELECT * INTO d FROM collab_git.pull_deliveries WHERE id=delivery;
 IF d.id IS NULL OR collab.project_role(d.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(d.organization_id::text,811)); PERFORM 1 FROM public."user" WHERE id=collab.actor() FOR SHARE;
 PERFORM 1 FROM collab.tasks WHERE id=d.task_id FOR SHARE;
 IF NOT collab_git.workspace_authority(d.task_id,collab.actor()) OR (action='retire' AND NOT collab_git.push_retire_authority(d.project_id))
 THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF request_key IS NULL OR action IS NULL OR action NOT IN ('cancel','retire') OR reason IS NULL OR length(btrim(reason)) NOT BETWEEN (CASE WHEN action='retire' THEN 20 ELSE 10 END) AND 2000
 OR acknowledge_unknown IS DISTINCT FROM (action='retire') THEN RAISE EXCEPTION 'invalid_task_pull_delivery' USING ERRCODE='P0001'; END IF;
 SELECT * INTO prior FROM collab_git.pull_delivery_actions WHERE delivery_id=delivery AND actor_id=collab.actor() AND pull_delivery_actions.request_key=task_pull_delivery_action.request_key;
 IF FOUND THEN
  IF prior.action<>action OR prior.reason<>btrim(reason) THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
  RETURN collab_git.pull_delivery_result(delivery)||jsonb_build_object('replayed',true);
 END IF;
 SELECT * INTO STRICT d FROM collab_git.pull_deliveries WHERE id=delivery FOR UPDATE;
 IF action='retire' THEN
  IF d.status<>'unknown' THEN RAISE EXCEPTION 'task_pull_not_unknown' USING ERRCODE='P0001'; END IF;
  UPDATE collab_git.head_reservations SET quarantined=true WHERE pull_delivery_id=delivery;
  IF NOT FOUND THEN RAISE EXCEPTION 'task_pull_claim_lost' USING ERRCODE='P0001'; END IF;
  UPDATE collab_git.pull_deliveries SET status='retired',updated_at=now() WHERE id=delivery;
 ELSE
  UPDATE collab_git.pull_deliveries SET stop_requested=true,updated_at=now() WHERE id=delivery AND status IN ('queued','running','unknown');
 END IF;
 INSERT INTO collab_git.pull_delivery_actions VALUES(delivery,collab.actor(),request_key,action,btrim(reason),now());
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail)
 VALUES(d.organization_id,d.project_id,collab.actor(),'task_pull.'||action,delivery::text,jsonb_build_object('reason',btrim(reason)));
 RETURN collab_git.pull_delivery_result(delivery)||jsonb_build_object('replayed',false);
END $$;

CREATE FUNCTION collab_git.claim_pull_delivery() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE d collab_git.pull_deliveries; p collab_git.pull_proposals; nonce uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(94816423);
 FOR d IN SELECT * FROM collab_git.pull_deliveries WHERE status IN ('queued','running') ORDER BY updated_at,id LIMIT 100 LOOP
  IF NOT pg_try_advisory_lock(hashtextextended(d.id::text,94816424)) THEN CONTINUE; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(d.organization_id::text,811));
  SELECT * INTO STRICT d FROM collab_git.pull_deliveries WHERE id=d.id FOR UPDATE;
  IF d.status='running' THEN
   UPDATE collab_git.pull_deliveries SET status=CASE WHEN gate_at IS NULL THEN 'not_created' ELSE 'unknown' END,
    failure='task_pull_reader_lost',updated_at=now(),finished_at=now() WHERE id=d.id;
   IF d.gate_at IS NULL THEN DELETE FROM collab_git.head_reservations WHERE pull_delivery_id=d.id AND NOT quarantined; END IF;
   INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail)
   VALUES(d.organization_id,d.project_id,d.actor_id,'task_pull.owner_lost',d.id::text,jsonb_build_object('gateRecorded',d.gate_at IS NOT NULL));
   PERFORM pg_advisory_unlock(hashtextextended(d.id::text,94816424)); RETURN collab_git.pull_delivery_result(d.id)||jsonb_build_object('recovered',true);
  END IF;
  IF d.status<>'queued' THEN PERFORM pg_advisory_unlock(hashtextextended(d.id::text,94816424)); CONTINUE; END IF;
  nonce:=gen_random_uuid(); UPDATE collab_git.pull_deliveries SET status='running',claim_id=nonce,backend_pid=pg_backend_pid(),updated_at=now() WHERE id=d.id;
  SELECT * INTO STRICT p FROM collab_git.pull_proposals WHERE id=d.id;
  RETURN jsonb_build_object('jobId',d.id,'claimId',nonce,'organizationId',d.organization_id,'connectionId',p.admission->>'connectionId',
   'attempt',p.attempt,'requestText',p.request_text);
 END LOOP; RETURN NULL;
END $$;
CREATE FUNCTION collab_git.lock_pull_delivery(delivery uuid, nonce uuid) RETURNS collab_git.pull_deliveries LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE d collab_git.pull_deliveries;
BEGIN
 SELECT * INTO d FROM collab_git.pull_deliveries WHERE id=delivery;
 IF d.id IS NULL OR nonce IS NULL THEN RAISE EXCEPTION 'task_pull_claim_lost' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(d.organization_id::text,811));
 SELECT * INTO STRICT d FROM collab_git.pull_deliveries WHERE id=delivery FOR UPDATE;
 IF d.status<>'running' OR d.claim_id IS DISTINCT FROM nonce OR d.backend_pid IS DISTINCT FROM pg_backend_pid()
 THEN RAISE EXCEPTION 'task_pull_claim_lost' USING ERRCODE='P0001'; END IF;
 RETURN d;
END $$;
CREATE FUNCTION collab_git.lock_pull_authority(delivery uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab_git.pull_proposals; d collab_git.pull_deliveries;
BEGIN
 SELECT * INTO STRICT p FROM collab_git.pull_proposals WHERE id=delivery;
 SELECT * INTO STRICT d FROM collab_git.pull_deliveries WHERE id=delivery;
 PERFORM 1 FROM public."user" WHERE id IN (p.actor_id,d.actor_id) ORDER BY id FOR SHARE;
 PERFORM 1 FROM collab.tasks WHERE id=p.task_id FOR SHARE;
 PERFORM 1 FROM collab.github_bindings WHERE repository_id=(p.admission->>'repositoryId')::uuid FOR SHARE;
 PERFORM 1 FROM collab.github_installations WHERE id=(p.admission->>'connectionId')::uuid FOR SHARE;
 IF collab_git.pull_delivery_grant(delivery) IS DISTINCT FROM true THEN RAISE EXCEPTION 'task_pull_authority_changed' USING ERRCODE='P0001'; END IF;
END $$;
CREATE FUNCTION collab_git.pull_delivery_live(delivery uuid, nonce uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT COALESCE((SELECT status='running' AND claim_id=nonce AND backend_pid=pg_backend_pid() AND collab_git.pull_delivery_grant(id)
 FROM collab_git.pull_deliveries WHERE id=delivery),false)
$$;
CREATE FUNCTION collab_git.begin_pull_delivery(delivery uuid, nonce uuid, attempt jsonb, request_text text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE d collab_git.pull_deliveries; p collab_git.pull_proposals;
BEGIN
 d:=collab_git.lock_pull_delivery(delivery,nonce); PERFORM collab_git.lock_pull_authority(delivery);
 SELECT * INTO STRICT p FROM collab_git.pull_proposals WHERE id=delivery;
 IF d.started OR attempt IS DISTINCT FROM p.attempt OR request_text IS DISTINCT FROM p.request_text
 THEN RAISE EXCEPTION 'invalid_task_pull_evidence' USING ERRCODE='P0001'; END IF;
 UPDATE collab_git.pull_deliveries SET started=true,updated_at=now() WHERE id=delivery;
 RETURN (SELECT jsonb_build_object('appId',c.app_id,'installationId',c.installation_id,'accountId',c.account_id,'sealed',s.sealed)
 FROM collab.github_installations c JOIN collab_git.credentials s ON s.connection_id=c.id WHERE c.id=(p.admission->>'connectionId')::uuid);
END $$;
CREATE FUNCTION collab_git.gate_pull_delivery(delivery uuid, nonce uuid, attempt jsonb, evidence_text text, evidence_hash text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE d collab_git.pull_deliveries; p collab_git.pull_proposals; c collab.github_installations; e jsonb;
BEGIN
 d:=collab_git.lock_pull_delivery(delivery,nonce); PERFORM collab_git.lock_pull_authority(delivery);
 SELECT * INTO STRICT p FROM collab_git.pull_proposals WHERE id=delivery;
 SELECT * INTO STRICT c FROM collab.github_installations WHERE id=(p.admission->>'connectionId')::uuid;
 IF NOT d.started OR d.gate_at IS NOT NULL OR attempt IS DISTINCT FROM p.attempt OR evidence_text IS NULL OR octet_length(evidence_text)>65536
 OR evidence_hash IS NULL OR encode(sha256(convert_to(evidence_text,'UTF8')),'hex')<>evidence_hash
 THEN RAISE EXCEPTION 'invalid_task_pull_evidence' USING ERRCODE='P0001'; END IF;
 e:=evidence_text::jsonb;
 IF e-ARRAY['installation','baseProtected','verifiedAt'] IS DISTINCT FROM
 jsonb_build_object('version',1,'repository',p.admission->'binding','headRef',p.attempt->'request'->>'head','headSha',p.admission->>'headSha',
 'baseRef',p.attempt->'request'->>'base','baseSha',p.attempt->'intent'->>'baseSha')
 OR jsonb_typeof(e->'baseProtected') IS DISTINCT FROM 'boolean'
 OR e->'installation'->>'appId' IS DISTINCT FROM c.app_id OR e->'installation'->>'installationId' IS DISTINCT FROM c.installation_id
 OR e->'installation'->>'accountId' IS DISTINCT FROM c.account_id OR e->'installation'->'version' IS DISTINCT FROM '1'::jsonb
 OR e->'installation'->'permissions'->>'pull_requests' IS DISTINCT FROM 'write'
 OR COALESCE(e->'installation'->'permissions'->>'contents','') NOT IN ('read','write')
 OR jsonb_typeof(e->'verifiedAt') IS DISTINCT FROM 'string' OR COALESCE(e->>'verifiedAt','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$'
 THEN RAISE EXCEPTION 'invalid_task_pull_evidence' USING ERRCODE='P0001'; END IF;
 IF (e->>'verifiedAt')::timestamptz NOT BETWEEN clock_timestamp()-interval '30 seconds' AND clock_timestamp()+interval '5 seconds'
 THEN RAISE EXCEPTION 'invalid_task_pull_evidence' USING ERRCODE='P0001'; END IF;
 UPDATE collab_git.pull_deliveries SET gate_at=clock_timestamp(),gate_evidence=e,gate_evidence_text=gate_pull_delivery.evidence_text,
 gate_evidence_hash=gate_pull_delivery.evidence_hash,updated_at=now() WHERE id=delivery;
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail)
 VALUES(d.organization_id,d.project_id,d.actor_id,'task_pull.create_gate',delivery::text,jsonb_build_object('requestHash',attempt->>'requestHash','evidenceHash',evidence_hash));
 RETURN true;
END $$;

CREATE FUNCTION collab_git.valid_pull_identity(identity jsonb, binding jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT COALESCE(jsonb_typeof(identity)='object' AND (identity-ARRAY['id','nodeId','number','url'])='{}'::jsonb
 AND jsonb_typeof(identity->'id')='string' AND identity->>'id' ~ '^[1-9][0-9]{0,15}$'
 AND CASE WHEN identity->>'id' ~ '^[1-9][0-9]{0,15}$' THEN (identity->>'id')::numeric<=9007199254740991 ELSE false END
 AND jsonb_typeof(identity->'nodeId')='string' AND length(identity->>'nodeId') BETWEEN 1 AND 200
 AND jsonb_typeof(identity->'number')='number' AND identity->>'number' ~ '^[1-9][0-9]{0,15}$'
 AND CASE WHEN identity->>'number' ~ '^[1-9][0-9]{0,15}$' THEN (identity->>'number')::numeric<=9007199254740991 ELSE false END
 AND identity->>'url'='https://github.com/'||(binding->>'ownerLogin')||'/'||(binding->>'name')||'/pull/'||(identity->>'number'),false)
$$;
CREATE FUNCTION collab_git.valid_pull_snapshot(value jsonb, identity jsonb, gate_time timestamptz) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
BEGIN
 IF jsonb_typeof(value) IS DISTINCT FROM 'object' OR value->'identity' IS DISTINCT FROM identity
 OR NOT (value ?& ARRAY['identity','headRef','headSha','baseRef','baseSha','titleHash','bodyHash','state','draft','merged','mergeCommitSha','maintainerCanModify','updatedAt','observedAt'])
 OR (value-ARRAY['identity','headRef','headSha','baseRef','baseSha','titleHash','bodyHash','state','draft','merged','mergeCommitSha','maintainerCanModify','updatedAt','observedAt'])<>'{}'::jsonb
 OR EXISTS(SELECT 1 FROM unnest(ARRAY['headRef','headSha','baseRef','baseSha','titleHash','bodyHash','state','updatedAt','observedAt']) k WHERE jsonb_typeof(value->k) IS DISTINCT FROM 'string')
 OR jsonb_typeof(value->'headRef') IS DISTINCT FROM 'string' OR length(value->>'headRef') NOT BETWEEN 1 AND 255
 OR jsonb_typeof(value->'baseRef') IS DISTINCT FROM 'string' OR length(value->>'baseRef') NOT BETWEEN 1 AND 255
 OR COALESCE(value->>'headSha','')!~'^[a-f0-9]{40}$' OR value->>'headSha'=repeat('0',40)
 OR COALESCE(value->>'baseSha','')!~'^[a-f0-9]{40}$' OR value->>'baseSha'=repeat('0',40)
 OR COALESCE(value->>'titleHash','')!~'^[a-f0-9]{64}$' OR COALESCE(value->>'bodyHash','')!~'^[a-f0-9]{64}$'
 OR COALESCE(value->>'state','') NOT IN ('open','closed') OR jsonb_typeof(value->'draft') IS DISTINCT FROM 'boolean'
 OR jsonb_typeof(value->'merged') IS DISTINCT FROM 'boolean' OR jsonb_typeof(value->'maintainerCanModify') IS DISTINCT FROM 'boolean'
 OR (value->'mergeCommitSha' IS DISTINCT FROM 'null'::jsonb AND (jsonb_typeof(value->'mergeCommitSha') IS DISTINCT FROM 'string' OR COALESCE(value->>'mergeCommitSha','')!~'^[a-f0-9]{40}$' OR value->>'mergeCommitSha'=repeat('0',40)))
 OR COALESCE(value->>'updatedAt','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$'
 OR COALESCE(value->>'observedAt','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$' THEN RETURN false; END IF;
 PERFORM (value->>'updatedAt')::timestamptz;
 RETURN (value->>'observedAt')::timestamptz BETWEEN gate_time-interval '5 seconds' AND clock_timestamp()+interval '5 seconds';
END $$;
CREATE FUNCTION collab_git.pull_snapshot_matches(value jsonb, attempt jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT COALESCE(value->>'headRef'=attempt->'request'->>'head' AND value->>'baseRef'=attempt->'request'->>'base'
 AND value->>'headSha'=attempt->'intent'->>'headSha' AND value->>'baseSha'=attempt->'intent'->>'baseSha'
 AND value->>'titleHash'=encode(sha256(convert_to(attempt->'request'->>'title','UTF8')),'hex')
 AND value->>'bodyHash'=encode(sha256(convert_to(attempt->'request'->>'body','UTF8')),'hex')
 AND value->>'state'='open' AND value->'draft'='true'::jsonb AND value->'merged'='false'::jsonb AND value->'maintainerCanModify'='false'::jsonb,false)
$$;
CREATE FUNCTION collab_git.finish_pull_delivery(delivery uuid, nonce uuid, receipt_text text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE d collab_git.pull_deliveries; p collab_git.pull_proposals; r jsonb; o jsonb; effect text; item jsonb; n integer; evidence_text text;
BEGIN
 d:=collab_git.lock_pull_delivery(delivery,nonce); SELECT * INTO STRICT p FROM collab_git.pull_proposals WHERE id=delivery;
 IF NOT d.started OR receipt_text IS NULL OR octet_length(receipt_text)>65536 THEN RAISE EXCEPTION 'invalid_task_pull_evidence' USING ERRCODE='P0001'; END IF;
 r:=receipt_text::jsonb; o:=r->'outcome'; effect:=o->>'status';
 IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR NOT (r ?& ARRAY['createStarted','failure','evidence','credential','outcome'])
 OR (r-ARRAY['createStarted','failure','evidence','credential','outcome'])<>'{}'::jsonb
 OR jsonb_typeof(r->'createStarted') IS DISTINCT FROM 'boolean' OR jsonb_typeof(r->'credential') IS DISTINCT FROM 'object'
 OR NOT ((r->'credential') ?& ARRAY['status','expiresAt']) OR ((r->'credential')-ARRAY['status','expiresAt'])<>'{}'::jsonb
 OR COALESCE(r->'credential'->>'status','') NOT IN ('not_requested','issuance_unconfirmed','revoked','revocation_unconfirmed')
 OR (r->'credential'->'expiresAt' IS DISTINCT FROM 'null'::jsonb AND COALESCE(r->'credential'->>'expiresAt','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$')
 OR (r->'failure' IS DISTINCT FROM 'null'::jsonb AND (jsonb_typeof(r->'failure') IS DISTINCT FROM 'string' OR COALESCE(r->>'failure','')!~'^[a-z_]{1,120}$'))
 OR (r->'evidence' IS DISTINCT FROM 'null'::jsonb AND jsonb_typeof(r->'evidence') IS DISTINCT FROM 'object')
 OR jsonb_typeof(o) IS DISTINCT FROM 'object' OR effect IS NULL OR effect NOT IN ('not_created','rejected','unknown','created')
 THEN RAISE EXCEPTION 'invalid_task_pull_evidence' USING ERRCODE='P0001'; END IF;
 IF r->'createStarted'='true'::jsonb THEN
  IF d.gate_at IS NULL OR r->'evidence' IS DISTINCT FROM d.gate_evidence OR effect='not_created'
  OR r->'credential'->>'status' NOT IN ('revoked','revocation_unconfirmed') OR r->'credential'->'expiresAt'='null'::jsonb
  THEN RAISE EXCEPTION 'invalid_task_pull_evidence' USING ERRCODE='P0001'; END IF;
 ELSE
  IF effect<>'not_created' THEN RAISE EXCEPTION 'invalid_task_pull_evidence' USING ERRCODE='P0001'; END IF;
 END IF;
 IF effect='not_created' THEN
  IF (o-ARRAY['status','reason','existing'])<>'{}'::jsonb OR COALESCE(o->>'reason','') NOT IN ('preflight_failed','authority_denied','cancelled','existing_pull')
  OR (o ? 'existing' AND (o->>'reason'<>'existing_pull' OR jsonb_typeof(o->'existing') IS DISTINCT FROM 'array'))
  OR (o->>'reason'='existing_pull' AND (jsonb_typeof(o->'existing') IS DISTINCT FROM 'array' OR jsonb_array_length(o->'existing') NOT BETWEEN 1 AND 2))
  THEN RAISE EXCEPTION 'invalid_task_pull_evidence' USING ERRCODE='P0001'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(COALESCE(o->'existing','[]'::jsonb)) LOOP
   IF NOT collab_git.valid_pull_identity(item,p.admission->'binding') THEN RAISE EXCEPTION 'invalid_task_pull_evidence' USING ERRCODE='P0001'; END IF;
  END LOOP;
 ELSIF effect='rejected' THEN
  IF (o-ARRAY['status','httpStatus'])<>'{}'::jsonb OR o->'httpStatus' NOT IN ('403'::jsonb,'422'::jsonb) OR NOT (o ? 'httpStatus')
  THEN RAISE EXCEPTION 'invalid_task_pull_evidence' USING ERRCODE='P0001'; END IF;
 ELSIF effect='unknown' THEN
  IF o IS DISTINCT FROM '{"status":"unknown","reason":"creation_unconfirmed"}'::jsonb THEN RAISE EXCEPTION 'invalid_task_pull_evidence' USING ERRCODE='P0001'; END IF;
 ELSE
  IF NOT (o ?& ARRAY['status','pull','creation','current','revision']) OR (o-ARRAY['status','pull','creation','current','revision'])<>'{}'::jsonb
  OR NOT collab_git.valid_pull_identity(o->'pull',p.admission->'binding') OR COALESCE(o->>'revision','') NOT IN ('matching','changed','unavailable')
  OR NOT collab_git.valid_pull_snapshot(o->'creation',o->'pull',d.gate_at)
  OR (o->'current' IS DISTINCT FROM 'null'::jsonb AND NOT collab_git.valid_pull_snapshot(o->'current',o->'pull',d.gate_at))
  OR (o->>'revision'='matching' AND (NOT collab_git.pull_snapshot_matches(o->'creation',p.attempt) OR NOT collab_git.pull_snapshot_matches(o->'current',p.attempt)))
  THEN RAISE EXCEPTION 'invalid_task_pull_evidence' USING ERRCODE='P0001'; END IF;
  INSERT INTO collab_git.pull_changes(id,github_repository_id,pull_id,pull_number,node_id,url)
  VALUES(delivery,d.github_repository_id,o->'pull'->>'id',(o->'pull'->>'number')::bigint,o->'pull'->>'nodeId',o->'pull'->>'url');
  FOR n IN 1..2 LOOP
   item:=CASE WHEN n=1 THEN o->'creation' ELSE o->'current' END;
   IF item='null'::jsonb THEN CONTINUE; END IF;
   evidence_text:=item::text;
   INSERT INTO collab_git.pull_change_observations(change_id,sequence,kind,source_sha,target_sha,evidence,evidence_text,evidence_hash)
   VALUES(delivery,n,CASE WHEN n=1 THEN 'creation' ELSE 'followup' END,item->>'headSha',item->>'baseSha',item,evidence_text,encode(sha256(convert_to(evidence_text,'UTF8')),'hex'));
  END LOOP;
 END IF;
 UPDATE collab_git.pull_deliveries SET status=effect,result=r,result_text=receipt_text,result_hash=encode(sha256(convert_to(receipt_text,'UTF8')),'hex'),
 failure=r->>'failure',updated_at=now(),finished_at=now() WHERE id=delivery;
 IF effect<>'unknown' THEN DELETE FROM collab_git.head_reservations WHERE pull_delivery_id=delivery AND NOT quarantined; END IF;
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail)
 VALUES(d.organization_id,d.project_id,d.actor_id,'task_pull.finished',delivery::text,jsonb_build_object('status',effect,'credential',r->'credential'->>'status'));
 RETURN collab_git.pull_delivery_result(delivery);
END $$;
CREATE FUNCTION collab_git.fail_pull_delivery(delivery uuid, nonce uuid, failure_code text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE d collab_git.pull_deliveries;
BEGIN
 d:=collab_git.lock_pull_delivery(delivery,nonce);
 IF failure_code IS NULL OR failure_code!~'^[a-z_]{1,120}$' THEN RAISE EXCEPTION 'invalid_task_pull_evidence' USING ERRCODE='P0001'; END IF;
 UPDATE collab_git.pull_deliveries SET status=CASE WHEN gate_at IS NULL THEN 'not_created' ELSE 'unknown' END,
 failure=failure_code,updated_at=now(),finished_at=now() WHERE id=delivery;
 IF d.gate_at IS NULL THEN DELETE FROM collab_git.head_reservations WHERE pull_delivery_id=delivery AND NOT quarantined; END IF;
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail)
 VALUES(d.organization_id,d.project_id,d.actor_id,'task_pull.failed',delivery::text,jsonb_build_object('failure',failure_code,'gateRecorded',d.gate_at IS NOT NULL));
 RETURN collab_git.pull_delivery_result(delivery);
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA collab_git FROM PUBLIC;
REVOKE ALL ON FUNCTION collab.task_pull_delivery_context(uuid),collab.request_task_pull_delivery(uuid,uuid,jsonb),collab.task_pull_delivery_action(uuid,uuid,text,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.task_pull_delivery_context(uuid),collab.request_task_pull_delivery(uuid,uuid,jsonb),collab.task_pull_delivery_action(uuid,uuid,text,text,boolean) TO pi_collab_app;
GRANT EXECUTE ON FUNCTION collab_git.claim_pull_delivery(),collab_git.begin_pull_delivery(uuid,uuid,jsonb,text),collab_git.pull_delivery_live(uuid,uuid),
 collab_git.gate_pull_delivery(uuid,uuid,jsonb,text,text),collab_git.finish_pull_delivery(uuid,uuid,text),collab_git.fail_pull_delivery(uuid,uuid,text) TO pi_collab_git;
