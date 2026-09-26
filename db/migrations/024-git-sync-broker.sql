-- Browser requests and a dedicated, non-administrative native Git broker.
CREATE TABLE collab_git.sync_dispatch (
 sync_id uuid PRIMARY KEY REFERENCES collab.github_syncs(id),
 state text NOT NULL CHECK(state IN ('queued','running','attention','done')),
 mode text NOT NULL CHECK(mode IN ('sync','reconcile')),
 actor_id text NOT NULL REFERENCES public."user"(id), organization_version bigint NOT NULL, project_version bigint NOT NULL,
 stop_requested boolean NOT NULL DEFAULT false, claim_id uuid, backend_pid integer, gate_txid bigint, gate_kind text,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE collab.github_sync_actions (
 sync_id uuid NOT NULL REFERENCES collab.github_syncs(id), actor_id text NOT NULL REFERENCES public."user"(id), idempotency_key uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('cancel','reconcile')), reason text NOT NULL CHECK(length(reason) BETWEEN 10 AND 2000), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(sync_id,actor_id,idempotency_key)
);

CREATE FUNCTION collab_git.sync_authority(project uuid, actor text, org_version bigint DEFAULT NULL, project_version bigint DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM collab.projects p JOIN collab.memberships m ON m.organization_id=p.organization_id AND m.user_id=actor
 JOIN collab.project_memberships pm ON pm.project_id=p.id AND pm.user_id=m.user_id JOIN public."user" u ON u.id=m.user_id
 WHERE p.id=project AND m.active AND pm.active AND pm.role='maintainer' AND u."twoFactorEnabled"
 AND (org_version IS NULL OR m.authorization_version=org_version) AND (project_version IS NULL OR pm.authorization_version=project_version))
$$;
CREATE FUNCTION collab.github_sync_dispatch_state(operation uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('state',d.state,'mode',d.mode,'stopRequested',d.stop_requested) FROM collab_git.sync_dispatch d JOIN collab.github_syncs s ON s.id=d.sync_id
 WHERE s.id=operation AND collab.project_role(s.project_id) IS NOT NULL
$$;
CREATE FUNCTION collab.request_github_sync(repository uuid, expected_sha text, expected_branch text, acknowledge boolean, reason text, request_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab.repositories; b collab.github_bindings; prior collab.github_syncs; operation uuid:=gen_random_uuid(); payload jsonb; ov bigint; pv bigint;
BEGIN
 SELECT * INTO r FROM collab.repositories WHERE id=repository;
 IF r.id IS NULL OR collab.project_role(r.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(82467116); PERFORM pg_advisory_xact_lock(hashtextextended(r.organization_id::text,811));
 PERFORM 1 FROM public."user" WHERE id=collab.actor() FOR SHARE;
 IF collab.project_role(r.project_id) IS DISTINCT FROM 'maintainer' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
 IF expected_sha IS NULL OR expected_sha!~'^[a-f0-9]{40}$' OR expected_branch IS NULL OR length(expected_branch) NOT BETWEEN 1 AND 240 OR acknowledge IS DISTINCT FROM true OR reason IS NULL OR length(btrim(reason)) NOT BETWEEN 10 AND 2000 OR request_key IS NULL THEN RAISE EXCEPTION 'invalid_github_sync' USING ERRCODE='P0001'; END IF;
 payload:=jsonb_build_object('reason',btrim(reason),'expectedSha',expected_sha,'expectedBranch',expected_branch,'acknowledge',true);
 SELECT * INTO prior FROM collab.github_syncs WHERE repository_id=repository AND actor_id=collab.actor() AND idempotency_key=request_key;
 IF FOUND THEN
  IF prior.request<>payload THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
  RETURN jsonb_build_object('jobId',prior.id,'status',prior.status,'replayed',true);
 END IF;
 SELECT * INTO STRICT r FROM collab.repositories WHERE id=repository;
 IF r.base_sha<>expected_sha OR r.default_branch<>expected_branch THEN RAISE EXCEPTION 'stale_github_sync' USING ERRCODE='P0001'; END IF;
 SELECT binding.* INTO b FROM collab.github_bindings binding JOIN collab.github_installations c ON c.id=binding.connection_id WHERE binding.repository_id=repository AND c.enabled AND c.version=binding.installation_version;
 IF NOT FOUND THEN RAISE EXCEPTION 'github_connection_unavailable' USING ERRCODE='P0001'; END IF;
 IF EXISTS(SELECT 1 FROM collab.github_syncs WHERE repository_id=repository AND target_branch=r.default_branch AND status NOT IN ('completed','failed'))
 OR EXISTS(SELECT 1 FROM collab.promotions WHERE repository_id=repository AND target_branch=r.default_branch AND status NOT IN ('applied','aborted'))
 OR EXISTS(SELECT 1 FROM collab.integrations WHERE repository_id=repository AND target_branch=r.default_branch AND status IN ('integrating','checking','unknown')) THEN RAISE EXCEPTION 'github_sync_target_busy' USING ERRCODE='P0001'; END IF;
 IF (SELECT count(*) FROM collab.github_syncs WHERE project_id=r.project_id AND status NOT IN ('completed','failed'))>=20 THEN RAISE EXCEPTION 'github_sync_limit' USING ERRCODE='P0001'; END IF;
 SELECT authorization_version INTO ov FROM collab.memberships WHERE organization_id=r.organization_id AND user_id=collab.actor();
 SELECT authorization_version INTO pv FROM collab.project_memberships WHERE project_id=r.project_id AND user_id=collab.actor();
 INSERT INTO collab.github_syncs(id,organization_id,project_id,repository_id,connection_id,github_repository_id,installation_version,actor_id,organization_version,project_version,idempotency_key,request,target_branch,old_sha)
 VALUES(operation,r.organization_id,r.project_id,r.id,b.connection_id,b.github_repository_id,b.installation_version,collab.actor(),ov,pv,request_key,payload,r.default_branch,r.base_sha);
 INSERT INTO collab_git.sync_dispatch(sync_id,state,mode,actor_id,organization_version,project_version) VALUES(operation,'queued','sync',collab.actor(),ov,pv);
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(r.organization_id,r.project_id,collab.actor(),'github.sync_requested',operation::text,payload||jsonb_build_object('source','web','repositoryId',r.id));
 RETURN jsonb_build_object('jobId',operation,'status','pending','replayed',false);
END $$;

CREATE FUNCTION collab.github_sync_action(operation uuid, action text, reason text, request_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s collab.github_syncs; prior collab.github_sync_actions; d collab_git.sync_dispatch; ov bigint; pv bigint;
BEGIN
 SELECT * INTO s FROM collab.github_syncs WHERE id=operation;
 IF s.id IS NULL OR collab.project_role(s.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(s.organization_id::text,811)); PERFORM 1 FROM public."user" WHERE id=collab.actor() FOR SHARE;
 IF collab.project_role(s.project_id) IS DISTINCT FROM 'maintainer' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
 IF action IS NULL OR action NOT IN ('cancel','reconcile') OR reason IS NULL OR length(btrim(reason)) NOT BETWEEN 10 AND 2000 OR request_key IS NULL THEN RAISE EXCEPTION 'invalid_github_sync' USING ERRCODE='P0001'; END IF;
 SELECT * INTO prior FROM collab.github_sync_actions WHERE sync_id=operation AND actor_id=collab.actor() AND idempotency_key=request_key;
 IF FOUND THEN
  IF prior.kind<>action OR prior.reason<>btrim(reason) THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
  RETURN jsonb_build_object('jobId',operation,'replayed',true);
 END IF;
 SELECT * INTO STRICT s FROM collab.github_syncs WHERE id=operation;
 SELECT * INTO d FROM collab_git.sync_dispatch WHERE sync_id=operation FOR UPDATE;
 IF s.status NOT IN ('completed','failed') THEN
  IF action='cancel' AND d.sync_id IS NOT NULL AND d.state IN ('queued','running') THEN
   UPDATE collab_git.sync_dispatch SET stop_requested=true,updated_at=now() WHERE sync_id=operation;
  ELSE
   -- Nonblocking lock avoids waiting while holding authority locks. No live
   -- broker/legacy CLI can be replaced. Recovery never queues another apply.
   IF NOT pg_try_advisory_xact_lock(hashtextextended(operation::text,918276433)) THEN RAISE EXCEPTION 'github_sync_busy' USING ERRCODE='P0001'; END IF;
   SELECT authorization_version INTO ov FROM collab.memberships WHERE organization_id=s.organization_id AND user_id=collab.actor();
   SELECT authorization_version INTO pv FROM collab.project_memberships WHERE project_id=s.project_id AND user_id=collab.actor();
   INSERT INTO collab_git.sync_dispatch(sync_id,state,mode,actor_id,organization_version,project_version,stop_requested)
   VALUES(operation,'queued','reconcile',collab.actor(),ov,pv,true)
   ON CONFLICT(sync_id) DO UPDATE SET state='queued',mode='reconcile',actor_id=EXCLUDED.actor_id,organization_version=EXCLUDED.organization_version,project_version=EXCLUDED.project_version,stop_requested=true,claim_id=NULL,backend_pid=NULL,updated_at=now();
  END IF;
 END IF;
 INSERT INTO collab.github_sync_actions VALUES(operation,collab.actor(),request_key,action,btrim(reason),now());
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(s.organization_id,s.project_id,collab.actor(),'github.sync_'||action||'_requested',operation::text,jsonb_build_object('reason',btrim(reason),'source','web'));
 RETURN jsonb_build_object('jobId',operation,'replayed',false);
END $$;

-- Defense in depth against an old administrator CLI accidentally handling a
-- job transferred to the broker. This is not protection against hostile admins.
CREATE FUNCTION collab_git.guard_dispatch_update() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE d collab_git.sync_dispatch;
BEGIN
 SELECT * INTO d FROM collab_git.sync_dispatch WHERE sync_id=NEW.id;
 IF d.sync_id IS NOT NULL AND (d.state<>'running' OR d.backend_pid IS DISTINCT FROM pg_backend_pid()) THEN RAISE EXCEPTION 'github_sync_managed_by_broker' USING ERRCODE='P0001'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER github_sync_broker_owner BEFORE UPDATE ON collab.github_syncs FOR EACH ROW EXECUTE FUNCTION collab_git.guard_dispatch_update();

CREATE FUNCTION collab_git.claim_sync() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE d collab_git.sync_dispatch; s collab.github_syncs; nonce uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(918276434);
 FOR d IN SELECT * FROM collab_git.sync_dispatch WHERE state IN ('queued','running') ORDER BY updated_at,sync_id LIMIT 100 LOOP
  IF NOT pg_try_advisory_lock(hashtextextended(d.sync_id::text,918276433)) THEN CONTINUE; END IF;
  SELECT * INTO STRICT s FROM collab.github_syncs WHERE id=d.sync_id;
  PERFORM pg_advisory_xact_lock(hashtextextended(s.organization_id::text,811));
  SELECT * INTO STRICT d FROM collab_git.sync_dispatch WHERE sync_id=s.id FOR UPDATE;
  IF s.status IN ('completed','failed') THEN
   UPDATE collab_git.sync_dispatch SET state='done',updated_at=now() WHERE sync_id=s.id;
   PERFORM pg_advisory_unlock(hashtextextended(s.id::text,918276433)); CONTINUE;
  END IF;
  IF d.state='running' THEN
   UPDATE collab_git.sync_dispatch SET state='attention',updated_at=now() WHERE sync_id=s.id;
   INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(s.organization_id,s.project_id,d.actor_id,'github.sync_broker_lost',s.id::text,'{}');
   PERFORM pg_advisory_unlock(hashtextextended(s.id::text,918276433));
   RETURN jsonb_build_object('attentionJob',s.id);
  END IF;
  IF d.state<>'queued' THEN PERFORM pg_advisory_unlock(hashtextextended(s.id::text,918276433)); CONTINUE; END IF;
  nonce:=gen_random_uuid();
  UPDATE collab_git.sync_dispatch SET state='running',claim_id=nonce,backend_pid=pg_backend_pid(),gate_txid=NULL,gate_kind=NULL,updated_at=now() WHERE sync_id=s.id;
  RETURN jsonb_build_object('claimId',nonce,'mode',d.mode,'job',to_jsonb(s));
 END LOOP;
 RETURN NULL;
END $$;
CREATE FUNCTION collab_git.lock_sync(operation uuid, nonce uuid) RETURNS collab.github_syncs LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s collab.github_syncs; d collab_git.sync_dispatch;
BEGIN
 SELECT * INTO s FROM collab.github_syncs WHERE id=operation;
 IF s.id IS NULL OR nonce IS NULL THEN RAISE EXCEPTION 'github_sync_claim_lost' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(s.organization_id::text,811));
 SELECT * INTO d FROM collab_git.sync_dispatch WHERE sync_id=operation FOR UPDATE;
 IF d.state IS DISTINCT FROM 'running' OR d.claim_id IS DISTINCT FROM nonce OR d.backend_pid IS DISTINCT FROM pg_backend_pid() THEN RAISE EXCEPTION 'github_sync_claim_lost' USING ERRCODE='P0001'; END IF;
 SELECT * INTO STRICT s FROM collab.github_syncs WHERE id=operation FOR UPDATE; RETURN s;
END $$;
CREATE FUNCTION collab_git.sync_grant(operation uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s collab.github_syncs; d collab_git.sync_dispatch;
BEGIN
 SELECT * INTO STRICT s FROM collab.github_syncs WHERE id=operation; SELECT * INTO STRICT d FROM collab_git.sync_dispatch WHERE sync_id=operation;
 IF d.stop_requested OR d.mode<>'sync' OR NOT collab_git.sync_authority(s.project_id,s.actor_id,s.organization_version,s.project_version) THEN RETURN false; END IF;
 RETURN EXISTS(SELECT 1 FROM collab.repositories r JOIN collab.github_bindings b ON b.repository_id=r.id JOIN collab.github_installations c ON c.id=b.connection_id
 WHERE r.id=s.repository_id AND r.base_sha=s.old_sha AND r.default_branch=s.target_branch AND c.enabled AND c.version=s.installation_version AND b.installation_version=c.version
 AND c.id=s.connection_id AND b.github_repository_id=s.github_repository_id);
END $$;
CREATE FUNCTION collab_git.begin_sync(operation uuid, nonce uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s collab.github_syncs; c collab.github_installations;
BEGIN
 s:=collab_git.lock_sync(operation,nonce); PERFORM 1 FROM public."user" WHERE id=s.actor_id FOR SHARE;
 IF EXISTS(SELECT 1 FROM collab_git.sync_dispatch WHERE sync_id=operation AND stop_requested) AND s.input IS NULL THEN RAISE EXCEPTION 'github_sync_cancelled' USING ERRCODE='P0001'; END IF;
 IF s.status<>'pending' OR s.input IS NOT NULL OR NOT collab_git.sync_grant(operation) THEN RAISE EXCEPTION 'github_sync_authority_changed' USING ERRCODE='P0001'; END IF;
 SELECT * INTO STRICT c FROM collab.github_installations WHERE id=s.connection_id;
 UPDATE collab.github_syncs SET status='fetching' WHERE id=operation;
 RETURN jsonb_build_object('appId',c.app_id,'installationId',c.installation_id,'accountId',c.account_id,'sealed',(SELECT sealed FROM collab_git.credentials WHERE connection_id=c.id));
END $$;
CREATE FUNCTION collab_git.record_sync(operation uuid, result_outcome text, result_observation jsonb DEFAULT NULL, result_failure text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s collab.github_syncs; d collab_git.sync_dispatch;
BEGIN
 SELECT * INTO STRICT s FROM collab.github_syncs WHERE id=operation; SELECT * INTO STRICT d FROM collab_git.sync_dispatch WHERE sync_id=operation;
 UPDATE collab.github_syncs SET status=CASE WHEN result_outcome IS NOT NULL THEN 'completed' WHEN s.input IS NULL THEN 'failed' ELSE 'blocked' END,
 outcome=result_outcome,observation=result_observation,failure=result_failure,finished_at=CASE WHEN result_outcome IS NOT NULL OR s.input IS NULL THEN now() END WHERE id=operation;
 UPDATE collab_git.sync_dispatch SET state=CASE WHEN result_outcome IS NOT NULL OR s.input IS NULL THEN 'done' ELSE 'attention' END,updated_at=now() WHERE sync_id=operation;
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(s.organization_id,s.project_id,d.actor_id,'github.sync_'||COALESCE(result_outcome,CASE WHEN s.input IS NULL THEN 'failed' ELSE 'blocked' END),s.id::text,jsonb_build_object('source','git-broker','observation',result_observation,'failure',result_failure,'requestedBy',s.actor_id));
 RETURN jsonb_build_object('jobId',s.id,'outcome',result_outcome,'status',(SELECT status FROM collab.github_syncs WHERE id=operation));
END $$;
CREATE FUNCTION collab_git.admit_sync_effect(operation uuid, nonce uuid, classification text, evidence jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s collab.github_syncs; c collab.github_installations; fixed_input jsonb;
BEGIN
 s:=collab_git.lock_sync(operation,nonce); PERFORM 1 FROM public."user" WHERE id=s.actor_id FOR SHARE;
 IF EXISTS(SELECT 1 FROM collab_git.sync_dispatch WHERE sync_id=operation AND stop_requested) AND s.input IS NULL THEN RAISE EXCEPTION 'github_sync_cancelled' USING ERRCODE='P0001'; END IF;
 IF s.status<>'fetching' OR s.input IS NOT NULL OR NOT collab_git.sync_grant(operation) THEN RAISE EXCEPTION 'github_sync_authority_changed' USING ERRCODE='P0001'; END IF;
 SELECT * INTO STRICT c FROM collab.github_installations WHERE id=s.connection_id;
 IF classification IS NULL OR classification NOT IN ('equal','remote_ahead','local_ahead','diverged','branch_changed') OR evidence IS NULL OR jsonb_typeof(evidence)<>'object' OR pg_column_size(evidence)>65536
 OR evidence->>'repositoryId' IS DISTINCT FROM s.github_repository_id OR evidence->'tokenRevoked' IS DISTINCT FROM 'true'::jsonb
 OR evidence->'installation'->>'appId' IS DISTINCT FROM c.app_id OR evidence->'installation'->>'installationId' IS DISTINCT FROM c.installation_id OR evidence->'installation'->>'accountId' IS DISTINCT FROM c.account_id
 OR COALESCE(evidence->>'targetSha','')!~'^[a-f0-9]{40}$' OR COALESCE(evidence->>'verifiedAt','')!~'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
 OR (classification='equal' AND evidence->>'targetSha'<>s.old_sha) OR (classification='remote_ahead' AND evidence->>'targetSha'=s.old_sha)
 OR (classification<>'branch_changed' AND evidence->>'defaultBranch' IS DISTINCT FROM s.target_branch)
 THEN RAISE EXCEPTION 'invalid_github_sync_evidence' USING ERRCODE='P0001'; END IF;
 IF classification='remote_ahead' THEN fixed_input:=jsonb_build_object('version',1,'syncId',s.id,'repositoryId',s.repository_id,'targetBranch',s.target_branch,'oldSha',s.old_sha,'newSha',evidence->>'targetSha','observedAt',evidence->>'verifiedAt'); END IF;
 UPDATE collab.github_syncs SET classification=admit_sync_effect.classification,evidence=admit_sync_effect.evidence,input=fixed_input,status=CASE WHEN fixed_input IS NOT NULL THEN 'applying' ELSE status END WHERE id=operation;
 UPDATE collab.github_bindings SET evidence=admit_sync_effect.evidence,verified_at=(admit_sync_effect.evidence->>'verifiedAt')::timestamptz WHERE repository_id=s.repository_id;
 IF fixed_input IS NULL THEN RETURN collab_git.record_sync(operation,classification); END IF;
 RETURN jsonb_build_object('input',fixed_input);
END $$;
CREATE FUNCTION collab_git.gate_sync(operation uuid, nonce uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s collab.github_syncs;
BEGIN
 s:=collab_git.lock_sync(operation,nonce); PERFORM 1 FROM public."user" WHERE id=s.actor_id FOR SHARE;
 IF s.status<>'applying' OR s.input IS NULL THEN RAISE EXCEPTION 'github_sync_claim_lost' USING ERRCODE='P0001'; END IF;
 UPDATE collab_git.sync_dispatch SET gate_txid=txid_current(),gate_kind=CASE WHEN collab_git.sync_grant(operation) THEN 'apply' ELSE 'close' END WHERE sync_id=operation;
 RETURN collab_git.sync_grant(operation);
END $$;
CREATE FUNCTION collab_git.gate_sync_reconcile(operation uuid, nonce uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s collab.github_syncs; d collab_git.sync_dispatch;
BEGIN
 s:=collab_git.lock_sync(operation,nonce); SELECT * INTO STRICT d FROM collab_git.sync_dispatch WHERE sync_id=operation;
 PERFORM 1 FROM public."user" WHERE id=d.actor_id FOR SHARE;
 IF d.mode<>'reconcile' OR NOT collab_git.sync_authority(s.project_id,d.actor_id,d.organization_version,d.project_version) THEN RAISE EXCEPTION 'github_sync_authority_changed' USING ERRCODE='P0001'; END IF;
 UPDATE collab_git.sync_dispatch SET gate_txid=txid_current(),gate_kind='reconcile' WHERE sync_id=operation;
 RETURN s.input;
END $$;

-- Identical JSON field order and Git object bytes to syncGitInput/receipts.
CREATE FUNCTION collab_git.sync_oid(input jsonb, decision text) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE fixed_json text; body text; person text; bytes bytea;
BEGIN
 IF decision NOT IN ('prepared','applied','aborted') THEN RAISE EXCEPTION 'invalid_github_sync_evidence' USING ERRCODE='P0001'; END IF;
 SELECT '{"version":1,'||string_agg(to_json(k)::text||':'||to_json(input->>k)::text,',' ORDER BY ordinal)||'}' INTO fixed_json
 FROM unnest(ARRAY['syncId','repositoryId','targetBranch','oldSha','newSha','observedAt']) WITH ORDINALITY f(k,ordinal);
 person:='pi-collab sync <sync@pi-collab.local> '||floor(extract(epoch FROM (input->>'observedAt')::timestamptz))::bigint::text||' +0000';
 body:=E'tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n'||CASE WHEN decision='aborted' THEN '' ELSE 'parent '||(input->>'newSha')||E'\n' END||'author '||person||E'\ncommitter '||person||E'\n\n{"version":1,"kind":"pi-collab-github-sync","decision":'||to_json(decision)::text||',"input":'||fixed_json||E'}\n';
 bytes:=convert_to(body,'UTF8'); RETURN encode(collab_crypto.digest(convert_to('commit '||octet_length(bytes)::text,'UTF8')||decode('00','hex')||bytes,'sha1'),'hex');
END $$;
CREATE FUNCTION collab_git.finish_sync(operation uuid, nonce uuid, observation jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s collab.github_syncs; r collab.repositories; d collab_git.sync_dispatch; decision text; seq bigint;
BEGIN
 s:=collab_git.lock_sync(operation,nonce); decision:=observation->>'decision'; SELECT * INTO STRICT d FROM collab_git.sync_dispatch WHERE sync_id=operation;
 IF d.gate_txid IS DISTINCT FROM txid_current() OR d.gate_kind IS NULL OR (decision='applied' AND d.gate_kind NOT IN ('apply','reconcile')) THEN RAISE EXCEPTION 'github_sync_gate_required' USING ERRCODE='P0001'; END IF;
 IF s.input IS NULL OR observation IS NULL OR jsonb_typeof(observation)<>'object' OR (observation-ARRAY['decision','receiptOid','targetSha'])<>'{}'::jsonb
 OR decision IS NULL OR decision NOT IN ('applied','aborted') OR observation->>'receiptOid' IS DISTINCT FROM collab_git.sync_oid(s.input,decision)
 THEN RAISE EXCEPTION 'invalid_github_sync_evidence' USING ERRCODE='P0001'; END IF;
 SELECT * INTO STRICT r FROM collab.repositories WHERE id=s.repository_id FOR UPDATE;
 IF r.base_sha=s.old_sha AND r.default_branch=s.target_branch THEN
  IF decision='aborted' AND observation->>'targetSha'=s.old_sha THEN RETURN collab_git.record_sync(operation,'aborted',observation); END IF;
  IF decision='applied' AND observation->>'targetSha'=s.input->>'newSha' THEN
   UPDATE collab.repositories SET base_sha=s.input->>'newSha' WHERE id=r.id;
   UPDATE collab.projects SET event_sequence=event_sequence+1 WHERE id=s.project_id RETURNING event_sequence INTO seq;
   INSERT INTO collab.repository_baselines(organization_id,project_id,repository_id,sync_id,sequence,target_branch,old_sha,new_sha) VALUES(s.organization_id,s.project_id,r.id,s.id,seq,s.target_branch,s.old_sha,s.input->>'newSha');
   RETURN collab_git.record_sync(operation,'fast_forward',observation);
  END IF;
 END IF;
 RETURN collab_git.record_sync(operation,NULL,observation,'github_sync_target_diverged');
END $$;
CREATE FUNCTION collab_git.fail_sync(operation uuid, nonce uuid, failure text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s collab.github_syncs;
BEGIN
 s:=collab_git.lock_sync(operation,nonce);
 IF failure IS NULL OR failure!~'^[a-z_]{1,120}$' THEN RAISE EXCEPTION 'invalid_github_sync_evidence' USING ERRCODE='P0001'; END IF;
 RETURN collab_git.record_sync(operation,NULL,NULL,failure);
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA collab_git FROM PUBLIC;
REVOKE ALL ON FUNCTION collab.request_github_sync(uuid,text,text,boolean,text,uuid),collab.github_sync_action(uuid,text,text,uuid),collab.github_sync_dispatch_state(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.request_github_sync(uuid,text,text,boolean,text,uuid),collab.github_sync_action(uuid,text,text,uuid),collab.github_sync_dispatch_state(uuid) TO pi_collab_app;
GRANT USAGE ON SCHEMA collab_git TO pi_collab_git;
GRANT EXECUTE ON FUNCTION collab_git.claim_sync(),collab_git.begin_sync(uuid,uuid),collab_git.admit_sync_effect(uuid,uuid,text,jsonb),collab_git.gate_sync(uuid,uuid),collab_git.gate_sync_reconcile(uuid,uuid),collab_git.finish_sync(uuid,uuid,jsonb),collab_git.fail_sync(uuid,uuid,text) TO pi_collab_git;
