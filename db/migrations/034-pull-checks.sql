-- Immutable required CI producer rules and explicit fixed-revision check reads.
CREATE TABLE collab_git.pull_check_policies (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, project_id uuid NOT NULL, repository_id uuid NOT NULL REFERENCES collab.repositories(id),
 base_ref text NOT NULL, version integer NOT NULL CHECK(version>0), actor_id text NOT NULL REFERENCES public."user"(id),
 request_key uuid NOT NULL, request jsonb NOT NULL, config jsonb NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(repository_id,base_ref,version), UNIQUE(repository_id,base_ref,actor_id,request_key)
);
CREATE TABLE collab_git.pull_checks_jobs (
 id uuid PRIMARY KEY, sequence bigserial UNIQUE, revision_id uuid NOT NULL REFERENCES collab_git.pull_revision_jobs(id),
 organization_id uuid NOT NULL, project_id uuid NOT NULL, task_id uuid NOT NULL,
 actor_id text NOT NULL REFERENCES public."user"(id), organization_version bigint NOT NULL, project_version bigint NOT NULL,
 task_version integer NOT NULL, request_key uuid NOT NULL, request jsonb NOT NULL, admission jsonb NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','observed','failed','cancelled')),
 stop_requested boolean NOT NULL DEFAULT false, read_started_at timestamptz, claim_id uuid, backend_pid integer,
 evidence jsonb, evidence_text text, evidence_hash text, satisfied boolean, failure text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 UNIQUE(revision_id,actor_id,request_key), FOREIGN KEY(organization_id,project_id,task_id) REFERENCES collab.tasks(organization_id,project_id,id)
);
CREATE UNIQUE INDEX pull_checks_one_reader ON collab_git.pull_checks_jobs(revision_id) WHERE status IN ('queued','running');
CREATE TABLE collab_git.pull_checks_actions (
 job_id uuid NOT NULL REFERENCES collab_git.pull_checks_jobs(id), actor_id text NOT NULL REFERENCES public."user"(id),
 request_key uuid NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(job_id,actor_id,request_key)
);
CREATE FUNCTION collab_git.checks_policy(repo uuid, branch text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',p.id,'version',p.version,'config',p.config,'reason',p.reason,'actorName',u.name)
 FROM collab_git.pull_check_policies p JOIN public."user" u ON u.id=p.actor_id WHERE repository_id=repo AND base_ref=branch ORDER BY version DESC LIMIT 1
$$;
CREATE FUNCTION collab.publish_pull_check_policy(revision uuid, key uuid, payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab_git.pull_revision_jobs; repo uuid; branch text; prior collab_git.pull_check_policies; current_version integer; rule jsonb; result uuid:=gen_random_uuid(); config jsonb;
BEGIN
 SELECT * INTO r FROM collab_git.pull_revision_jobs WHERE id=revision;
 IF r.id IS NULL OR collab.project_role(r.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(r.organization_id::text,811)); PERFORM 1 FROM public."user" WHERE id=collab.actor() FOR SHARE;
 IF collab.project_role(r.project_id)<>'maintainer' OR NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF r.status<>'ready' THEN RAISE EXCEPTION 'pull_checks_source_unavailable' USING ERRCODE='P0001'; END IF;
 repo:=(r.admission->>'repositoryId')::uuid; branch:=r.manifest->'input'->>'baseRef'; config:=payload->'config';
 IF key IS NULL OR payload IS NULL OR jsonb_typeof(payload) IS DISTINCT FROM 'object'
 OR (payload-ARRAY['config','reason','expectedVersion'])<>'{}'::jsonb OR octet_length(payload::text)>16384
 OR jsonb_typeof(payload->'expectedVersion') IS DISTINCT FROM 'number' OR COALESCE(payload->>'expectedVersion','')!~'^(0|[1-9][0-9]{0,8})$'
 OR jsonb_typeof(payload->'reason') IS DISTINCT FROM 'string' OR length(btrim(payload->>'reason')) NOT BETWEEN 10 AND 2000
 OR jsonb_typeof(config) IS DISTINCT FROM 'object' OR (config-ARRAY['version','required','maxAgeSeconds'])<>'{}'::jsonb
 OR config->'version' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(config->'required') IS DISTINCT FROM 'array'
 OR jsonb_array_length(config->'required') NOT BETWEEN 1 AND 16 OR jsonb_typeof(config->'maxAgeSeconds') IS DISTINCT FROM 'number'
 OR COALESCE(config->>'maxAgeSeconds','')!~'^[1-9][0-9]{1,3}$'
 THEN RAISE EXCEPTION 'invalid_pull_checks_policy' USING ERRCODE='P0001'; END IF;
 IF (config->>'maxAgeSeconds')::integer NOT BETWEEN 30 AND 3600 THEN RAISE EXCEPTION 'invalid_pull_checks_policy' USING ERRCODE='P0001'; END IF;
 FOR rule IN SELECT value FROM jsonb_array_elements(config->'required') LOOP
  IF jsonb_typeof(rule) IS DISTINCT FROM 'object' OR (rule-ARRAY['name','appId'])<>'{}'::jsonb
  OR jsonb_typeof(rule->'name') IS DISTINCT FROM 'string' OR length(btrim(rule->>'name')) NOT BETWEEN 1 AND 200
  OR rule->>'name'<>btrim(rule->>'name') OR jsonb_typeof(rule->'appId') IS DISTINCT FROM 'string'
  OR COALESCE(rule->>'appId','')!~'^[1-9][0-9]{0,15}$'
  THEN RAISE EXCEPTION 'invalid_pull_checks_policy' USING ERRCODE='P0001'; END IF;
  IF (rule->>'appId')::bigint>9007199254740991 THEN RAISE EXCEPTION 'invalid_pull_checks_policy' USING ERRCODE='P0001'; END IF;
 END LOOP;
 IF (SELECT count(DISTINCT value) FROM jsonb_array_elements(config->'required'))<>jsonb_array_length(config->'required') THEN RAISE EXCEPTION 'invalid_pull_checks_policy' USING ERRCODE='P0001'; END IF;
 SELECT * INTO prior FROM collab_git.pull_check_policies WHERE repository_id=repo AND base_ref=branch AND actor_id=collab.actor() AND request_key=key;
 IF FOUND THEN
  IF prior.request<>payload THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
  RETURN jsonb_build_object('policyId',prior.id,'replayed',true);
 END IF;
 SELECT COALESCE(max(version),0) INTO current_version FROM collab_git.pull_check_policies WHERE repository_id=repo AND base_ref=branch;
 IF current_version::text<>payload->>'expectedVersion' THEN RAISE EXCEPTION 'stale_revision' USING ERRCODE='P0001'; END IF;
 INSERT INTO collab_git.pull_check_policies VALUES(result,r.organization_id,r.project_id,repo,branch,current_version+1,collab.actor(),key,payload,config,btrim(payload->>'reason'),now());
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(r.organization_id,r.project_id,collab.actor(),'pull_checks.policy_published',result::text,jsonb_build_object('version',current_version+1,'repositoryId',repo,'baseRef',branch));
 RETURN jsonb_build_object('policyId',result,'replayed',false);
END $$;
CREATE FUNCTION collab_git.pull_checks_source(revision uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT r.admission||jsonb_build_object('revisionId',r.id,'manifestHash',r.manifest_hash,'diffHash',r.manifest->>'diffHash','input',r.manifest->'input',
 'policy',(collab_git.checks_policy((r.admission->>'repositoryId')::uuid,r.manifest->'input'->>'baseRef')-ARRAY['reason','actorName']))
 FROM collab_git.pull_revision_jobs r WHERE id=revision AND status='ready' AND r.admission=collab_git.pull_revision_source(r.change_id)
 AND collab_git.checks_policy((r.admission->>'repositoryId')::uuid,r.manifest->'input'->>'baseRef') IS NOT NULL
$$;
CREATE FUNCTION collab_git.pull_checks_grant(job uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT COALESCE((SELECT NOT j.stop_requested AND t.version=j.task_version
 AND collab_git.workspace_authority(j.task_id,j.actor_id,j.organization_version,j.project_version)
 AND j.admission=collab_git.pull_checks_source(j.revision_id)
 FROM collab_git.pull_checks_jobs j JOIN collab.tasks t ON t.id=j.task_id WHERE j.id=job),false)
$$;
CREATE FUNCTION collab_git.checks_verdict(config jsonb, checks jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_agg(rule||jsonb_build_object('checkId',CASE WHEN n=1 THEN hit->>'id' ELSE NULL END,
 'state',CASE WHEN n=0 THEN 'missing' WHEN n>1 THEN 'ambiguous' WHEN hit->>'status'<>'completed' THEN 'pending'
 WHEN hit->>'conclusion'='success' THEN 'passed' ELSE 'failed' END) ORDER BY ord)
 FROM jsonb_array_elements(config->'required') WITH ORDINALITY r(rule,ord)
 CROSS JOIN LATERAL (SELECT count(*) AS n,(jsonb_agg(c))->0 AS hit FROM jsonb_array_elements(checks) c WHERE c->>'name'=rule->>'name' AND c->>'appId'=rule->>'appId') matched
$$;
CREATE FUNCTION collab_git.pull_checks_result(job uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('jobId',j.id,'revisionId',revision_id,'status',status,'actorName',(SELECT name FROM public."user" WHERE id=j.actor_id),
 'stopRequested',stop_requested,'failure',failure,'evidenceHash',evidence_hash,'completedAt',finished_at,'satisfied',satisfied,
 'policyId',admission->'policy'->>'id','rules',CASE WHEN evidence IS NULL THEN NULL ELSE collab_git.checks_verdict(admission->'policy'->'config',evidence->'checks') END,
 'eligible',COALESCE(status='observed' AND satisfied AND admission=collab_git.pull_checks_source(revision_id)
 AND finished_at+make_interval(secs=>(admission->'policy'->'config'->>'maxAgeSeconds')::integer)>statement_timestamp()
 AND NOT EXISTS(SELECT 1 FROM collab_git.pull_checks_jobs newer WHERE newer.revision_id=j.revision_id AND newer.sequence>j.sequence),false))
 FROM collab_git.pull_checks_jobs j WHERE id=job
$$;
CREATE FUNCTION collab.pull_checks_context(revision uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab_git.pull_revision_jobs; t collab.tasks;
BEGIN
 SELECT * INTO r FROM collab_git.pull_revision_jobs WHERE id=revision;
 IF r.id IS NULL OR collab.project_role(r.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 SELECT * INTO STRICT t FROM collab.tasks WHERE id=r.task_id;
 RETURN jsonb_build_object('taskVersion',t.version,'canConfigure',collab.project_role(r.project_id)='maintainer' AND collab.actor_has_mfa(),
 'canRequest',collab_git.workspace_authority(t.id,collab.actor()) AND collab_git.pull_checks_source(revision) IS NOT NULL,
 'canCancel',collab_git.workspace_authority(t.id,collab.actor()),
 'policy',collab_git.checks_policy((r.admission->>'repositoryId')::uuid,r.manifest->'input'->>'baseRef'),
 'jobs',(SELECT COALESCE(jsonb_agg(collab_git.pull_checks_result(id) ORDER BY sequence DESC),'[]'::jsonb)
 FROM (SELECT id,sequence FROM collab_git.pull_checks_jobs WHERE revision_id=revision ORDER BY sequence DESC LIMIT 20) recent));
END $$;
CREATE FUNCTION collab.request_pull_checks(revision uuid, request_key uuid, payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab_git.pull_revision_jobs; t collab.tasks; prior collab_git.pull_checks_jobs; fixed jsonb; job uuid:=gen_random_uuid(); ov bigint; pv bigint;
BEGIN
 SELECT * INTO r FROM collab_git.pull_revision_jobs WHERE id=revision;
 IF r.id IS NULL OR collab.project_role(r.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(r.organization_id::text,811)); PERFORM 1 FROM public."user" WHERE id=collab.actor() FOR SHARE;
 SELECT * INTO STRICT t FROM collab.tasks WHERE id=r.task_id FOR SHARE;
 IF NOT collab_git.workspace_authority(t.id,collab.actor()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF request_key IS NULL OR payload IS NULL OR jsonb_typeof(payload) IS DISTINCT FROM 'object' OR octet_length(payload::text)>4096
 OR (payload-ARRAY['expectedTaskVersion','expectedPolicyId'])<>'{}'::jsonb
 OR jsonb_typeof(payload->'expectedTaskVersion') IS DISTINCT FROM 'number' OR COALESCE(payload->>'expectedTaskVersion','')!~'^[1-9][0-9]{0,9}$'
 OR jsonb_typeof(payload->'expectedPolicyId') IS DISTINCT FROM 'string' OR COALESCE(payload->>'expectedPolicyId','')!~'^[a-f0-9-]{36}$'
 THEN RAISE EXCEPTION 'invalid_pull_checks' USING ERRCODE='P0001'; END IF;
 SELECT * INTO prior FROM collab_git.pull_checks_jobs WHERE revision_id=revision AND actor_id=collab.actor() AND pull_checks_jobs.request_key=request_pull_checks.request_key;
 IF FOUND THEN
  IF prior.request<>payload THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
  RETURN collab_git.pull_checks_result(prior.id)||jsonb_build_object('replayed',true);
 END IF;
 fixed:=collab_git.pull_checks_source(revision);
 IF fixed IS NULL THEN RAISE EXCEPTION 'pull_checks_source_unavailable' USING ERRCODE='P0001'; END IF;
 IF t.version::text<>payload->>'expectedTaskVersion' OR fixed->'policy'->>'id'<>payload->>'expectedPolicyId' THEN RAISE EXCEPTION 'stale_revision' USING ERRCODE='P0001'; END IF;
 IF EXISTS(SELECT 1 FROM collab_git.pull_checks_jobs WHERE revision_id=revision AND status IN ('queued','running')) THEN RAISE EXCEPTION 'pull_checks_busy' USING ERRCODE='P0001'; END IF;
 IF (SELECT count(*) FROM collab_git.pull_checks_jobs WHERE project_id=r.project_id AND status IN ('queued','running'))>=20 THEN RAISE EXCEPTION 'pull_checks_limit' USING ERRCODE='P0001'; END IF;
 SELECT authorization_version INTO ov FROM collab.memberships WHERE organization_id=r.organization_id AND user_id=collab.actor();
 SELECT authorization_version INTO pv FROM collab.project_memberships WHERE project_id=r.project_id AND user_id=collab.actor();
 INSERT INTO collab_git.pull_checks_jobs(id,revision_id,organization_id,project_id,task_id,actor_id,organization_version,project_version,task_version,request_key,request,admission)
 VALUES(job,revision,r.organization_id,r.project_id,r.task_id,collab.actor(),ov,pv,t.version,request_key,payload,fixed);
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(r.organization_id,r.project_id,collab.actor(),'pull_checks.requested',job::text,jsonb_build_object('revisionId',revision));
 RETURN collab_git.pull_checks_result(job)||jsonb_build_object('replayed',false);
END $$;
CREATE FUNCTION collab.cancel_pull_checks(job uuid, request_key uuid, reason text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j collab_git.pull_checks_jobs; prior collab_git.pull_checks_actions;
BEGIN
 SELECT * INTO j FROM collab_git.pull_checks_jobs WHERE id=job;
 IF j.id IS NULL OR collab.project_role(j.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(j.organization_id::text,811)); PERFORM 1 FROM public."user" WHERE id=collab.actor() FOR SHARE;
 PERFORM 1 FROM collab.tasks WHERE id=j.task_id FOR SHARE;
 IF NOT collab_git.workspace_authority(j.task_id,collab.actor()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF request_key IS NULL OR reason IS NULL OR length(btrim(reason)) NOT BETWEEN 10 AND 2000 THEN RAISE EXCEPTION 'invalid_pull_checks' USING ERRCODE='P0001'; END IF;
 SELECT * INTO prior FROM collab_git.pull_checks_actions WHERE job_id=job AND actor_id=collab.actor() AND pull_checks_actions.request_key=cancel_pull_checks.request_key;
 IF FOUND THEN
  IF prior.reason<>btrim(reason) THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
  RETURN collab_git.pull_checks_result(job)||jsonb_build_object('replayed',true);
 END IF;
 UPDATE collab_git.pull_checks_jobs SET stop_requested=true,updated_at=now() WHERE id=job AND status IN ('queued','running');
 INSERT INTO collab_git.pull_checks_actions VALUES(job,collab.actor(),request_key,btrim(reason),now());
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail)
 VALUES(j.organization_id,j.project_id,collab.actor(),'pull_checks.cancel_requested',job::text,jsonb_build_object('reason',btrim(reason)));
 RETURN collab_git.pull_checks_result(job)||jsonb_build_object('replayed',false);
END $$;
CREATE FUNCTION collab_git.claim_pull_checks() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j collab_git.pull_checks_jobs; nonce uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(95816443);
 FOR j IN SELECT * FROM collab_git.pull_checks_jobs WHERE status IN ('queued','running') ORDER BY updated_at,id LIMIT 100 LOOP
  IF NOT pg_try_advisory_lock(hashtextextended(j.id::text,95816444)) THEN CONTINUE; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(j.organization_id::text,811));
  SELECT * INTO STRICT j FROM collab_git.pull_checks_jobs WHERE id=j.id FOR UPDATE;
  IF j.status='running' THEN
   UPDATE collab_git.pull_checks_jobs SET status='failed',failure='pull_checks_reader_lost',updated_at=now(),finished_at=now() WHERE id=j.id;
   INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail)
   VALUES(j.organization_id,j.project_id,j.actor_id,'pull_checks.reader_lost',j.id::text,'{}');
   PERFORM pg_advisory_unlock(hashtextextended(j.id::text,95816444)); RETURN collab_git.pull_checks_result(j.id)||jsonb_build_object('recovered',true);
  END IF;
  IF j.status<>'queued' THEN PERFORM pg_advisory_unlock(hashtextextended(j.id::text,95816444)); CONTINUE; END IF;
  nonce:=gen_random_uuid(); UPDATE collab_git.pull_checks_jobs SET status='running',claim_id=nonce,backend_pid=pg_backend_pid(),updated_at=now() WHERE id=j.id;
  RETURN jsonb_build_object('jobId',j.id,'claimId',nonce,'admission',j.admission);
 END LOOP; RETURN NULL;
END $$;
CREATE FUNCTION collab_git.lock_pull_checks(job uuid, nonce uuid) RETURNS collab_git.pull_checks_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j collab_git.pull_checks_jobs;
BEGIN
 SELECT * INTO j FROM collab_git.pull_checks_jobs WHERE id=job;
 IF j.id IS NULL OR nonce IS NULL THEN RAISE EXCEPTION 'pull_checks_claim_lost' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(j.organization_id::text,811));
 SELECT * INTO STRICT j FROM collab_git.pull_checks_jobs WHERE id=job FOR UPDATE;
 IF j.status<>'running' OR j.claim_id IS DISTINCT FROM nonce OR j.backend_pid IS DISTINCT FROM pg_backend_pid()
 THEN RAISE EXCEPTION 'pull_checks_claim_lost' USING ERRCODE='P0001'; END IF;
 RETURN j;
END $$;
CREATE FUNCTION collab_git.lock_pull_checks_authority(job uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j collab_git.pull_checks_jobs;
BEGIN
 SELECT * INTO STRICT j FROM collab_git.pull_checks_jobs WHERE id=job;
 PERFORM 1 FROM public."user" WHERE id=j.actor_id FOR SHARE;
 PERFORM 1 FROM collab.tasks WHERE id=j.task_id FOR SHARE;
 PERFORM 1 FROM collab.github_bindings WHERE repository_id=(j.admission->>'repositoryId')::uuid FOR SHARE;
 PERFORM 1 FROM collab.github_installations WHERE id=(j.admission->>'connectionId')::uuid FOR SHARE;
 PERFORM 1 FROM collab_git.pull_changes WHERE id=(j.admission->>'changeId')::uuid FOR UPDATE;
 IF collab_git.pull_checks_grant(job) IS DISTINCT FROM true THEN RAISE EXCEPTION 'pull_checks_authority_changed' USING ERRCODE='P0001'; END IF;
END $$;
CREATE FUNCTION collab_git.pull_checks_live(job uuid, nonce uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT COALESCE((SELECT status='running' AND read_started_at IS NOT NULL AND claim_id=nonce AND backend_pid=pg_backend_pid() AND collab_git.pull_checks_grant(id)
 FROM collab_git.pull_checks_jobs WHERE id=job),false)
$$;
CREATE FUNCTION collab_git.begin_pull_checks(job uuid, nonce uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j collab_git.pull_checks_jobs;
BEGIN
 j:=collab_git.lock_pull_checks(job,nonce); PERFORM collab_git.lock_pull_checks_authority(job);
 IF j.read_started_at IS NOT NULL THEN RAISE EXCEPTION 'invalid_pull_checks_evidence' USING ERRCODE='P0001'; END IF;
 UPDATE collab_git.pull_checks_jobs SET read_started_at=clock_timestamp(),updated_at=now() WHERE id=job;
 RETURN (SELECT jsonb_build_object('appId',c.app_id,'installationId',c.installation_id,'accountId',c.account_id,'sealed',s.sealed)
 FROM collab.github_installations c JOIN collab_git.credentials s ON s.connection_id=c.id WHERE c.id=(j.admission->>'connectionId')::uuid);
END $$;
CREATE FUNCTION collab_git.finish_pull_checks(job uuid, nonce uuid, evidence_text text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j collab_git.pull_checks_jobs; e jsonb; run jsonb; rules jsonb; c collab.github_installations;
BEGIN
 j:=collab_git.lock_pull_checks(job,nonce); PERFORM collab_git.lock_pull_checks_authority(job);
 SELECT * INTO STRICT c FROM collab.github_installations WHERE id=(j.admission->>'connectionId')::uuid;
 IF j.read_started_at IS NULL OR evidence_text IS NULL OR octet_length(evidence_text)>2097152 THEN RAISE EXCEPTION 'invalid_pull_checks_evidence' USING ERRCODE='P0001'; END IF;
 e:=evidence_text::jsonb;
 IF jsonb_typeof(e) IS DISTINCT FROM 'object' OR e->'version' IS DISTINCT FROM '1'::jsonb
 OR (e-ARRAY['version','installation','binding','identity','input','snapshot','checks','tokenExpiresAt','tokenRevoked','completedAt'])<>'{}'::jsonb
 OR e->'input' IS DISTINCT FROM j.admission->'input' OR e->'identity' IS DISTINCT FROM j.admission->'identity' OR e->'binding' IS DISTINCT FROM j.admission->'binding'
 OR NOT collab_git.valid_pull_snapshot(e->'snapshot',j.admission->'identity',j.read_started_at)
 OR e->'installation'->'version' IS DISTINCT FROM '1'::jsonb
 OR e->'snapshot'->>'headSha' IS DISTINCT FROM j.admission->'input'->>'headSha' OR e->'snapshot'->>'baseSha' IS DISTINCT FROM j.admission->'input'->>'baseSha'
 OR e->'snapshot'->>'headRef' IS DISTINCT FROM j.admission->'input'->>'headRef' OR e->'snapshot'->>'baseRef' IS DISTINCT FROM j.admission->'input'->>'baseRef'
 OR e->'snapshot'->>'state' IS DISTINCT FROM 'open' OR e->'snapshot'->'merged' IS DISTINCT FROM 'false'::jsonb
 OR e->'installation'->>'appId' IS DISTINCT FROM c.app_id OR e->'installation'->>'installationId' IS DISTINCT FROM c.installation_id
 OR e->'installation'->>'accountId' IS DISTINCT FROM c.account_id OR COALESCE(e->'installation'->'permissions'->>'checks','') NOT IN ('read','write')
 OR COALESCE(e->'installation'->'permissions'->>'contents','') NOT IN ('read','write')
 OR COALESCE(e->'installation'->'permissions'->>'pull_requests','') NOT IN ('read','write')
 OR jsonb_typeof(e->'tokenExpiresAt') IS DISTINCT FROM 'string' OR COALESCE(e->>'tokenExpiresAt','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$'
 OR jsonb_typeof(e->'completedAt') IS DISTINCT FROM 'string'
 OR e->'tokenRevoked' IS DISTINCT FROM 'true'::jsonb OR jsonb_typeof(e->'checks') IS DISTINCT FROM 'array' OR jsonb_array_length(e->'checks')>1000
 OR COALESCE(e->>'completedAt','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$'
 THEN RAISE EXCEPTION 'invalid_pull_checks_evidence' USING ERRCODE='P0001'; END IF;
 FOR run IN SELECT value FROM jsonb_array_elements(e->'checks') LOOP
  IF jsonb_typeof(run) IS DISTINCT FROM 'object'
  OR (run-ARRAY['id','name','appId','suiteId','headSha','status','conclusion','startedAt','completedAt'])<>'{}'::jsonb
  OR jsonb_typeof(run->'id') IS DISTINCT FROM 'string' OR jsonb_typeof(run->'appId') IS DISTINCT FROM 'string' OR jsonb_typeof(run->'suiteId') IS DISTINCT FROM 'string'
  OR (run->'startedAt' IS DISTINCT FROM 'null'::jsonb AND (jsonb_typeof(run->'startedAt') IS DISTINCT FROM 'string' OR COALESCE(run->>'startedAt','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$'))
  OR run->>'headSha' IS DISTINCT FROM j.admission->'input'->>'headSha' OR jsonb_typeof(run->'name') IS DISTINCT FROM 'string' OR length(run->>'name') NOT BETWEEN 1 AND 200
  OR COALESCE(run->>'id','')!~'^[1-9][0-9]{0,15}$' OR COALESCE(run->>'appId','')!~'^[1-9][0-9]{0,15}$' OR COALESCE(run->>'suiteId','')!~'^[1-9][0-9]{0,15}$'
  OR COALESCE(run->>'status','') NOT IN ('queued','in_progress','completed','waiting','requested','pending')
  OR (run->>'status'='completed' AND (COALESCE(run->>'conclusion','') NOT IN ('success','failure','neutral','cancelled','skipped','timed_out','action_required','stale','startup_failure') OR COALESCE(run->>'completedAt','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$'))
  OR (run->>'status'<>'completed' AND (run->'conclusion' IS DISTINCT FROM 'null'::jsonb OR run->'completedAt' IS DISTINCT FROM 'null'::jsonb))
  THEN RAISE EXCEPTION 'invalid_pull_checks_evidence' USING ERRCODE='P0001'; END IF;
  IF (run->>'id')::bigint>9007199254740991 OR (run->>'appId')::bigint>9007199254740991 OR (run->>'suiteId')::bigint>9007199254740991
  OR (run->>'completedAt')::timestamptz>clock_timestamp()+interval '5 seconds'
  OR (run->>'startedAt')::timestamptz>COALESCE((run->>'completedAt')::timestamptz,clock_timestamp()+interval '5 seconds')
  THEN RAISE EXCEPTION 'invalid_pull_checks_evidence' USING ERRCODE='P0001'; END IF;
 END LOOP;
 IF (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(e->'checks'))<>jsonb_array_length(e->'checks')
 OR (e->>'tokenExpiresAt')::timestamptz NOT BETWEEN clock_timestamp() AND j.read_started_at+interval '62 minutes'
 OR (e->'snapshot'->>'observedAt')::timestamptz NOT BETWEEN clock_timestamp()-interval '30 seconds' AND (e->>'completedAt')::timestamptz+interval '5 seconds'
 OR (e->>'completedAt')::timestamptz<j.read_started_at-interval '5 seconds'
 OR (e->>'completedAt')::timestamptz NOT BETWEEN clock_timestamp()-interval '30 seconds' AND clock_timestamp()+interval '5 seconds'
 THEN RAISE EXCEPTION 'invalid_pull_checks_evidence' USING ERRCODE='P0001'; END IF;
 rules:=collab_git.checks_verdict(j.admission->'policy'->'config',e->'checks');
 UPDATE collab_git.pull_checks_jobs SET status='observed',evidence=e,evidence_text=finish_pull_checks.evidence_text,evidence_hash=encode(sha256(convert_to(finish_pull_checks.evidence_text,'UTF8')),'hex'),
 satisfied=NOT EXISTS(SELECT 1 FROM jsonb_array_elements(rules) r WHERE r->>'state'<>'passed'),updated_at=now(),finished_at=now() WHERE id=job;
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(j.organization_id,j.project_id,j.actor_id,'pull_checks.observed',job::text,jsonb_build_object('revisionId',j.revision_id));
 RETURN collab_git.pull_checks_result(job);
END $$;
CREATE FUNCTION collab_git.fail_pull_checks(job uuid, nonce uuid, failure_code text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j collab_git.pull_checks_jobs;
BEGIN
 j:=collab_git.lock_pull_checks(job,nonce);
 IF failure_code IS NULL OR failure_code!~'^[a-z_]{1,120}$' THEN RAISE EXCEPTION 'invalid_pull_checks_evidence' USING ERRCODE='P0001'; END IF;
 UPDATE collab_git.pull_checks_jobs SET status=CASE WHEN stop_requested THEN 'cancelled' ELSE 'failed' END,failure=failure_code,updated_at=now(),finished_at=now() WHERE id=job;
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail)
 VALUES(j.organization_id,j.project_id,j.actor_id,'pull_checks.failed',job::text,jsonb_build_object('failure',failure_code));
 RETURN collab_git.pull_checks_result(job);
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA collab_git FROM PUBLIC;
REVOKE ALL ON FUNCTION collab.publish_pull_check_policy(uuid,uuid,jsonb),collab.pull_checks_context(uuid),collab.request_pull_checks(uuid,uuid,jsonb),collab.cancel_pull_checks(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.publish_pull_check_policy(uuid,uuid,jsonb),collab.pull_checks_context(uuid),collab.request_pull_checks(uuid,uuid,jsonb),collab.cancel_pull_checks(uuid,uuid,text) TO pi_collab_app;
GRANT EXECUTE ON FUNCTION collab_git.claim_pull_checks(),collab_git.begin_pull_checks(uuid,uuid),collab_git.pull_checks_live(uuid,uuid),collab_git.finish_pull_checks(uuid,uuid,text),collab_git.fail_pull_checks(uuid,uuid,text) TO pi_collab_git;
