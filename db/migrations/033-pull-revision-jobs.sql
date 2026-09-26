-- Immutable PR code capture bound to an explicit successful observation.
CREATE TABLE collab_git.pull_revision_jobs (
 id uuid PRIMARY KEY, change_id uuid NOT NULL REFERENCES collab_git.pull_changes(id),
 organization_id uuid NOT NULL, project_id uuid NOT NULL, task_id uuid NOT NULL,
 actor_id text NOT NULL REFERENCES public."user"(id), organization_version bigint NOT NULL, project_version bigint NOT NULL,
 task_version integer NOT NULL, expected_version bigint NOT NULL, request_key uuid NOT NULL, request jsonb NOT NULL, admission jsonb NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','ready','failed','cancelled')),
 stop_requested boolean NOT NULL DEFAULT false, read_started_at timestamptz, claim_id uuid, backend_pid integer,
 manifest jsonb, manifest_text text, manifest_hash text, transport_evidence jsonb, failure text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 UNIQUE(change_id,actor_id,request_key),
 FOREIGN KEY(organization_id,project_id,task_id) REFERENCES collab.tasks(organization_id,project_id,id)
);
CREATE UNIQUE INDEX pull_revision_one_reader ON collab_git.pull_revision_jobs(change_id) WHERE status IN ('queued','running');

CREATE TABLE collab_git.pull_revision_actions (
 job_id uuid NOT NULL REFERENCES collab_git.pull_revision_jobs(id), actor_id text NOT NULL REFERENCES public."user"(id),
 request_key uuid NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(job_id,actor_id,request_key)
);

-- Current task authority and a current verified binding authorize NEW reads.
-- An original author leaving the project cannot destroy a team's PR history.
CREATE FUNCTION collab_git.pull_revision_source(change uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT collab_git.pull_observation_source(change)||jsonb_build_object('observationId',o.id,'observationHash',o.observation_hash,'snapshot',o.observation->'snapshot')
 FROM collab_git.pull_changes c JOIN collab_git.pull_observation_jobs o ON o.id=c.latest_observation_id
 WHERE c.id=change AND o.status='observed' AND collab_git.pull_observation_source(change) IS NOT NULL
$$;
CREATE FUNCTION collab_git.pull_revision_grant(job uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT COALESCE((SELECT NOT j.stop_requested AND t.version=j.task_version AND c.observation_version=j.expected_version
 AND collab_git.workspace_authority(j.task_id,j.actor_id,j.organization_version,j.project_version)
 AND j.admission=collab_git.pull_revision_source(j.change_id)
 FROM collab_git.pull_revision_jobs j JOIN collab.tasks t ON t.id=j.task_id JOIN collab_git.pull_changes c ON c.id=j.change_id WHERE j.id=job),false)
$$;
CREATE FUNCTION collab_git.pull_revision_result(job uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('jobId',id,'changeId',change_id,'actorId',actor_id,'actorName',(SELECT name FROM public."user" WHERE id=j.actor_id),
 'status',status,'stopRequested',stop_requested,'createdAt',created_at,'finishedAt',finished_at,'failure',failure,
 'observationId',admission->>'observationId','observationVersion',expected_version::text,
 'headSha',admission->'snapshot'->>'headSha','baseSha',admission->'snapshot'->>'baseSha',
 'manifestHash',manifest_hash,'diffHash',manifest->>'diffHash','mergeBase',manifest->>'mergeBase',
 'current',COALESCE(admission=collab_git.pull_revision_source(change_id),false))
 FROM collab_git.pull_revision_jobs j WHERE id=job
$$;
CREATE FUNCTION collab.pull_revision_context(change uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE d collab_git.pull_deliveries; c collab_git.pull_changes; t collab.tasks;
BEGIN
 SELECT * INTO c FROM collab_git.pull_changes WHERE id=change; SELECT * INTO d FROM collab_git.pull_deliveries WHERE id=change;
 IF c.id IS NULL OR collab.project_role(d.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 SELECT * INTO STRICT t FROM collab.tasks WHERE id=d.task_id;
 RETURN jsonb_build_object('taskVersion',t.version,'observationVersion',c.observation_version::text,
 'canRequest',collab_git.workspace_authority(t.id,collab.actor()) AND collab_git.pull_revision_source(change) IS NOT NULL,
 'canCancel',collab_git.workspace_authority(t.id,collab.actor()),
 'jobs',(SELECT COALESCE(jsonb_agg(collab_git.pull_revision_result(id) ORDER BY created_at DESC,id),'[]'::jsonb)
 FROM (SELECT id,created_at FROM collab_git.pull_revision_jobs WHERE change_id=change ORDER BY created_at DESC,id LIMIT 20) recent));
END $$;
CREATE FUNCTION collab.pull_revision_artifact(job uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j collab_git.pull_revision_jobs;
BEGIN
 SELECT * INTO j FROM collab_git.pull_revision_jobs WHERE id=job;
 IF j.id IS NULL OR collab.project_role(j.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 IF j.status<>'ready' THEN RAISE EXCEPTION 'pull_revision_unavailable' USING ERRCODE='P0001'; END IF;
 RETURN jsonb_build_object('record',collab_git.pull_revision_result(job),'manifestHash',j.manifest_hash);
END $$;
CREATE FUNCTION collab.request_pull_revision(change uuid, request_key uuid, payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE d collab_git.pull_deliveries; c collab_git.pull_changes; t collab.tasks; prior collab_git.pull_revision_jobs;
 fixed jsonb; job uuid:=gen_random_uuid(); ov bigint; pv bigint;
BEGIN
 SELECT * INTO c FROM collab_git.pull_changes WHERE id=change; SELECT * INTO d FROM collab_git.pull_deliveries WHERE id=change;
 IF c.id IS NULL OR collab.project_role(d.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(d.organization_id::text,811));
 PERFORM 1 FROM public."user" WHERE id=collab.actor() FOR SHARE;
 SELECT * INTO STRICT t FROM collab.tasks WHERE id=d.task_id FOR SHARE;
 SELECT * INTO STRICT c FROM collab_git.pull_changes WHERE id=change FOR UPDATE;
 IF NOT collab_git.workspace_authority(t.id,collab.actor()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF request_key IS NULL OR payload IS NULL OR jsonb_typeof(payload)<>'object' OR octet_length(payload::text)>4096
 OR (payload-ARRAY['expectedTaskVersion','expectedObservationVersion'])<>'{}'::jsonb
 OR jsonb_typeof(payload->'expectedTaskVersion') IS DISTINCT FROM 'number' OR COALESCE(payload->>'expectedTaskVersion','')!~'^[1-9][0-9]{0,9}$'
 OR jsonb_typeof(payload->'expectedObservationVersion') IS DISTINCT FROM 'string' OR COALESCE(payload->>'expectedObservationVersion','')!~'^(0|[1-9][0-9]{0,17})$'
 THEN RAISE EXCEPTION 'invalid_pull_revision' USING ERRCODE='P0001'; END IF;
 SELECT * INTO prior FROM collab_git.pull_revision_jobs WHERE change_id=change AND actor_id=collab.actor() AND pull_revision_jobs.request_key=request_pull_revision.request_key;
 IF FOUND THEN
  IF prior.request<>payload THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
  RETURN collab_git.pull_revision_result(prior.id)||jsonb_build_object('replayed',true);
 END IF;
 IF t.version::text<>payload->>'expectedTaskVersion' OR c.observation_version::text<>payload->>'expectedObservationVersion'
 THEN RAISE EXCEPTION 'stale_revision' USING ERRCODE='P0001'; END IF;
 IF EXISTS(SELECT 1 FROM collab_git.pull_revision_jobs WHERE change_id=change AND status IN ('queued','running'))
 THEN RAISE EXCEPTION 'pull_revision_busy' USING ERRCODE='P0001'; END IF;
 IF (SELECT count(*) FROM collab_git.pull_revision_jobs WHERE project_id=d.project_id AND status IN ('queued','running'))>=20
 THEN RAISE EXCEPTION 'pull_revision_limit' USING ERRCODE='P0001'; END IF;
 fixed:=collab_git.pull_revision_source(change);
 IF fixed IS NULL THEN RAISE EXCEPTION 'pull_revision_source_unavailable' USING ERRCODE='P0001'; END IF;
 SELECT authorization_version INTO ov FROM collab.memberships WHERE organization_id=d.organization_id AND user_id=collab.actor();
 SELECT authorization_version INTO pv FROM collab.project_memberships WHERE project_id=d.project_id AND user_id=collab.actor();
 INSERT INTO collab_git.pull_revision_jobs(id,change_id,organization_id,project_id,task_id,actor_id,organization_version,project_version,task_version,expected_version,request_key,request,admission)
 VALUES(job,change,d.organization_id,d.project_id,d.task_id,collab.actor(),ov,pv,t.version,c.observation_version,request_key,payload,fixed);
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail)
 VALUES(d.organization_id,d.project_id,collab.actor(),'pull_revision.requested',job::text,jsonb_build_object('changeId',change,'previousVersion',c.observation_version::text));
 RETURN collab_git.pull_revision_result(job)||jsonb_build_object('replayed',false);
END $$;
CREATE FUNCTION collab.cancel_pull_revision(job uuid, request_key uuid, reason text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j collab_git.pull_revision_jobs; prior collab_git.pull_revision_actions;
BEGIN
 SELECT * INTO j FROM collab_git.pull_revision_jobs WHERE id=job;
 IF j.id IS NULL OR collab.project_role(j.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(j.organization_id::text,811)); PERFORM 1 FROM public."user" WHERE id=collab.actor() FOR SHARE;
 PERFORM 1 FROM collab.tasks WHERE id=j.task_id FOR SHARE;
 IF NOT collab_git.workspace_authority(j.task_id,collab.actor()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF request_key IS NULL OR reason IS NULL OR length(btrim(reason)) NOT BETWEEN 10 AND 2000 THEN RAISE EXCEPTION 'invalid_pull_revision' USING ERRCODE='P0001'; END IF;
 SELECT * INTO prior FROM collab_git.pull_revision_actions WHERE job_id=job AND actor_id=collab.actor() AND pull_revision_actions.request_key=cancel_pull_revision.request_key;
 IF FOUND THEN
  IF prior.reason<>btrim(reason) THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
  RETURN collab_git.pull_revision_result(job)||jsonb_build_object('replayed',true);
 END IF;
 UPDATE collab_git.pull_revision_jobs SET stop_requested=true,updated_at=now() WHERE id=job AND status IN ('queued','running');
 INSERT INTO collab_git.pull_revision_actions VALUES(job,collab.actor(),request_key,btrim(reason),now());
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail)
 VALUES(j.organization_id,j.project_id,collab.actor(),'pull_revision.cancel_requested',job::text,jsonb_build_object('reason',btrim(reason)));
 RETURN collab_git.pull_revision_result(job)||jsonb_build_object('replayed',false);
END $$;
CREATE FUNCTION collab_git.claim_pull_revision() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j collab_git.pull_revision_jobs; nonce uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(95816433);
 FOR j IN SELECT * FROM collab_git.pull_revision_jobs WHERE status IN ('queued','running') ORDER BY updated_at,id LIMIT 100 LOOP
  IF NOT pg_try_advisory_lock(hashtextextended(j.id::text,95816434)) THEN CONTINUE; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(j.organization_id::text,811));
  SELECT * INTO STRICT j FROM collab_git.pull_revision_jobs WHERE id=j.id FOR UPDATE;
  IF j.status='running' THEN
   UPDATE collab_git.pull_revision_jobs SET status='failed',failure='pull_revision_reader_lost',updated_at=now(),finished_at=now() WHERE id=j.id;
   INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail)
   VALUES(j.organization_id,j.project_id,j.actor_id,'pull_revision.reader_lost',j.id::text,'{}');
   PERFORM pg_advisory_unlock(hashtextextended(j.id::text,95816434)); RETURN collab_git.pull_revision_result(j.id)||jsonb_build_object('recovered',true);
  END IF;
  IF j.status<>'queued' THEN PERFORM pg_advisory_unlock(hashtextextended(j.id::text,95816434)); CONTINUE; END IF;
  nonce:=gen_random_uuid(); UPDATE collab_git.pull_revision_jobs SET status='running',claim_id=nonce,backend_pid=pg_backend_pid(),updated_at=now() WHERE id=j.id;
  RETURN jsonb_build_object('jobId',j.id,'claimId',nonce,'admission',j.admission);
 END LOOP; RETURN NULL;
END $$;
CREATE FUNCTION collab_git.lock_pull_revision(job uuid, nonce uuid) RETURNS collab_git.pull_revision_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j collab_git.pull_revision_jobs;
BEGIN
 SELECT * INTO j FROM collab_git.pull_revision_jobs WHERE id=job;
 IF j.id IS NULL OR nonce IS NULL THEN RAISE EXCEPTION 'pull_revision_claim_lost' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(j.organization_id::text,811));
 SELECT * INTO STRICT j FROM collab_git.pull_revision_jobs WHERE id=job FOR UPDATE;
 IF j.status<>'running' OR j.claim_id IS DISTINCT FROM nonce OR j.backend_pid IS DISTINCT FROM pg_backend_pid()
 THEN RAISE EXCEPTION 'pull_revision_claim_lost' USING ERRCODE='P0001'; END IF;
 RETURN j;
END $$;
CREATE FUNCTION collab_git.lock_pull_revision_authority(job uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j collab_git.pull_revision_jobs;
BEGIN
 SELECT * INTO STRICT j FROM collab_git.pull_revision_jobs WHERE id=job;
 PERFORM 1 FROM public."user" WHERE id=j.actor_id FOR SHARE;
 PERFORM 1 FROM collab.tasks WHERE id=j.task_id FOR SHARE;
 PERFORM 1 FROM collab.github_bindings WHERE repository_id=(j.admission->>'repositoryId')::uuid FOR SHARE;
 PERFORM 1 FROM collab.github_installations WHERE id=(j.admission->>'connectionId')::uuid FOR SHARE;
 PERFORM 1 FROM collab_git.pull_changes WHERE id=j.change_id FOR UPDATE;
 IF collab_git.pull_revision_grant(job) IS DISTINCT FROM true THEN RAISE EXCEPTION 'pull_revision_authority_changed' USING ERRCODE='P0001'; END IF;
END $$;
CREATE FUNCTION collab_git.pull_revision_live(job uuid, nonce uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT COALESCE((SELECT status='running' AND read_started_at IS NOT NULL AND claim_id=nonce AND backend_pid=pg_backend_pid() AND collab_git.pull_revision_grant(id)
 FROM collab_git.pull_revision_jobs WHERE id=job),false)
$$;
CREATE FUNCTION collab_git.begin_pull_revision(job uuid, nonce uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j collab_git.pull_revision_jobs;
BEGIN
 j:=collab_git.lock_pull_revision(job,nonce); PERFORM collab_git.lock_pull_revision_authority(job);
 IF j.read_started_at IS NOT NULL THEN RAISE EXCEPTION 'invalid_pull_revision_evidence' USING ERRCODE='P0001'; END IF;
 UPDATE collab_git.pull_revision_jobs SET read_started_at=clock_timestamp(),updated_at=now() WHERE id=job;
 RETURN (SELECT jsonb_build_object('appId',c.app_id,'installationId',c.installation_id,'accountId',c.account_id,'sealed',s.sealed)
 FROM collab.github_installations c JOIN collab_git.credentials s ON s.connection_id=c.id WHERE c.id=(j.admission->>'connectionId')::uuid);
END $$;
CREATE FUNCTION collab_git.finish_pull_revision(job uuid, nonce uuid, manifest_text text, manifest_hash text, transport jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j collab_git.pull_revision_jobs; m jsonb; expected jsonb; c collab.github_installations; binding jsonb;
BEGIN
 j:=collab_git.lock_pull_revision(job,nonce); PERFORM collab_git.lock_pull_revision_authority(job);
 SELECT * INTO STRICT c FROM collab.github_installations WHERE id=(j.admission->>'connectionId')::uuid;
 binding:=j.admission->'binding';
 IF j.read_started_at IS NULL OR manifest_text IS NULL OR octet_length(manifest_text)>8388608
 OR manifest_hash IS NULL OR manifest_hash!~'^[a-f0-9]{64}$'
 OR encode(sha256(convert_to(manifest_text,'UTF8')),'hex')<>manifest_hash
 THEN RAISE EXCEPTION 'invalid_pull_revision_evidence' USING ERRCODE='P0001'; END IF;
 m:=manifest_text::jsonb;
 expected:=jsonb_build_object('version',1,'revisionId',job,'changeId',j.change_id,'repositoryId',j.admission->'repositoryId',
 'githubRepositoryId',binding->'githubRepositoryId','pullId',j.admission->'identity'->'id','pullNumber',j.admission->'identity'->'number',
 'observationId',j.admission->'observationId','observationHash',j.admission->'observationHash',
 'headSha',j.admission->'snapshot'->'headSha','baseSha',j.admission->'snapshot'->'baseSha',
 'headRef',j.admission->'snapshot'->'headRef','baseRef',j.admission->'snapshot'->'baseRef');
 IF jsonb_typeof(m) IS DISTINCT FROM 'object' OR m->'version' IS DISTINCT FROM '1'::jsonb OR m->>'policy' IS DISTINCT FROM 'pull-code-v1'
 OR m->'input' IS DISTINCT FROM expected OR m->>'comparison' IS DISTINCT FROM 'merge-base-to-head'
 OR jsonb_typeof(m->'files') IS DISTINCT FROM 'array' OR jsonb_array_length(m->'files')>10000
 OR COALESCE(m->>'diffHash','')!~'^[a-f0-9]{64}$' OR COALESCE(m->>'mergeBase','')!~'^[a-f0-9]{40}$'
 OR transport->'tokenRevoked' IS DISTINCT FROM 'true'::jsonb OR transport->>'repositoryId' IS DISTINCT FROM binding->>'githubRepositoryId'
 OR transport->>'nodeId' IS DISTINCT FROM binding->>'nodeId' OR transport->>'ownerId' IS DISTINCT FROM binding->>'ownerId'
 OR transport->>'ownerLogin' IS DISTINCT FROM binding->>'ownerLogin' OR transport->>'name' IS DISTINCT FROM binding->>'name'
 OR transport->'private' IS DISTINCT FROM binding->'private' OR transport->>'visibility' IS DISTINCT FROM binding->>'visibility'
 OR transport->'installation'->>'appId' IS DISTINCT FROM c.app_id OR transport->'installation'->>'installationId' IS DISTINCT FROM c.installation_id
 OR transport->'installation'->>'accountId' IS DISTINCT FROM c.account_id
 OR transport->'capabilities' IS DISTINCT FROM '{"metadataRead":true,"contentsRead":true,"push":false,"pullRequest":false,"protectedMerge":false}'::jsonb
 OR COALESCE(transport->>'verifiedAt','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$'
 THEN RAISE EXCEPTION 'invalid_pull_revision_evidence' USING ERRCODE='P0001'; END IF;
 IF (transport->>'verifiedAt')::timestamptz NOT BETWEEN j.read_started_at-interval '5 seconds' AND clock_timestamp()+interval '5 seconds'
 THEN RAISE EXCEPTION 'invalid_pull_revision_evidence' USING ERRCODE='P0001'; END IF;
 UPDATE collab_git.pull_revision_jobs SET status='ready',manifest=m,manifest_text=finish_pull_revision.manifest_text,
 manifest_hash=finish_pull_revision.manifest_hash,transport_evidence=transport,updated_at=now(),finished_at=now() WHERE id=job;
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail)
 VALUES(j.organization_id,j.project_id,j.actor_id,'pull_revision.ready',job::text,jsonb_build_object('changeId',j.change_id,'manifestHash',manifest_hash));
 RETURN collab_git.pull_revision_result(job);
END $$;
CREATE FUNCTION collab_git.fail_pull_revision(job uuid, nonce uuid, failure_code text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j collab_git.pull_revision_jobs;
BEGIN
 j:=collab_git.lock_pull_revision(job,nonce);
 IF failure_code IS NULL OR failure_code!~'^[a-z_]{1,120}$' THEN RAISE EXCEPTION 'invalid_pull_revision_evidence' USING ERRCODE='P0001'; END IF;
 UPDATE collab_git.pull_revision_jobs SET status=CASE WHEN stop_requested THEN 'cancelled' ELSE 'failed' END,failure=failure_code,updated_at=now(),finished_at=now() WHERE id=job;
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail)
 VALUES(j.organization_id,j.project_id,j.actor_id,'pull_revision.failed',job::text,jsonb_build_object('failure',failure_code));
 RETURN collab_git.pull_revision_result(job);
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA collab_git FROM PUBLIC;
REVOKE ALL ON FUNCTION collab.pull_revision_artifact(uuid),collab.pull_revision_context(uuid),collab.request_pull_revision(uuid,uuid,jsonb),collab.cancel_pull_revision(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.pull_revision_artifact(uuid),collab.pull_revision_context(uuid),collab.request_pull_revision(uuid,uuid,jsonb),collab.cancel_pull_revision(uuid,uuid,text) TO pi_collab_app;
GRANT EXECUTE ON FUNCTION collab_git.claim_pull_revision(),collab_git.begin_pull_revision(uuid,uuid),collab_git.pull_revision_live(uuid,uuid),
 collab_git.finish_pull_revision(uuid,uuid,text,text,jsonb),collab_git.fail_pull_revision(uuid,uuid,text) TO pi_collab_git;
