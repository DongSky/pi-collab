-- New repository access requires BOTH installation administration and project
-- maintainership. A project role alone must not spend a broad org installation.
CREATE TABLE collab_git.import_dispatch (
 import_id uuid PRIMARY KEY REFERENCES collab.github_imports(id),
 state text NOT NULL CHECK(state IN ('queued','running','attention','done')),
 mode text NOT NULL CHECK(mode IN ('import','reconcile')),
 actor_id text NOT NULL REFERENCES public."user"(id), organization_version bigint NOT NULL, project_version bigint NOT NULL,
 stop_requested boolean NOT NULL DEFAULT false, claim_id uuid, backend_pid integer, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE collab.github_import_actions (
 import_id uuid NOT NULL REFERENCES collab.github_imports(id), actor_id text NOT NULL REFERENCES public."user"(id), idempotency_key uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('cancel','reconcile')), reason text NOT NULL CHECK(length(reason) BETWEEN 10 AND 2000), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(import_id,actor_id,idempotency_key)
);
CREATE FUNCTION collab_git.import_authority(project uuid, actor text, org_version bigint DEFAULT NULL, project_version bigint DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT collab_git.sync_authority(project,actor,org_version,project_version) AND EXISTS(
 SELECT 1 FROM collab.projects p JOIN collab.memberships m ON m.organization_id=p.organization_id
 WHERE p.id=project AND m.user_id=actor AND m.active AND m.role IN ('owner','admin'))
$$;
CREATE FUNCTION collab.github_import_dispatch_state(operation uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('state',d.state,'mode',d.mode,'stopRequested',d.stop_requested) FROM collab_git.import_dispatch d JOIN collab.github_imports i ON i.id=d.import_id
 WHERE i.id=operation AND collab.project_role(i.project_id) IS NOT NULL
$$;
CREATE FUNCTION collab.request_github_import(project uuid, connection uuid, remote_id text, name text, reason text, request_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab.projects; c collab.github_installations; prior collab.github_imports; operation uuid:=gen_random_uuid(); repository uuid:=gen_random_uuid(); payload jsonb; ov bigint; pv bigint;
BEGIN
 SELECT * INTO p FROM collab.projects WHERE id=project;
 IF p.id IS NULL OR collab.project_role(p.id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p.organization_id::text,811)); PERFORM 1 FROM public."user" WHERE id=collab.actor() FOR SHARE;
 IF collab.project_role(p.id) IS DISTINCT FROM 'maintainer' OR COALESCE(collab.org_role(p.organization_id),'') NOT IN ('owner','admin') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
 IF connection IS NULL OR remote_id IS NULL OR remote_id!~'^[1-9][0-9]{0,15}$' OR name IS NULL OR length(btrim(name)) NOT BETWEEN 1 AND 120 OR reason IS NULL OR length(btrim(reason)) NOT BETWEEN 10 AND 2000 OR request_key IS NULL THEN RAISE EXCEPTION 'invalid_github_import' USING ERRCODE='P0001'; END IF;
 payload:=jsonb_build_object('connectionId',connection,'githubRepositoryId',remote_id,'name',btrim(name),'reason',btrim(reason));
 SELECT * INTO prior FROM collab.github_imports WHERE project_id=project AND actor_id=collab.actor() AND idempotency_key=request_key;
 IF FOUND THEN
  IF prior.request<>payload THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
  RETURN jsonb_build_object('jobId',prior.id,'repositoryId',prior.repository_id,'status',prior.status,'replayed',true);
 END IF;
 SELECT * INTO c FROM collab.github_installations WHERE id=connection AND organization_id=p.organization_id AND enabled;
 IF NOT FOUND THEN RAISE EXCEPTION 'github_connection_unavailable' USING ERRCODE='P0001'; END IF;
 IF EXISTS(SELECT 1 FROM collab.github_bindings WHERE github_repository_id=remote_id) OR EXISTS(SELECT 1 FROM collab.github_imports WHERE github_repository_id=remote_id AND status<>'failed') THEN RAISE EXCEPTION 'github_repository_unavailable' USING ERRCODE='P0001'; END IF;
 IF (SELECT count(*) FROM collab.github_imports WHERE project_id=project AND status NOT IN ('completed','failed'))>=20 THEN RAISE EXCEPTION 'github_import_limit' USING ERRCODE='P0001'; END IF;
 SELECT authorization_version INTO ov FROM collab.memberships WHERE organization_id=p.organization_id AND user_id=collab.actor();
 SELECT authorization_version INTO pv FROM collab.project_memberships WHERE project_id=project AND user_id=collab.actor();
 INSERT INTO collab.github_imports(id,repository_id,organization_id,project_id,connection_id,github_repository_id,actor_id,idempotency_key,organization_version,project_version,installation_version,request)
 VALUES(operation,repository,p.organization_id,p.id,c.id,remote_id,collab.actor(),request_key,ov,pv,c.version,payload);
 INSERT INTO collab_git.import_dispatch(import_id,state,mode,actor_id,organization_version,project_version) VALUES(operation,'queued','import',collab.actor(),ov,pv);
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(p.organization_id,p.id,collab.actor(),'github.import_requested',operation::text,payload||jsonb_build_object('source','web'));
 RETURN jsonb_build_object('jobId',operation,'repositoryId',repository,'status','pending','replayed',false);
EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'github_repository_unavailable' USING ERRCODE='P0001';
END $$;
CREATE FUNCTION collab.github_import_action(operation uuid, action text, reason text, request_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i collab.github_imports; prior collab.github_import_actions; d collab_git.import_dispatch; ov bigint; pv bigint;
BEGIN
 SELECT * INTO i FROM collab.github_imports WHERE id=operation;
 IF i.id IS NULL OR collab.project_role(i.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(i.organization_id::text,811)); PERFORM 1 FROM public."user" WHERE id=collab.actor() FOR SHARE;
 IF collab.project_role(i.project_id) IS DISTINCT FROM 'maintainer' OR COALESCE(collab.org_role(i.organization_id),'') NOT IN ('owner','admin') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
 IF action IS NULL OR action NOT IN ('cancel','reconcile') OR reason IS NULL OR length(btrim(reason)) NOT BETWEEN 10 AND 2000 OR request_key IS NULL THEN RAISE EXCEPTION 'invalid_github_import' USING ERRCODE='P0001'; END IF;
 SELECT * INTO prior FROM collab.github_import_actions WHERE import_id=operation AND actor_id=collab.actor() AND idempotency_key=request_key;
 IF FOUND THEN
  IF prior.kind<>action OR prior.reason<>btrim(reason) THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
  RETURN jsonb_build_object('jobId',operation,'replayed',true);
 END IF;
 SELECT * INTO STRICT i FROM collab.github_imports WHERE id=operation;
 SELECT * INTO d FROM collab_git.import_dispatch WHERE import_id=operation FOR UPDATE;
 IF i.status NOT IN ('completed','failed') THEN
  IF action='cancel' AND d.import_id IS NOT NULL AND d.state IN ('queued','running') THEN
   UPDATE collab_git.import_dispatch SET stop_requested=true,updated_at=now() WHERE import_id=operation;
  ELSE
   IF NOT pg_try_advisory_xact_lock(hashtextextended(operation::text,918276432)) THEN RAISE EXCEPTION 'github_import_busy' USING ERRCODE='P0001'; END IF;
   SELECT authorization_version INTO ov FROM collab.memberships WHERE organization_id=i.organization_id AND user_id=collab.actor();
   SELECT authorization_version INTO pv FROM collab.project_memberships WHERE project_id=i.project_id AND user_id=collab.actor();
   INSERT INTO collab_git.import_dispatch(import_id,state,mode,actor_id,organization_version,project_version,stop_requested)
   VALUES(operation,'queued','reconcile',collab.actor(),ov,pv,action='cancel')
   ON CONFLICT(import_id) DO UPDATE SET state='queued',mode='reconcile',actor_id=EXCLUDED.actor_id,organization_version=EXCLUDED.organization_version,project_version=EXCLUDED.project_version,
    stop_requested=collab_git.import_dispatch.stop_requested OR EXCLUDED.stop_requested,claim_id=NULL,backend_pid=NULL,updated_at=now();
  END IF;
 END IF;
 INSERT INTO collab.github_import_actions VALUES(operation,collab.actor(),request_key,action,btrim(reason),now());
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(i.organization_id,i.project_id,collab.actor(),'github.import_'||action||'_requested',operation::text,jsonb_build_object('reason',btrim(reason),'source','web'));
 RETURN jsonb_build_object('jobId',operation,'replayed',false);
END $$;
CREATE FUNCTION collab_git.guard_import_update() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE d collab_git.import_dispatch;
BEGIN
 SELECT * INTO d FROM collab_git.import_dispatch WHERE import_id=NEW.id;
 IF d.import_id IS NOT NULL AND (d.state<>'running' OR d.backend_pid IS DISTINCT FROM pg_backend_pid()) THEN RAISE EXCEPTION 'github_import_managed_by_broker' USING ERRCODE='P0001'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER github_import_broker_owner BEFORE UPDATE ON collab.github_imports FOR EACH ROW EXECUTE FUNCTION collab_git.guard_import_update();
CREATE FUNCTION collab_git.claim_import() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE d collab_git.import_dispatch; i collab.github_imports; nonce uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(918276435);
 FOR d IN SELECT * FROM collab_git.import_dispatch WHERE state IN ('queued','running') ORDER BY updated_at,import_id LIMIT 100 LOOP
  IF NOT pg_try_advisory_lock(hashtextextended(d.import_id::text,918276432)) THEN CONTINUE; END IF;
  SELECT * INTO STRICT i FROM collab.github_imports WHERE id=d.import_id;
  PERFORM pg_advisory_xact_lock(hashtextextended(i.organization_id::text,811));
  SELECT * INTO STRICT d FROM collab_git.import_dispatch WHERE import_id=i.id FOR UPDATE;
  IF i.status IN ('completed','failed') THEN
   UPDATE collab_git.import_dispatch SET state='done',updated_at=now() WHERE import_id=i.id;
   PERFORM pg_advisory_unlock(hashtextextended(i.id::text,918276432)); CONTINUE;
  END IF;
  IF d.state='running' THEN
   UPDATE collab_git.import_dispatch SET state='attention',updated_at=now() WHERE import_id=i.id;
   INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(i.organization_id,i.project_id,d.actor_id,'github.import_broker_lost',i.id::text,'{}');
   PERFORM pg_advisory_unlock(hashtextextended(i.id::text,918276432)); RETURN jsonb_build_object('attentionJob',i.id);
  END IF;
  IF d.state<>'queued' THEN PERFORM pg_advisory_unlock(hashtextextended(i.id::text,918276432)); CONTINUE; END IF;
  nonce:=gen_random_uuid(); UPDATE collab_git.import_dispatch SET state='running',claim_id=nonce,backend_pid=pg_backend_pid(),updated_at=now() WHERE import_id=i.id;
  RETURN jsonb_build_object('claimId',nonce,'mode',d.mode,'job',to_jsonb(i));
 END LOOP;
 RETURN NULL;
END $$;
CREATE FUNCTION collab_git.lock_import(operation uuid, nonce uuid) RETURNS collab.github_imports LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i collab.github_imports; d collab_git.import_dispatch;
BEGIN
 SELECT * INTO i FROM collab.github_imports WHERE id=operation;
 IF i.id IS NULL OR nonce IS NULL THEN RAISE EXCEPTION 'github_import_claim_lost' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(i.organization_id::text,811)); SELECT * INTO d FROM collab_git.import_dispatch WHERE import_id=operation FOR UPDATE;
 IF d.state IS DISTINCT FROM 'running' OR d.claim_id IS DISTINCT FROM nonce OR d.backend_pid IS DISTINCT FROM pg_backend_pid() THEN RAISE EXCEPTION 'github_import_claim_lost' USING ERRCODE='P0001'; END IF;
 SELECT * INTO STRICT i FROM collab.github_imports WHERE id=operation FOR UPDATE; RETURN i;
END $$;
CREATE FUNCTION collab_git.authorize_import(operation uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i collab.github_imports; d collab_git.import_dispatch;
BEGIN
 SELECT * INTO STRICT i FROM collab.github_imports WHERE id=operation; SELECT * INTO STRICT d FROM collab_git.import_dispatch WHERE import_id=operation;
 PERFORM 1 FROM public."user" WHERE id=d.actor_id FOR SHARE;
 IF d.stop_requested THEN RAISE EXCEPTION 'github_import_cancelled' USING ERRCODE='P0001'; END IF;
 IF NOT collab_git.import_authority(i.project_id,d.actor_id,d.organization_version,d.project_version) THEN RAISE EXCEPTION 'github_import_authority_changed' USING ERRCODE='P0001'; END IF;
 IF NOT EXISTS(SELECT 1 FROM collab.github_installations WHERE id=i.connection_id AND enabled AND version=i.installation_version) THEN RAISE EXCEPTION 'github_connection_unavailable' USING ERRCODE='P0001'; END IF;
END $$;
CREATE FUNCTION collab_git.begin_import(operation uuid, nonce uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i collab.github_imports; c collab.github_installations;
BEGIN
 i:=collab_git.lock_import(operation,nonce); PERFORM collab_git.authorize_import(operation);
 IF (SELECT mode FROM collab_git.import_dispatch WHERE import_id=operation)='reconcile' THEN RETURN '{}'::jsonb; END IF;
 IF i.status<>'pending' THEN RAISE EXCEPTION 'github_import_claim_lost' USING ERRCODE='P0001'; END IF;
 UPDATE collab.github_imports SET status='fetching' WHERE id=operation;
 SELECT * INTO STRICT c FROM collab.github_installations WHERE id=i.connection_id;
 RETURN jsonb_build_object('appId',c.app_id,'installationId',c.installation_id,'accountId',c.account_id,'sealed',(SELECT sealed FROM collab_git.credentials WHERE connection_id=c.id));
END $$;
CREATE FUNCTION collab_git.finish_import(operation uuid, nonce uuid, evidence jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i collab.github_imports; c collab.github_installations; actor text;
BEGIN
 i:=collab_git.lock_import(operation,nonce); PERFORM collab_git.authorize_import(operation);
 SELECT actor_id INTO actor FROM collab_git.import_dispatch WHERE import_id=operation;
 SELECT * INTO STRICT c FROM collab.github_installations WHERE id=i.connection_id;
 IF i.status<>'fetching' OR evidence IS NULL OR jsonb_typeof(evidence)<>'object' OR pg_column_size(evidence)>65536
 OR evidence->>'repositoryId' IS DISTINCT FROM i.github_repository_id OR evidence->'tokenRevoked' IS DISTINCT FROM 'true'::jsonb
 OR evidence->'installation'->>'appId' IS DISTINCT FROM c.app_id OR evidence->'installation'->>'installationId' IS DISTINCT FROM c.installation_id OR evidence->'installation'->>'accountId' IS DISTINCT FROM c.account_id
 OR COALESCE(evidence->>'targetSha','')!~'^[a-f0-9]{40}$' OR length(COALESCE(evidence->>'defaultBranch','')) NOT BETWEEN 1 AND 240
 OR COALESCE(evidence->>'verifiedAt','')!~'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
 THEN RAISE EXCEPTION 'invalid_github_import_evidence' USING ERRCODE='P0001'; END IF;
 INSERT INTO collab.repositories(id,organization_id,project_id,name,provider,base_sha,default_branch) VALUES(i.repository_id,i.organization_id,i.project_id,i.request->>'name','github',evidence->>'targetSha',evidence->>'defaultBranch');
 INSERT INTO collab.github_bindings(repository_id,organization_id,project_id,connection_id,installation_version,github_repository_id,evidence,bound_by,idempotency_key,request,verified_at)
 VALUES(i.repository_id,i.organization_id,i.project_id,i.connection_id,i.installation_version,i.github_repository_id,finish_import.evidence,actor,i.idempotency_key,jsonb_build_object('connectionId',i.connection_id,'githubRepositoryId',i.github_repository_id,'reason',i.request->>'reason'),(evidence->>'verifiedAt')::timestamptz);
 UPDATE collab.github_imports SET status='completed',evidence=finish_import.evidence,finished_at=now() WHERE id=operation;
 UPDATE collab_git.import_dispatch SET state='done',updated_at=now() WHERE import_id=operation;
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(i.organization_id,i.project_id,actor,'github.repository_imported',i.repository_id::text,jsonb_build_object('jobId',i.id,'targetSha',evidence->>'targetSha','defaultBranch',evidence->>'defaultBranch','requestedBy',i.actor_id,'source','git-broker'));
 RETURN jsonb_build_object('jobId',i.id,'repositoryId',i.repository_id,'status','completed','baseSha',evidence->>'targetSha');
END $$;
CREATE FUNCTION collab_git.fail_import(operation uuid, nonce uuid, failure text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i collab.github_imports; actor text;
BEGIN
 i:=collab_git.lock_import(operation,nonce); SELECT actor_id INTO actor FROM collab_git.import_dispatch WHERE import_id=operation;
 IF failure IS NULL OR failure!~'^[a-z_]{1,120}$' THEN RAISE EXCEPTION 'invalid_github_import_evidence' USING ERRCODE='P0001'; END IF;
 UPDATE collab.github_imports SET status='failed',failure=fail_import.failure,finished_at=now() WHERE id=operation;
 UPDATE collab_git.import_dispatch SET state='done',updated_at=now() WHERE import_id=operation;
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(i.organization_id,i.project_id,actor,'github.import_failed',i.id::text,jsonb_build_object('reason',failure,'source','git-broker'));
 RETURN jsonb_build_object('jobId',i.id,'status','failed');
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA collab_git FROM PUBLIC;
REVOKE ALL ON FUNCTION collab.request_github_import(uuid,uuid,text,text,text,uuid),collab.github_import_action(uuid,text,text,uuid),collab.github_import_dispatch_state(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.request_github_import(uuid,uuid,text,text,text,uuid),collab.github_import_action(uuid,text,text,uuid),collab.github_import_dispatch_state(uuid) TO pi_collab_app;
GRANT EXECUTE ON FUNCTION collab_git.claim_import(),collab_git.begin_import(uuid,uuid),collab_git.finish_import(uuid,uuid,jsonb),collab_git.fail_import(uuid,uuid,text) TO pi_collab_git;
