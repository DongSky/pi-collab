-- Read-only remote preparation. A ready preview is never a push authorization.
ALTER TABLE collab.github_bindings ADD COLUMN version bigint NOT NULL DEFAULT 1 CHECK(version>0);
CREATE FUNCTION collab_git.version_binding() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN NEW.version:=OLD.version+1; RETURN NEW; END $$;
CREATE TRIGGER github_binding_version BEFORE UPDATE ON collab.github_bindings FOR EACH ROW EXECUTE FUNCTION collab_git.version_binding();

CREATE TABLE collab_git.push_previews (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, project_id uuid NOT NULL, task_id uuid NOT NULL, run_id uuid NOT NULL, workspace_id uuid NOT NULL,
 repository_id uuid NOT NULL, connection_id uuid NOT NULL, installation_version bigint NOT NULL, binding_version bigint NOT NULL,
 actor_id text NOT NULL REFERENCES public."user"(id), organization_version bigint NOT NULL, project_version bigint NOT NULL,
 task_version integer NOT NULL, run_revision bigint NOT NULL, request_key uuid NOT NULL, request jsonb NOT NULL, admission jsonb NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','ready','failed','cancelled')),
 stop_requested boolean NOT NULL DEFAULT false, read_started boolean NOT NULL DEFAULT false, claim_id uuid, backend_pid integer,
 observation jsonb, observation_hash text, manifest jsonb, manifest_hash text, failure text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 UNIQUE(run_id,actor_id,request_key),
 FOREIGN KEY(organization_id,project_id,run_id) REFERENCES collab.runs(organization_id,project_id,id),
 FOREIGN KEY(organization_id,project_id,task_id,workspace_id) REFERENCES collab.workspaces(organization_id,project_id,task_id,id),
 FOREIGN KEY(organization_id,project_id,repository_id) REFERENCES collab.repositories(organization_id,project_id,id),
 FOREIGN KEY(organization_id,connection_id) REFERENCES collab.github_installations(organization_id,id)
);
CREATE UNIQUE INDEX task_push_preview_one_reader ON collab_git.push_previews(workspace_id) WHERE status IN ('queued','running');
CREATE TABLE collab_git.push_preview_actions (
 preview_id uuid NOT NULL REFERENCES collab_git.push_previews(id), actor_id text NOT NULL REFERENCES public."user"(id),
 request_key uuid NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(preview_id,actor_id,request_key)
);

CREATE FUNCTION collab_git.task_push_binding(repository uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('repositoryId',r.id,'githubRepositoryId',b.github_repository_id,'nodeId',b.evidence->>'nodeId',
 'ownerId',b.evidence->>'ownerId','ownerLogin',b.evidence->>'ownerLogin','name',b.evidence->>'name',
 'defaultBranch',b.evidence->>'defaultBranch','private',b.evidence->'private','visibility',b.evidence->>'visibility',
 'integrationBranches',(SELECT jsonb_agg(branch ORDER BY branch) FROM
 (SELECT r.default_branch AS branch UNION SELECT target_branch FROM collab.integration_policies WHERE repository_id=r.id) branches))
 FROM collab.repositories r JOIN collab.github_bindings b ON b.repository_id=r.id JOIN collab.github_installations c ON c.id=b.connection_id
 WHERE r.id=repository AND r.provider='github' AND c.enabled AND c.version=b.installation_version
 AND b.evidence->>'visibility' IN ('public','private','internal') AND b.evidence->>'defaultBranch'=r.default_branch
$$;
CREATE FUNCTION collab_git.push_preview_result(preview uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('jobId',id,'runId',run_id,'status',status,'stopRequested',stop_requested,'actorId',actor_id,
 'createdAt',created_at,'finishedAt',finished_at,'failure',failure,
 'head',admission->>'head','manifestHash',manifest_hash,'commitCount',jsonb_array_length(manifest->'commits'))
 FROM collab_git.push_previews WHERE id=preview
$$;
CREATE FUNCTION collab.task_push_previews(run uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM collab.runs WHERE id=run AND collab.project_role(project_id) IS NOT NULL) THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 RETURN (SELECT COALESCE(jsonb_agg(collab_git.push_preview_result(id) ORDER BY created_at DESC,id),'[]'::jsonb)
 FROM (SELECT id,created_at FROM collab_git.push_previews WHERE run_id=run ORDER BY created_at DESC,id LIMIT 50) jobs);
END $$;
CREATE FUNCTION collab.task_push_preview_detail(preview uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab_git.push_previews;
BEGIN
 SELECT * INTO p FROM collab_git.push_previews WHERE id=preview;
 IF p.id IS NULL OR collab.project_role(p.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 RETURN collab_git.push_preview_result(preview)||jsonb_build_object('binding',p.admission->'binding','observation',p.observation,
 'observationHash',p.observation_hash,'commits',p.manifest->'commits','policy',p.manifest->>'policy');
END $$;
CREATE FUNCTION collab.request_task_push_preview(run uuid, request_key uuid, payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab.runs; w collab.workspaces; t collab.tasks; b collab.github_bindings; prior collab_git.push_previews;
 preview uuid:=gen_random_uuid(); fixed jsonb; binding jsonb; ov bigint; pv bigint;
BEGIN
 SELECT * INTO r FROM collab.runs WHERE id=run;
 IF r.id IS NULL OR collab.project_role(r.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(r.organization_id::text,811));
 PERFORM 1 FROM public."user" WHERE id=collab.actor() FOR SHARE;
 SELECT * INTO STRICT r FROM collab.runs WHERE id=run FOR SHARE;
 SELECT * INTO STRICT t FROM collab.tasks WHERE id=r.task_id FOR SHARE;
 SELECT * INTO STRICT w FROM collab.workspaces WHERE id=r.workspace_id FOR SHARE;
 IF NOT collab_git.workspace_authority(t.id,collab.actor()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF request_key IS NULL OR payload IS NULL OR jsonb_typeof(payload)<>'object' OR pg_column_size(payload)>4096
 OR (payload-ARRAY['revision','head','expectedRunRevision'])<>'{}'::jsonb
 OR jsonb_typeof(payload->'revision') IS DISTINCT FROM 'string' OR COALESCE(payload->>'revision','')!~'^[a-f0-9]{64}$'
 OR jsonb_typeof(payload->'head') IS DISTINCT FROM 'string' OR COALESCE(payload->>'head','')!~'^[a-f0-9]{40}$' OR payload->>'head'=repeat('0',40)
 OR jsonb_typeof(payload->'expectedRunRevision') IS DISTINCT FROM 'string' OR COALESCE(payload->>'expectedRunRevision','')!~'^[1-9][0-9]{0,17}$'
 THEN RAISE EXCEPTION 'invalid_task_push_preview' USING ERRCODE='P0001'; END IF;
 SELECT * INTO prior FROM collab_git.push_previews WHERE run_id=run AND actor_id=collab.actor() AND push_previews.request_key=request_task_push_preview.request_key;
 IF FOUND THEN
  IF prior.request<>payload THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
  RETURN collab_git.push_preview_result(prior.id)||jsonb_build_object('replayed',true);
 END IF;
 IF r.revision::text<>payload->>'expectedRunRevision' THEN RAISE EXCEPTION 'stale_revision' USING ERRCODE='P0001'; END IF;
 IF r.status NOT IN ('completed','failed','cancelled') OR w.status<>'stopped' OR w.runtime<>'native' OR r.executor_id IS NULL OR r.epoch<1 THEN RAISE EXCEPTION 'workspace_not_stopped' USING ERRCODE='P0001'; END IF;
 IF EXISTS(SELECT 1 FROM collab_git.push_previews WHERE workspace_id=w.id AND status IN ('queued','running'))
 OR EXISTS(SELECT 1 FROM collab_git.workspace_operations WHERE workspace_id=w.id AND status NOT IN ('applied','aborted'))
 OR EXISTS(SELECT 1 FROM collab.snapshots WHERE workspace_id=w.id AND status='pending') THEN RAISE EXCEPTION 'workspace_git_busy' USING ERRCODE='P0001'; END IF;
 IF (SELECT count(*) FROM collab_git.push_previews WHERE project_id=r.project_id AND status IN ('queued','running'))>=20 THEN RAISE EXCEPTION 'task_push_preview_limit' USING ERRCODE='P0001'; END IF;
 SELECT * INTO b FROM collab.github_bindings WHERE repository_id=w.repository_id FOR SHARE;
 binding:=collab_git.task_push_binding(w.repository_id);
 IF b.repository_id IS NULL OR binding IS NULL THEN RAISE EXCEPTION 'github_connection_unavailable' USING ERRCODE='P0001'; END IF;
 IF jsonb_array_length(binding->'integrationBranches')>20 THEN RAISE EXCEPTION 'task_push_preview_limit' USING ERRCODE='P0001'; END IF;
 SELECT authorization_version INTO ov FROM collab.memberships WHERE organization_id=r.organization_id AND user_id=collab.actor();
 SELECT authorization_version INTO pv FROM collab.project_memberships WHERE project_id=r.project_id AND user_id=collab.actor();
 fixed:=jsonb_build_object('version',1,'exportId',preview,'operationId',gen_random_uuid(),'taskId',t.id,
 'source',jsonb_build_object('workspaceId',w.id,'identity',jsonb_build_object('runId',r.id,'executorId',r.executor_id,'epoch',r.epoch::text)),
 'revision',payload->>'revision','head',payload->>'head','binding',binding);
 INSERT INTO collab_git.push_previews(id,organization_id,project_id,task_id,run_id,workspace_id,repository_id,connection_id,installation_version,binding_version,
 actor_id,organization_version,project_version,task_version,run_revision,request_key,request,admission)
 VALUES(preview,r.organization_id,r.project_id,t.id,r.id,w.id,w.repository_id,b.connection_id,b.installation_version,b.version,
 collab.actor(),ov,pv,t.version,r.revision,request_key,payload,fixed);
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail)
 VALUES(r.organization_id,r.project_id,collab.actor(),'task_push_preview.requested',preview::text,jsonb_build_object('runId',r.id,'head',payload->>'head','bindingVersion',b.version::text));
 RETURN collab_git.push_preview_result(preview)||jsonb_build_object('replayed',false);
END $$;

-- All platform writers/snapshots share the organization serialization lock.
CREATE FUNCTION collab_git.guard_push_preview_source() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text,811));
 IF EXISTS(SELECT 1 FROM collab_git.push_previews WHERE workspace_id=NEW.workspace_id AND status IN ('queued','running')) THEN RAISE EXCEPTION 'workspace_git_busy' USING ERRCODE='P0001'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER workspace_git_push_preview BEFORE INSERT ON collab_git.workspace_operations FOR EACH ROW EXECUTE FUNCTION collab_git.guard_push_preview_source();
CREATE TRIGGER snapshot_push_preview BEFORE INSERT ON collab.snapshots FOR EACH ROW EXECUTE FUNCTION collab_git.guard_push_preview_source();

CREATE FUNCTION collab.cancel_task_push_preview(preview uuid, reason text, request_key uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab_git.push_previews; prior collab_git.push_preview_actions;
BEGIN
 SELECT * INTO p FROM collab_git.push_previews WHERE id=preview;
 IF p.id IS NULL OR collab.project_role(p.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p.organization_id::text,811)); PERFORM 1 FROM public."user" WHERE id=collab.actor() FOR SHARE;
 IF NOT collab_git.workspace_authority(p.task_id,collab.actor()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF request_key IS NULL OR reason IS NULL OR length(btrim(reason)) NOT BETWEEN 10 AND 2000 THEN RAISE EXCEPTION 'invalid_task_push_preview' USING ERRCODE='P0001'; END IF;
 SELECT * INTO prior FROM collab_git.push_preview_actions WHERE preview_id=preview AND actor_id=collab.actor() AND push_preview_actions.request_key=cancel_task_push_preview.request_key;
 IF FOUND THEN
  IF prior.reason<>btrim(reason) THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
  RETURN collab_git.push_preview_result(preview)||jsonb_build_object('replayed',true);
 END IF;
 UPDATE collab_git.push_previews SET stop_requested=true,updated_at=now() WHERE id=preview AND status IN ('queued','running');
 INSERT INTO collab_git.push_preview_actions VALUES(preview,collab.actor(),request_key,btrim(reason),now());
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(p.organization_id,p.project_id,collab.actor(),'task_push_preview.cancel_requested',preview::text,jsonb_build_object('reason',btrim(reason)));
 RETURN collab_git.push_preview_result(preview)||jsonb_build_object('replayed',false);
END $$;

CREATE FUNCTION collab_git.push_preview_grant(preview uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT COALESCE(NOT p.stop_requested AND collab_git.workspace_authority(p.task_id,p.actor_id,p.organization_version,p.project_version)
 AND t.version=p.task_version AND r.revision=p.run_revision AND r.status IN ('completed','failed','cancelled') AND w.status='stopped' AND w.runtime='native'
 AND b.version=p.binding_version AND b.connection_id=p.connection_id AND b.installation_version=p.installation_version AND c.enabled AND c.version=p.installation_version
 AND p.admission->'binding'=collab_git.task_push_binding(p.repository_id)
 AND p.admission->'source'=jsonb_build_object('workspaceId',w.id,'identity',jsonb_build_object('runId',r.id,'executorId',r.executor_id,'epoch',r.epoch::text)),false)
 FROM collab_git.push_previews p JOIN collab.tasks t ON t.id=p.task_id JOIN collab.runs r ON r.id=p.run_id JOIN collab.workspaces w ON w.id=p.workspace_id
 JOIN collab.github_bindings b ON b.repository_id=p.repository_id JOIN collab.github_installations c ON c.id=p.connection_id WHERE p.id=preview
$$;
CREATE FUNCTION collab_git.claim_push_preview() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab_git.push_previews; nonce uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(918276440);
 FOR p IN SELECT * FROM collab_git.push_previews WHERE status IN ('queued','running') ORDER BY updated_at,id LIMIT 100 LOOP
  IF NOT pg_try_advisory_lock(hashtextextended(p.id::text,918276439)) THEN CONTINUE; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p.organization_id::text,811));
  SELECT * INTO STRICT p FROM collab_git.push_previews WHERE id=p.id FOR UPDATE;
  IF p.status='running' THEN
   -- No receive-pack exists in this phase. Old claims can only finish their
   -- private reads/artifacts; they can no longer publish any preview evidence.
   UPDATE collab_git.push_previews SET status='failed',failure='task_push_preview_reader_lost',updated_at=now(),finished_at=now() WHERE id=p.id;
   INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(p.organization_id,p.project_id,p.actor_id,'task_push_preview.reader_lost',p.id::text,'{}');
   PERFORM pg_advisory_unlock(hashtextextended(p.id::text,918276439)); RETURN collab_git.push_preview_result(p.id);
  END IF;
  IF p.status<>'queued' THEN PERFORM pg_advisory_unlock(hashtextextended(p.id::text,918276439)); CONTINUE; END IF;
  nonce:=gen_random_uuid();
  UPDATE collab_git.push_previews SET status='running',claim_id=nonce,backend_pid=pg_backend_pid(),updated_at=now() WHERE id=p.id;
  RETURN jsonb_build_object('jobId',p.id,'claimId',nonce,'admission',p.admission,'organizationId',p.organization_id,'connectionId',p.connection_id);
 END LOOP;
 RETURN NULL;
END $$;
CREATE FUNCTION collab_git.lock_push_preview(preview uuid, nonce uuid) RETURNS collab_git.push_previews LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab_git.push_previews;
BEGIN
 SELECT * INTO p FROM collab_git.push_previews WHERE id=preview;
 IF p.id IS NULL OR nonce IS NULL THEN RAISE EXCEPTION 'task_push_preview_claim_lost' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p.organization_id::text,811));
 SELECT * INTO STRICT p FROM collab_git.push_previews WHERE id=preview FOR UPDATE;
 IF p.status<>'running' OR p.claim_id IS DISTINCT FROM nonce OR p.backend_pid IS DISTINCT FROM pg_backend_pid() THEN RAISE EXCEPTION 'task_push_preview_claim_lost' USING ERRCODE='P0001'; END IF;
 RETURN p;
END $$;
CREATE FUNCTION collab_git.push_preview_live(preview uuid, nonce uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT COALESCE((SELECT status='running' AND read_started AND claim_id=nonce AND backend_pid=pg_backend_pid() AND collab_git.push_preview_grant(id)
 FROM collab_git.push_previews WHERE id=preview),false)
$$;
CREATE FUNCTION collab_git.begin_push_preview(preview uuid, nonce uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab_git.push_previews;
BEGIN
 p:=collab_git.lock_push_preview(preview,nonce); PERFORM 1 FROM public."user" WHERE id=p.actor_id FOR SHARE;
 IF p.read_started OR collab_git.push_preview_grant(preview) IS DISTINCT FROM true THEN RAISE EXCEPTION 'task_push_preview_authority_changed' USING ERRCODE='P0001'; END IF;
 UPDATE collab_git.push_previews SET read_started=true,updated_at=now() WHERE id=preview;
 RETURN (SELECT jsonb_build_object('appId',c.app_id,'installationId',c.installation_id,'accountId',c.account_id,'sealed',s.sealed)
 FROM collab.github_installations c JOIN collab_git.credentials s ON s.connection_id=c.id WHERE c.id=p.connection_id);
END $$;

CREATE FUNCTION collab_git.finish_push_preview(preview uuid, nonce uuid, observation_text text, manifest_text text, manifest_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab_git.push_previews; o jsonb; m jsonb; target jsonb; base jsonb; binding jsonb; c collab.github_installations; expected jsonb; observed_hash text;
BEGIN
 p:=collab_git.lock_push_preview(preview,nonce); PERFORM 1 FROM public."user" WHERE id=p.actor_id FOR SHARE;
 PERFORM 1 FROM collab.runs WHERE id=p.run_id FOR SHARE; PERFORM 1 FROM collab.tasks WHERE id=p.task_id FOR SHARE;
 PERFORM 1 FROM collab.workspaces WHERE id=p.workspace_id FOR SHARE; PERFORM 1 FROM collab.github_bindings WHERE repository_id=p.repository_id FOR SHARE;
 SELECT * INTO STRICT c FROM collab.github_installations WHERE id=p.connection_id FOR SHARE;
 IF NOT p.read_started OR collab_git.push_preview_grant(preview) IS DISTINCT FROM true THEN RAISE EXCEPTION 'task_push_preview_authority_changed' USING ERRCODE='P0001'; END IF;
 IF observation_text IS NULL OR octet_length(observation_text)>65536 OR manifest_text IS NULL OR octet_length(manifest_text)>8388608
 OR manifest_hash IS NULL OR manifest_hash!~'^[a-f0-9]{64}$' OR encode(sha256(convert_to(manifest_text,'UTF8')),'hex')<>manifest_hash THEN RAISE EXCEPTION 'invalid_task_push_preview_evidence' USING ERRCODE='P0001'; END IF;
 o:=observation_text::jsonb; m:=manifest_text::jsonb; target:=o->'target'; base:=o->'baseline'; binding:=p.admission->'binding';
 observed_hash:=encode(sha256(convert_to(observation_text,'UTF8')),'hex');
 expected:=jsonb_build_object('version',1,'exportId',p.id,'source',p.admission->'source','revision',p.admission->>'revision',
 'intent',jsonb_build_object('operationId',p.admission->>'operationId','repositoryId',p.repository_id,'taskId',p.task_id,'workspaceId',p.workspace_id,
 'expectedOld',target->'observedOld','newSha',p.admission->>'head'),
 'remoteBaseline',jsonb_build_object('sha',target->>'defaultSha','observationHash',observed_hash,'captureId',p.id));
 IF jsonb_typeof(o) IS DISTINCT FROM 'object' OR (o-ARRAY['baseline','target'])<>'{}'::jsonb
 OR target->'version' IS DISTINCT FROM '1'::jsonb OR base->'version' IS DISTINCT FROM '1'::jsonb
 OR target->'repository' IS DISTINCT FROM binding OR target->>'ref' IS DISTINCT FROM 'refs/heads/pi-collab/tasks/'||p.task_id::text||'/workspaces/'||p.workspace_id::text
 OR target->'protected' IS DISTINCT FROM 'false'::jsonb OR target->'activeRules' IS DISTINCT FROM '0'::jsonb
 OR COALESCE(target->>'defaultSha','')!~'^[a-f0-9]{40}$' OR NOT (target ? 'observedOld')
 OR (target->'observedOld'<>'null'::jsonb AND COALESCE(target->>'observedOld','')!~'^[a-f0-9]{40}$')
 OR base->'tokenRevoked' IS DISTINCT FROM 'true'::jsonb OR base->>'targetSha' IS DISTINCT FROM target->>'defaultSha'
 OR base->>'repositoryId' IS DISTINCT FROM binding->>'githubRepositoryId' OR base->>'nodeId' IS DISTINCT FROM binding->>'nodeId'
 OR base->>'ownerId' IS DISTINCT FROM binding->>'ownerId' OR base->>'ownerLogin' IS DISTINCT FROM binding->>'ownerLogin'
 OR base->>'name' IS DISTINCT FROM binding->>'name' OR base->>'defaultBranch' IS DISTINCT FROM binding->>'defaultBranch'
 OR base->'private' IS DISTINCT FROM binding->'private' OR base->>'visibility' IS DISTINCT FROM binding->>'visibility'
 OR base->'capabilities' IS DISTINCT FROM '{"metadataRead":true,"contentsRead":true,"push":false,"pullRequest":false,"protectedMerge":false}'::jsonb
 OR target->'installation'->>'appId' IS DISTINCT FROM c.app_id OR target->'installation'->>'installationId' IS DISTINCT FROM c.installation_id OR target->'installation'->>'accountId' IS DISTINCT FROM c.account_id
 OR base->'installation'->>'appId' IS DISTINCT FROM c.app_id OR base->'installation'->>'installationId' IS DISTINCT FROM c.installation_id OR base->'installation'->>'accountId' IS DISTINCT FROM c.account_id
 OR target->'installation'->'permissions'->>'contents' IS DISTINCT FROM 'write'
 OR m->'version' IS DISTINCT FROM '1'::jsonb OR m->>'policy' IS DISTINCT FROM 'task-history-v1' OR m->'input' IS DISTINCT FROM expected
 OR m->>'ref' IS DISTINCT FROM 'refs/heads/export/'||p.id::text OR COALESCE(m->>'receiptHash','')!~'^[a-f0-9]{64}$'
 OR jsonb_typeof(m->'commits') IS DISTINCT FROM 'array' OR jsonb_typeof(m->'objects') IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'invalid_task_push_preview_evidence' USING ERRCODE='P0001'; END IF;
 IF jsonb_array_length(m->'commits') NOT BETWEEN 1 AND 1000 OR jsonb_array_length(m->'objects')>20000
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(m->'commits') item WHERE item->>'oid'=p.admission->>'head') THEN RAISE EXCEPTION 'invalid_task_push_preview_evidence' USING ERRCODE='P0001'; END IF;
 UPDATE collab_git.push_previews SET status='ready',observation=o,observation_hash=observed_hash,manifest=m,manifest_hash=finish_push_preview.manifest_hash,
 failure=NULL,updated_at=now(),finished_at=now() WHERE id=preview;
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(p.organization_id,p.project_id,p.actor_id,'task_push_preview.ready',preview::text,
 jsonb_build_object('manifestHash',manifest_hash,'observationHash',observed_hash,'head',p.admission->>'head','commitCount',jsonb_array_length(m->'commits')));
 RETURN collab_git.push_preview_result(preview);
END $$;
CREATE FUNCTION collab_git.fail_push_preview(preview uuid, nonce uuid, failure_code text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab_git.push_previews;
BEGIN
 p:=collab_git.lock_push_preview(preview,nonce);
 IF failure_code IS NULL OR failure_code!~'^[a-z_]{1,120}$' THEN RAISE EXCEPTION 'invalid_task_push_preview_evidence' USING ERRCODE='P0001'; END IF;
 UPDATE collab_git.push_previews SET status=CASE WHEN stop_requested THEN 'cancelled' ELSE 'failed' END,
 failure=CASE WHEN stop_requested THEN 'task_push_preview_cancelled' ELSE failure_code END,updated_at=now(),finished_at=now() WHERE id=preview;
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(p.organization_id,p.project_id,p.actor_id,'task_push_preview.failed',preview::text,jsonb_build_object('failure',failure_code));
 RETURN collab_git.push_preview_result(preview);
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA collab_git FROM PUBLIC;
REVOKE ALL ON FUNCTION collab.request_task_push_preview(uuid,uuid,jsonb),collab.cancel_task_push_preview(uuid,text,uuid),collab.task_push_previews(uuid),collab.task_push_preview_detail(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.request_task_push_preview(uuid,uuid,jsonb),collab.cancel_task_push_preview(uuid,text,uuid),collab.task_push_previews(uuid),collab.task_push_preview_detail(uuid) TO pi_collab_app;
GRANT EXECUTE ON FUNCTION collab_git.claim_push_preview(),collab_git.begin_push_preview(uuid,uuid),collab_git.push_preview_live(uuid,uuid),collab_git.finish_push_preview(uuid,uuid,text,text,text),collab_git.fail_push_preview(uuid,uuid,text) TO pi_collab_git;
