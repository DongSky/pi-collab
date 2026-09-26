-- Read-only PR proposals. No creation capability or head reservation is granted.
CREATE TABLE collab_git.pull_proposals (
 id uuid PRIMARY KEY, delivery_id uuid NOT NULL REFERENCES collab_git.push_deliveries(id),
 organization_id uuid NOT NULL, project_id uuid NOT NULL, task_id uuid NOT NULL,
 actor_id text NOT NULL REFERENCES public."user"(id), organization_version bigint NOT NULL, project_version bigint NOT NULL,
 task_version integer NOT NULL, request_key uuid NOT NULL, request jsonb NOT NULL, admission jsonb NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','ready','existing','failed','cancelled')),
 stop_requested boolean NOT NULL DEFAULT false, read_started boolean NOT NULL DEFAULT false, claim_id uuid, backend_pid integer,
 observation jsonb, observation_text text, observation_hash text, attempt jsonb, request_text text, failure text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 UNIQUE(delivery_id,actor_id,request_key),
 FOREIGN KEY(organization_id,project_id,task_id) REFERENCES collab.tasks(organization_id,project_id,id)
);
CREATE UNIQUE INDEX task_pull_proposal_one_reader ON collab_git.pull_proposals(delivery_id) WHERE status IN ('queued','running');
CREATE TABLE collab_git.pull_proposal_actions (
 proposal_id uuid NOT NULL REFERENCES collab_git.pull_proposals(id), actor_id text NOT NULL REFERENCES public."user"(id),
 request_key uuid NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(proposal_id,actor_id,request_key)
);

-- Historical, positively acknowledged code is independent of later workspace
-- edits and of the now-spent push authorization. Current proposal authority is
-- checked separately. A changed installation/binding requires fresh evidence.
CREATE FUNCTION collab_git.task_pull_source(delivery uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('deliveryId',d.id,'repositoryId',p.repository_id,'taskId',p.task_id,'workspaceId',p.workspace_id,
 'headSha',p.admission->>'head','manifestHash',p.manifest_hash,'binding',p.admission->'binding',
 'connectionId',p.connection_id,'organizationId',p.organization_id)
 FROM collab_git.push_deliveries d JOIN collab_git.push_previews p ON p.id=d.preview_id
 JOIN collab.github_bindings b ON b.repository_id=p.repository_id
 JOIN collab.github_installations c ON c.id=p.connection_id
 WHERE d.id=delivery AND d.status='acknowledged' AND d.result->'outcome'->>'status'='acknowledged'
 AND b.connection_id=p.connection_id AND b.version=p.binding_version AND b.installation_version=p.installation_version
 AND c.enabled AND c.version=p.installation_version AND collab_git.task_push_binding(p.repository_id)=p.admission->'binding'
$$;
CREATE FUNCTION collab_git.pull_proposal_grant(proposal uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT COALESCE((SELECT NOT p.stop_requested AND t.version=p.task_version
 AND collab_git.workspace_authority(p.task_id,p.actor_id,p.organization_version,p.project_version)
 AND p.admission=collab_git.task_pull_source(p.delivery_id)
 FROM collab_git.pull_proposals p JOIN collab.tasks t ON t.id=p.task_id WHERE p.id=proposal),false)
$$;
CREATE FUNCTION collab_git.pull_proposal_result(proposal uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('jobId',id,'deliveryId',delivery_id,'actorId',actor_id,'actorName',(SELECT name FROM public."user" WHERE id=p.actor_id),'status',status,'stopRequested',stop_requested,
 'createdAt',created_at,'finishedAt',finished_at,'failure',failure,'title',request->>'title','body',request->>'body',
 'source',admission-ARRAY['connectionId','organizationId'],'taskVersion',task_version,
 'observation',observation,'observationText',observation_text,'observationHash',observation_hash,'attempt',attempt,'requestText',request_text,
 'valid',status='ready' AND collab_git.pull_proposal_grant(id))
 FROM collab_git.pull_proposals p WHERE id=proposal
$$;
CREATE FUNCTION collab.task_pull_proposal_context(delivery uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE d collab_git.push_deliveries; t collab.tasks;
BEGIN
 SELECT * INTO d FROM collab_git.push_deliveries WHERE id=delivery;
 IF d.id IS NULL OR collab.project_role(d.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 SELECT * INTO STRICT t FROM collab.tasks WHERE id=d.task_id;
 RETURN jsonb_build_object('taskVersion',t.version,'canRequest',collab_git.workspace_authority(t.id,collab.actor()) AND collab_git.task_pull_source(delivery) IS NOT NULL,
 'canCancel',collab_git.workspace_authority(t.id,collab.actor()),'proposals',
 (SELECT COALESCE(jsonb_agg(collab_git.pull_proposal_result(id) ORDER BY created_at DESC,id),'[]'::jsonb)
 FROM (SELECT id,created_at FROM collab_git.pull_proposals WHERE delivery_id=delivery ORDER BY created_at DESC,id LIMIT 20) jobs));
END $$;
CREATE FUNCTION collab.request_task_pull_proposal(delivery uuid, request_key uuid, payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE d collab_git.push_deliveries; t collab.tasks; prior collab_git.pull_proposals; fixed jsonb; proposal uuid:=gen_random_uuid(); ov bigint; pv bigint;
BEGIN
 SELECT * INTO d FROM collab_git.push_deliveries WHERE id=delivery;
 IF d.id IS NULL OR collab.project_role(d.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(d.organization_id::text,811));
 PERFORM 1 FROM public."user" WHERE id=collab.actor() FOR SHARE;
 SELECT * INTO STRICT t FROM collab.tasks WHERE id=d.task_id FOR SHARE;
 IF NOT collab_git.workspace_authority(t.id,collab.actor()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF request_key IS NULL OR payload IS NULL OR jsonb_typeof(payload)<>'object' OR octet_length(payload::text)>200000
 OR (payload-ARRAY['title','body','expectedTaskVersion'])<>'{}'::jsonb
 OR jsonb_typeof(payload->'title') IS DISTINCT FROM 'string' OR length(payload->>'title') NOT BETWEEN 1 AND 256
 OR payload->>'title'<>btrim(payload->>'title') OR payload->>'title' ~ '[[:cntrl:]]'
 OR jsonb_typeof(payload->'body') IS DISTINCT FROM 'string' OR length(payload->>'body') NOT BETWEEN 1 AND 48000 OR octet_length(payload->>'body')>59000
 OR jsonb_typeof(payload->'expectedTaskVersion') IS DISTINCT FROM 'number' OR COALESCE(payload->>'expectedTaskVersion','')!~'^[1-9][0-9]{0,8}$'
 THEN RAISE EXCEPTION 'invalid_task_pull_proposal' USING ERRCODE='P0001'; END IF;
 SELECT * INTO prior FROM collab_git.pull_proposals WHERE delivery_id=delivery AND actor_id=collab.actor() AND pull_proposals.request_key=request_task_pull_proposal.request_key;
 IF FOUND THEN
  IF prior.request<>payload THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
  RETURN collab_git.pull_proposal_result(prior.id)||jsonb_build_object('replayed',true);
 END IF;
 IF t.version::text<>payload->>'expectedTaskVersion' THEN RAISE EXCEPTION 'stale_revision' USING ERRCODE='P0001'; END IF;
 fixed:=collab_git.task_pull_source(delivery);
 IF fixed IS NULL THEN RAISE EXCEPTION 'task_pull_source_unavailable' USING ERRCODE='P0001'; END IF;
 IF EXISTS(SELECT 1 FROM collab_git.pull_proposals WHERE delivery_id=delivery AND status IN ('queued','running')) THEN RAISE EXCEPTION 'task_pull_proposal_busy' USING ERRCODE='P0001'; END IF;
 IF (SELECT count(*) FROM collab_git.pull_proposals WHERE project_id=d.project_id AND status IN ('queued','running'))>=20 THEN RAISE EXCEPTION 'task_pull_proposal_limit' USING ERRCODE='P0001'; END IF;
 SELECT authorization_version INTO ov FROM collab.memberships WHERE organization_id=d.organization_id AND user_id=collab.actor();
 SELECT authorization_version INTO pv FROM collab.project_memberships WHERE project_id=d.project_id AND user_id=collab.actor();
 INSERT INTO collab_git.pull_proposals(id,delivery_id,organization_id,project_id,task_id,actor_id,organization_version,project_version,task_version,request_key,request,admission)
 VALUES(proposal,delivery,d.organization_id,d.project_id,d.task_id,collab.actor(),ov,pv,t.version,request_key,payload,fixed);
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail)
 VALUES(d.organization_id,d.project_id,collab.actor(),'task_pull.proposal_requested',proposal::text,jsonb_build_object('deliveryId',delivery,'headSha',fixed->>'headSha'));
 RETURN collab_git.pull_proposal_result(proposal)||jsonb_build_object('replayed',false);
END $$;
CREATE FUNCTION collab.cancel_task_pull_proposal(proposal uuid, request_key uuid, reason text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab_git.pull_proposals; prior collab_git.pull_proposal_actions;
BEGIN
 SELECT * INTO p FROM collab_git.pull_proposals WHERE id=proposal;
 IF p.id IS NULL OR collab.project_role(p.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p.organization_id::text,811)); PERFORM 1 FROM public."user" WHERE id=collab.actor() FOR SHARE;
 PERFORM 1 FROM collab.tasks WHERE id=p.task_id FOR SHARE;
 IF NOT collab_git.workspace_authority(p.task_id,collab.actor()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF request_key IS NULL OR reason IS NULL OR length(btrim(reason)) NOT BETWEEN 10 AND 2000 THEN RAISE EXCEPTION 'invalid_task_pull_proposal' USING ERRCODE='P0001'; END IF;
 SELECT * INTO prior FROM collab_git.pull_proposal_actions WHERE proposal_id=proposal AND actor_id=collab.actor() AND pull_proposal_actions.request_key=cancel_task_pull_proposal.request_key;
 IF FOUND THEN
  IF prior.reason<>btrim(reason) THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
  RETURN collab_git.pull_proposal_result(proposal)||jsonb_build_object('replayed',true);
 END IF;
 UPDATE collab_git.pull_proposals SET stop_requested=true,updated_at=now() WHERE id=proposal AND status IN ('queued','running');
 INSERT INTO collab_git.pull_proposal_actions VALUES(proposal,collab.actor(),request_key,btrim(reason),now());
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail)
 VALUES(p.organization_id,p.project_id,collab.actor(),'task_pull.proposal_cancel_requested',proposal::text,jsonb_build_object('reason',btrim(reason)));
 RETURN collab_git.pull_proposal_result(proposal)||jsonb_build_object('replayed',false);
END $$;

CREATE FUNCTION collab_git.claim_pull_proposal() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab_git.pull_proposals; nonce uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(93816423);
 FOR p IN SELECT * FROM collab_git.pull_proposals WHERE status IN ('queued','running') ORDER BY updated_at,id LIMIT 100 LOOP
  IF NOT pg_try_advisory_lock(hashtextextended(p.id::text,93816424)) THEN CONTINUE; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p.organization_id::text,811));
  SELECT * INTO STRICT p FROM collab_git.pull_proposals WHERE id=p.id FOR UPDATE;
  IF p.status='running' THEN
   UPDATE collab_git.pull_proposals SET status='failed',failure='task_pull_proposal_reader_lost',updated_at=now(),finished_at=now() WHERE id=p.id;
   INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(p.organization_id,p.project_id,p.actor_id,'task_pull.proposal_reader_lost',p.id::text,'{}');
   PERFORM pg_advisory_unlock(hashtextextended(p.id::text,93816424)); RETURN collab_git.pull_proposal_result(p.id)||jsonb_build_object('recovered',true);
  END IF;
  IF p.status<>'queued' THEN PERFORM pg_advisory_unlock(hashtextextended(p.id::text,93816424)); CONTINUE; END IF;
  nonce:=gen_random_uuid(); UPDATE collab_git.pull_proposals SET status='running',claim_id=nonce,backend_pid=pg_backend_pid(),updated_at=now() WHERE id=p.id;
  RETURN jsonb_build_object('jobId',p.id,'claimId',nonce,'admission',p.admission,'title',p.request->>'title','body',p.request->>'body');
 END LOOP; RETURN NULL;
END $$;
CREATE FUNCTION collab_git.lock_pull_proposal(proposal uuid, nonce uuid) RETURNS collab_git.pull_proposals LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab_git.pull_proposals;
BEGIN
 SELECT * INTO p FROM collab_git.pull_proposals WHERE id=proposal;
 IF p.id IS NULL OR nonce IS NULL THEN RAISE EXCEPTION 'task_pull_proposal_claim_lost' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p.organization_id::text,811));
 SELECT * INTO STRICT p FROM collab_git.pull_proposals WHERE id=proposal FOR UPDATE;
 IF p.status<>'running' OR p.claim_id IS DISTINCT FROM nonce OR p.backend_pid IS DISTINCT FROM pg_backend_pid() THEN RAISE EXCEPTION 'task_pull_proposal_claim_lost' USING ERRCODE='P0001'; END IF;
 RETURN p;
END $$;
CREATE FUNCTION collab_git.pull_proposal_live(proposal uuid, nonce uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT COALESCE((SELECT status='running' AND read_started AND claim_id=nonce AND backend_pid=pg_backend_pid() AND collab_git.pull_proposal_grant(id)
 FROM collab_git.pull_proposals WHERE id=proposal),false)
$$;
CREATE FUNCTION collab_git.begin_pull_proposal(proposal uuid, nonce uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab_git.pull_proposals;
BEGIN
 p:=collab_git.lock_pull_proposal(proposal,nonce); PERFORM 1 FROM public."user" WHERE id=p.actor_id FOR SHARE;
 IF p.read_started OR collab_git.pull_proposal_grant(proposal) IS DISTINCT FROM true THEN RAISE EXCEPTION 'task_pull_proposal_authority_changed' USING ERRCODE='P0001'; END IF;
 UPDATE collab_git.pull_proposals SET read_started=true,updated_at=now() WHERE id=proposal;
 RETURN (SELECT jsonb_build_object('appId',c.app_id,'installationId',c.installation_id,'accountId',c.account_id,'sealed',s.sealed)
 FROM collab.github_installations c JOIN collab_git.credentials s ON s.connection_id=c.id WHERE c.id=(p.admission->>'connectionId')::uuid);
END $$;
CREATE FUNCTION collab_git.finish_pull_proposal(proposal uuid, nonce uuid, observation_text text, attempt jsonb, request_text text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab_git.pull_proposals; o jsonb; target jsonb; c collab.github_installations; intent jsonb; expected_request jsonb; ref text; body text; item jsonb;
BEGIN
 p:=collab_git.lock_pull_proposal(proposal,nonce); PERFORM 1 FROM public."user" WHERE id=p.actor_id FOR SHARE;
 PERFORM 1 FROM collab.tasks WHERE id=p.task_id FOR SHARE;
 PERFORM 1 FROM collab.github_bindings WHERE repository_id=(p.admission->>'repositoryId')::uuid FOR SHARE;
 SELECT * INTO STRICT c FROM collab.github_installations WHERE id=(p.admission->>'connectionId')::uuid FOR SHARE;
 IF NOT p.read_started OR collab_git.pull_proposal_grant(proposal) IS DISTINCT FROM true THEN RAISE EXCEPTION 'task_pull_proposal_authority_changed' USING ERRCODE='P0001'; END IF;
 IF observation_text IS NULL OR octet_length(observation_text)>65536 OR request_text IS NULL OR octet_length(request_text)>200000
 OR attempt IS NULL OR octet_length(attempt::text)>400000 THEN RAISE EXCEPTION 'invalid_task_pull_evidence' USING ERRCODE='P0001'; END IF;
 o:=observation_text::jsonb; target:=o->'target';
 ref:='pi-collab/tasks/'||p.task_id::text||'/workspaces/'||(p.admission->>'workspaceId');
 IF jsonb_typeof(o) IS DISTINCT FROM 'object' OR (o-ARRAY['target','existing','tokenExpiresAt','tokenRevoked'])<>'{}'::jsonb
 OR o->'tokenRevoked' IS DISTINCT FROM 'true'::jsonb OR jsonb_typeof(o->'tokenExpiresAt') IS DISTINCT FROM 'string'
 OR target-ARRAY['installation','baseSha','baseProtected','verifiedAt'] IS DISTINCT FROM jsonb_build_object('version',1,'repository',p.admission->'binding',
 'headRef',ref,'headSha',p.admission->>'headSha','baseRef',p.admission->'binding'->>'defaultBranch')
 OR jsonb_typeof(target->'baseSha') IS DISTINCT FROM 'string' OR COALESCE(target->>'baseSha','')!~'^[a-f0-9]{40}$' OR target->>'baseSha'=repeat('0',40)
 OR target->>'baseSha'=p.admission->>'headSha' OR jsonb_typeof(target->'baseProtected') IS DISTINCT FROM 'boolean'
 OR jsonb_typeof(target->'verifiedAt') IS DISTINCT FROM 'string' OR jsonb_typeof(o->'existing') IS DISTINCT FROM 'array'
 OR target->'installation'->>'appId' IS DISTINCT FROM c.app_id OR target->'installation'->>'installationId' IS DISTINCT FROM c.installation_id
 OR target->'installation'->>'accountId' IS DISTINCT FROM c.account_id OR target->'installation'->'version' IS DISTINCT FROM '1'::jsonb
 OR target->'installation'->'permissions'->>'pull_requests' IS DISTINCT FROM 'write'
 OR COALESCE(target->'installation'->'permissions'->>'contents','') NOT IN ('read','write')
 THEN RAISE EXCEPTION 'invalid_task_pull_evidence' USING ERRCODE='P0001'; END IF;
 IF (target->>'verifiedAt')::timestamptz NOT BETWEEN clock_timestamp()-interval '30 seconds' AND clock_timestamp()+interval '5 seconds'
 OR (o->>'tokenExpiresAt')::timestamptz NOT BETWEEN clock_timestamp() AND clock_timestamp()+interval '62 minutes'
 OR jsonb_array_length(o->'existing')>2 THEN RAISE EXCEPTION 'invalid_task_pull_evidence' USING ERRCODE='P0001'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(o->'existing') LOOP
  IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR item-ARRAY['id','nodeId','number','url']<>'{}'::jsonb
  OR jsonb_typeof(item->'id') IS DISTINCT FROM 'string' OR COALESCE(item->>'id','')!~'^[1-9][0-9]{0,15}$'
  OR jsonb_typeof(item->'nodeId') IS DISTINCT FROM 'string' OR length(item->>'nodeId') NOT BETWEEN 1 AND 200
  OR jsonb_typeof(item->'number') IS DISTINCT FROM 'number' OR COALESCE(item->>'number','')!~'^[1-9][0-9]{0,15}$'
  OR item->>'url' IS DISTINCT FROM 'https://github.com/'||(p.admission->'binding'->>'ownerLogin')||'/'||(p.admission->'binding'->>'name')||'/pull/'||(item->>'number')
  THEN RAISE EXCEPTION 'invalid_task_pull_evidence' USING ERRCODE='P0001'; END IF;
 END LOOP;
 intent:=jsonb_build_object('operationId',p.id,'deliveryId',p.delivery_id,'repositoryId',p.admission->>'repositoryId','taskId',p.task_id,
 'workspaceId',p.admission->>'workspaceId','headSha',p.admission->>'headSha','baseSha',target->>'baseSha',
 'manifestHash',p.admission->>'manifestHash','title',p.request->>'title','body',p.request->>'body');
 body:=(p.request->>'body')||E'\n\n---\npi-collab draft · operation '||p.id::text||E'\nDelivery: '||p.delivery_id::text||E'\nHead: '||(p.admission->>'headSha')
 ||E'\nBase observed: '||(target->>'baseSha')||E'\nExport SHA-256: '||(p.admission->>'manifestHash')
 ||E'\n\nThis reference records the requested versions; it does not attest CI, review, or merge eligibility.';
 expected_request:=jsonb_build_object('title',p.request->>'title','head',ref,'base',p.admission->'binding'->>'defaultBranch','body',body,'draft',true,'maintainer_can_modify',false);
 IF octet_length(body)>60000 OR request_text::jsonb IS DISTINCT FROM expected_request
 OR attempt IS DISTINCT FROM jsonb_build_object('intent',intent,'binding',p.admission->'binding','ref','refs/heads/'||ref,'request',expected_request,
 'requestHash',encode(sha256(convert_to(request_text,'UTF8')),'hex'),'requestBytes',octet_length(request_text))
 THEN RAISE EXCEPTION 'invalid_task_pull_evidence' USING ERRCODE='P0001'; END IF;
 UPDATE collab_git.pull_proposals SET status=CASE WHEN jsonb_array_length(o->'existing')>0 THEN 'existing' ELSE 'ready' END,
 observation=o,observation_text=finish_pull_proposal.observation_text,observation_hash=encode(sha256(convert_to(finish_pull_proposal.observation_text,'UTF8')),'hex'),attempt=finish_pull_proposal.attempt,
 request_text=finish_pull_proposal.request_text,finished_at=now(),updated_at=now() WHERE id=proposal;
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail)
 VALUES(p.organization_id,p.project_id,p.actor_id,'task_pull.proposal_observed',proposal::text,jsonb_build_object('requestHash',attempt->>'requestHash','existingCount',jsonb_array_length(o->'existing')));
 RETURN collab_git.pull_proposal_result(proposal);
END $$;
CREATE FUNCTION collab_git.fail_pull_proposal(proposal uuid, nonce uuid, failure_code text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab_git.pull_proposals;
BEGIN
 p:=collab_git.lock_pull_proposal(proposal,nonce);
 IF failure_code IS NULL OR failure_code!~'^[a-z_]{1,120}$' THEN RAISE EXCEPTION 'invalid_task_pull_evidence' USING ERRCODE='P0001'; END IF;
 UPDATE collab_git.pull_proposals SET status=CASE WHEN stop_requested THEN 'cancelled' ELSE 'failed' END,
 failure=CASE WHEN stop_requested THEN 'task_pull_proposal_cancelled' ELSE failure_code END,updated_at=now(),finished_at=now() WHERE id=proposal;
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(p.organization_id,p.project_id,p.actor_id,'task_pull.proposal_failed',proposal::text,jsonb_build_object('failure',failure_code));
 RETURN collab_git.pull_proposal_result(proposal);
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA collab_git FROM PUBLIC;
REVOKE ALL ON FUNCTION collab.task_pull_proposal_context(uuid),collab.request_task_pull_proposal(uuid,uuid,jsonb),collab.cancel_task_pull_proposal(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.task_pull_proposal_context(uuid),collab.request_task_pull_proposal(uuid,uuid,jsonb),collab.cancel_task_pull_proposal(uuid,uuid,text) TO pi_collab_app;
GRANT EXECUTE ON FUNCTION collab_git.claim_pull_proposal(),collab_git.begin_pull_proposal(uuid,uuid),collab_git.pull_proposal_live(uuid,uuid),collab_git.finish_pull_proposal(uuid,uuid,text,jsonb,text),collab_git.fail_pull_proposal(uuid,uuid,text) TO pi_collab_git;
