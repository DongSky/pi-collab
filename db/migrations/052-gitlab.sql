-- Project-scoped GitLab credentials are owned by the separate Git broker.
ALTER TABLE collab.repositories DROP CONSTRAINT repositories_provider_check;
ALTER TABLE collab.repositories ADD CONSTRAINT repositories_provider_check CHECK(provider IN ('local','github','gitlab'));
CREATE TABLE collab.gitlab_connections (
 id uuid PRIMARY KEY,organization_id uuid NOT NULL,project_id uuid NOT NULL,name text NOT NULL,
 origin text NOT NULL,remote_id text NOT NULL CHECK(remote_id~'^[1-9][0-9]{0,15}$'),evidence jsonb NOT NULL,
 repository_id uuid REFERENCES collab.repositories(id),version bigint NOT NULL DEFAULT 1,enabled boolean NOT NULL DEFAULT true,
 registered_by text NOT NULL REFERENCES public."user"(id),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,project_id) REFERENCES collab.projects(organization_id,id),UNIQUE(organization_id,project_id,id),UNIQUE(origin,remote_id)
);
CREATE TABLE collab_git.gitlab_credentials(connection_id uuid PRIMARY KEY REFERENCES collab.gitlab_connections(id),sealed jsonb NOT NULL);
CREATE TABLE collab.gitlab_operations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,project_id uuid NOT NULL,connection_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('import','sync','prepare','publish','observe','ready','merge')),
 actor_id text NOT NULL REFERENCES public."user"(id),organization_version bigint NOT NULL,project_version bigint NOT NULL,connection_version bigint NOT NULL,
 source_id uuid,result_id uuid REFERENCES collab.task_results(id),repository_id uuid NOT NULL,
 request_key uuid NOT NULL,request jsonb NOT NULL,status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','uncertain')),
 stage text NOT NULL DEFAULT 'queued',result jsonb NOT NULL DEFAULT '{}',failure text,claim_id uuid,backend_pid integer,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,project_id,connection_id) REFERENCES collab.gitlab_connections(organization_id,project_id,id),
 UNIQUE(organization_id,project_id,id),UNIQUE(project_id,actor_id,request_key),
 FOREIGN KEY(organization_id,project_id,source_id) REFERENCES collab.gitlab_operations(organization_id,project_id,id)
);
CREATE UNIQUE INDEX gitlab_one_import ON collab.gitlab_operations(connection_id) WHERE kind='import' AND status<>'failed';
CREATE UNIQUE INDEX gitlab_one_delivery ON collab.gitlab_operations(source_id) WHERE kind='publish' AND status<>'failed';
CREATE UNIQUE INDEX gitlab_one_release ON collab.gitlab_operations(source_id) WHERE kind IN ('ready','merge') AND status IN ('queued','running','uncertain');
CREATE UNIQUE INDEX gitlab_one_sync ON collab.gitlab_operations(connection_id) WHERE kind='sync' AND status IN ('queued','running');
CREATE TABLE collab.gitlab_reviews (
 operation_id uuid NOT NULL REFERENCES collab.gitlab_operations(id),reviewer_id text NOT NULL REFERENCES public."user"(id),
 plan_hash text NOT NULL CHECK(plan_hash~'^[a-f0-9]{64}$'),decision text NOT NULL CHECK(decision IN ('approve','reject')),note text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(operation_id,reviewer_id)
);
ALTER TABLE collab.gitlab_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE collab.gitlab_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE collab.gitlab_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY gitlab_connections_read ON collab.gitlab_connections FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
CREATE POLICY gitlab_operations_read ON collab.gitlab_operations FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
CREATE POLICY gitlab_reviews_read ON collab.gitlab_reviews FOR SELECT USING(EXISTS(SELECT 1 FROM collab.gitlab_operations o WHERE o.id=operation_id));
GRANT SELECT ON collab.gitlab_connections,collab.gitlab_operations,collab.gitlab_reviews TO pi_collab_app;
CREATE TRIGGER operations_admission BEFORE INSERT ON collab.gitlab_operations FOR EACH ROW EXECUTE FUNCTION collab_meta.guard_admission();

CREATE FUNCTION collab_git.gitlab_authority(operation uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM collab.gitlab_operations o JOIN collab.gitlab_connections c ON c.id=o.connection_id
 JOIN collab.memberships m ON m.organization_id=o.organization_id AND m.user_id=o.actor_id
 JOIN collab.project_memberships p ON p.project_id=o.project_id AND p.user_id=o.actor_id
 LEFT JOIN collab.task_results r ON r.id=o.result_id LEFT JOIN collab.tasks t ON t.id=r.task_id
 WHERE o.id=operation AND c.enabled AND c.version=o.connection_version AND m.active AND p.active
 AND m.authorization_version=o.organization_version AND p.authorization_version=o.project_version
 AND (NOT collab.user_requires_mfa(o.actor_id) OR EXISTS(SELECT 1 FROM public."user" WHERE id=o.actor_id AND "twoFactorEnabled"))
 AND CASE WHEN o.kind IN ('import','sync','ready','merge') THEN p.role='maintainer' AND EXISTS(SELECT 1 FROM public."user" WHERE id=o.actor_id AND "twoFactorEnabled")
 WHEN o.kind='observe' THEN true ELSE p.role='maintainer' OR p.role='developer' AND t.owner_id=o.actor_id END
 AND (o.kind='observe' OR o.result_id IS NULL OR r.project_id=o.project_id AND r.id=t.current_result_id AND NOT EXISTS(SELECT 1 FROM collab.result_withdrawals WHERE result_id=r.id) AND collab_worker.dependencies_current(r.source_run_id)))
$$;
CREATE FUNCTION collab.request_gitlab_operation(project uuid,connection uuid,body jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c collab.gitlab_connections; p collab.projects; prior collab.gitlab_operations; source collab.gitlab_operations; r collab.task_results; operation uuid:=gen_random_uuid();kind text:=body->>'kind'; repository uuid; v_result uuid; v_source uuid; ov bigint; pv bigint;
BEGIN
 SELECT * INTO p FROM collab.projects WHERE id=project;
 IF p.id IS NULL OR collab.project_role(project) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p.organization_id::text,811));
 IF kind IS NULL OR kind NOT IN ('import','sync','prepare','publish','observe','ready','merge') OR coalesce(length(btrim(body->>'reason')),0) NOT BETWEEN 10 AND 2000 OR body->>'idempotencyKey' IS NULL THEN RAISE EXCEPTION 'invalid_gitlab_operation' USING ERRCODE='P0001';END IF;
 SELECT * INTO prior FROM collab.gitlab_operations WHERE project_id=project AND actor_id=collab.actor() AND request_key=(body->>'idempotencyKey')::uuid;
 IF FOUND THEN IF prior.request<>body OR prior.connection_id<>connection THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001';END IF;RETURN jsonb_build_object('id',prior.id,'status',prior.status,'replayed',true);END IF;
 SELECT * INTO c FROM collab.gitlab_connections WHERE id=connection AND project_id=project AND enabled;
 IF c.id IS NULL THEN RAISE EXCEPTION 'gitlab_connection_unavailable' USING ERRCODE='P0001';END IF;
 IF kind='import' THEN
  -- Imports only read the remote and use a fresh reserved directory. Keep abandoned attempts in history.
  UPDATE collab.gitlab_operations old_op SET status='failed',failure='gitlab_import_abandoned',updated_at=now() WHERE old_op.connection_id=c.id AND old_op.kind='import' AND old_op.status='uncertain';
  IF c.repository_id IS NOT NULL THEN RAISE EXCEPTION 'gitlab_already_imported' USING ERRCODE='P0001';END IF;repository:=gen_random_uuid();
 ELSE
  repository:=c.repository_id;IF repository IS NULL THEN RAISE EXCEPTION 'gitlab_import_required' USING ERRCODE='P0001';END IF;
  IF kind<>'sync' THEN
  IF kind='prepare' THEN v_result:=(body->>'resultId')::uuid;
  ELSE
   v_source:=(body->>'sourceId')::uuid;SELECT * INTO source FROM collab.gitlab_operations WHERE id=v_source AND connection_id=connection AND project_id=project AND status='completed';
   IF source.id IS NULL OR (kind='publish' AND source.kind<>'prepare') OR (kind IN ('observe','ready','merge') AND source.kind<>'publish') THEN RAISE EXCEPTION 'gitlab_source_unavailable' USING ERRCODE='P0001';END IF;
   v_result:=source.result_id;
   IF kind='publish' AND (body->>'planHash' IS DISTINCT FROM source.result->>'planHash' OR body->>'acknowledge' IS DISTINCT FROM 'true') THEN RAISE EXCEPTION 'gitlab_confirmation_required' USING ERRCODE='P0001';END IF;
   IF kind IN ('ready','merge') AND body->>'expectedSha' IS DISTINCT FROM source.result->>'commitSha' THEN RAISE EXCEPTION 'stale_revision' USING ERRCODE='P0001';END IF;
  END IF;
  SELECT * INTO r FROM collab.task_results WHERE id=v_result AND project_id=project;
  IF r.id IS NULL OR NOT EXISTS(SELECT 1 FROM collab.snapshots s JOIN collab.workspaces w ON w.id=s.workspace_id WHERE s.id=r.snapshot_id AND w.repository_id=repository) THEN RAISE EXCEPTION 'gitlab_source_unavailable' USING ERRCODE='P0001';END IF;
  END IF;
 END IF;
 SELECT authorization_version INTO ov FROM collab.memberships WHERE organization_id=p.organization_id AND user_id=collab.actor();SELECT authorization_version INTO pv FROM collab.project_memberships WHERE project_id=project AND user_id=collab.actor();
 INSERT INTO collab.gitlab_operations(id,organization_id,project_id,connection_id,kind,actor_id,organization_version,project_version,connection_version,source_id,result_id,repository_id,request_key,request)
 VALUES(operation,p.organization_id,project,c.id,kind,collab.actor(),ov,pv,c.version,v_source,v_result,repository,(body->>'idempotencyKey')::uuid,body);
 IF NOT collab_git.gitlab_authority(operation) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001';END IF;
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(p.organization_id,project,collab.actor(),'gitlab.'||kind||'_requested',operation::text,jsonb_build_object('reason',body->>'reason','connectionId',connection));
 RETURN jsonb_build_object('id',operation,'status','queued','replayed',false);
EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'gitlab_operation_exists' USING ERRCODE='P0001';
END $$;
CREATE FUNCTION collab.gitlab_review(operation uuid,hash text,decision text,note text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE o collab.gitlab_operations; t collab.tasks;
BEGIN
 SELECT * INTO o FROM collab.gitlab_operations WHERE id=operation;
 IF o.id IS NULL OR collab.project_role(o.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(o.organization_id::text,811));
 SELECT * INTO t FROM collab.tasks WHERE id=(SELECT task_id FROM collab.task_results WHERE id=o.result_id);
 IF coalesce(collab.project_role(o.project_id),'') NOT IN ('maintainer','reviewer') OR collab.actor() IN (o.actor_id,t.owner_id) THEN RAISE EXCEPTION 'independent_review_required' USING ERRCODE='P0001';END IF;
 IF collab.user_requires_mfa(collab.actor()) AND NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001';END IF;
 IF o.kind<>'prepare' OR o.status<>'completed' OR o.result->>'planHash' IS DISTINCT FROM hash OR decision IS NULL OR decision NOT IN ('approve','reject') OR coalesce(length(btrim(note)),0) NOT BETWEEN 10 AND 2000 THEN RAISE EXCEPTION 'invalid_gitlab_review' USING ERRCODE='P0001';END IF;
 INSERT INTO collab.gitlab_reviews VALUES(operation,collab.actor(),hash,decision,note,now()) ON CONFLICT(operation_id,reviewer_id) DO UPDATE SET plan_hash=EXCLUDED.plan_hash,decision=EXCLUDED.decision,note=EXCLUDED.note,created_at=now();
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(o.organization_id,o.project_id,collab.actor(),'gitlab.reviewed',operation::text,jsonb_build_object('decision',decision,'planHash',hash,'note',note));
END $$;
CREATE FUNCTION collab.gitlab_connection_action(connection uuid,expected bigint,enabled boolean,reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c collab.gitlab_connections;
BEGIN
 SELECT * INTO c FROM collab.gitlab_connections WHERE id=connection;
 IF c.id IS NULL OR collab.project_role(c.project_id) IS DISTINCT FROM 'maintainer' OR coalesce(collab.org_role(c.organization_id),'') NOT IN ('owner','admin') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(c.organization_id::text,811));
 IF NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001';END IF;
 IF enabled IS NULL OR coalesce(length(btrim(reason)),0) NOT BETWEEN 10 AND 2000 THEN RAISE EXCEPTION 'invalid_gitlab_operation' USING ERRCODE='P0001';END IF;
 UPDATE collab.gitlab_connections SET enabled=gitlab_connection_action.enabled,version=version+1 WHERE id=connection AND version=expected;
 IF NOT FOUND THEN RAISE EXCEPTION 'stale_revision' USING ERRCODE='P0001';END IF;
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(c.organization_id,c.project_id,collab.actor(),'gitlab.connection_changed',connection::text,jsonb_build_object('enabled',enabled,'reason',reason));
END $$;
CREATE FUNCTION collab_git.claim_gitlab() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE o collab.gitlab_operations; token uuid:=gen_random_uuid();
BEGIN
 FOR o IN SELECT * FROM collab.gitlab_operations WHERE status IN ('queued','running') ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 20 LOOP
  IF NOT pg_try_advisory_lock(hashtextextended(o.id::text,1052)) THEN CONTINUE;END IF;
  IF o.status='running' THEN UPDATE collab.gitlab_operations SET status='uncertain',failure='gitlab_worker_lost',updated_at=now() WHERE id=o.id;PERFORM pg_advisory_unlock(hashtextextended(o.id::text,1052));CONTINUE;END IF;
  IF NOT collab_git.gitlab_authority(o.id) THEN UPDATE collab.gitlab_operations SET status='failed',failure='gitlab_authority_changed' WHERE id=o.id;PERFORM pg_advisory_unlock(hashtextextended(o.id::text,1052));CONTINUE;END IF;
  UPDATE collab.gitlab_operations SET status='running',stage='preparing',claim_id=token,backend_pid=pg_backend_pid(),updated_at=now() WHERE id=o.id;
  RETURN jsonb_build_object('id',o.id,'claimId',token);
 END LOOP;RETURN NULL;
END $$;
CREATE FUNCTION collab_git.gitlab_context(operation uuid,claim uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE o collab.gitlab_operations; c collab.gitlab_connections; source collab.gitlab_operations; prepared collab.gitlab_operations; r collab.task_results;
BEGIN
 SELECT * INTO o FROM collab.gitlab_operations WHERE id=operation;
 IF o.id IS NULL OR o.status<>'running' OR o.claim_id IS DISTINCT FROM claim OR o.backend_pid<>pg_backend_pid() THEN RAISE EXCEPTION 'gitlab_claim_lost' USING ERRCODE='P0001';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(o.organization_id::text,811));
 IF NOT collab_git.gitlab_authority(operation) THEN RAISE EXCEPTION 'gitlab_authority_changed' USING ERRCODE='P0001';END IF;
 SELECT * INTO c FROM collab.gitlab_connections WHERE id=o.connection_id;SELECT * INTO source FROM collab.gitlab_operations WHERE id=o.source_id;
 IF o.kind IN ('observe','ready','merge') THEN SELECT * INTO prepared FROM collab.gitlab_operations WHERE id=source.source_id;ELSE prepared:=source;END IF;
 SELECT * INTO r FROM collab.task_results WHERE id=o.result_id;
 IF o.kind='merge' AND (NOT EXISTS(SELECT 1 FROM collab.gitlab_reviews rv JOIN collab.project_memberships pm ON pm.project_id=o.project_id AND pm.user_id=rv.reviewer_id AND pm.active AND pm.role IN ('maintainer','reviewer') JOIN collab.memberships m ON m.organization_id=o.organization_id AND m.user_id=rv.reviewer_id AND m.active WHERE rv.operation_id=prepared.id AND rv.plan_hash=prepared.result->>'planHash' AND rv.decision='approve' AND rv.reviewer_id<>source.actor_id AND rv.reviewer_id<>prepared.actor_id AND rv.reviewer_id<>(SELECT owner_id FROM collab.tasks WHERE id=r.task_id))
 OR EXISTS(SELECT 1 FROM collab.gitlab_reviews WHERE operation_id=prepared.id AND plan_hash=prepared.result->>'planHash' AND decision='reject')) THEN RAISE EXCEPTION 'independent_review_required' USING ERRCODE='P0001';END IF;
 RETURN jsonb_build_object('job',to_jsonb(o),'connection',to_jsonb(c),'sealed',(SELECT sealed FROM collab_git.gitlab_credentials WHERE connection_id=c.id),'source',to_jsonb(source),'prepared',to_jsonb(prepared),'taskResult',to_jsonb(r),'task',(SELECT to_jsonb(t) FROM collab.tasks t WHERE id=r.task_id));
END $$;
CREATE FUNCTION collab_git.gitlab_stage(operation uuid,claim uuid,stage text,detail jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM collab_git.gitlab_context(operation,claim);
 UPDATE collab.gitlab_operations SET stage=gitlab_stage.stage,result=result||detail,updated_at=now() WHERE id=operation;
END $$;
CREATE FUNCTION collab_git.finish_gitlab(operation uuid,claim uuid,outcome text,detail jsonb,failure text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE o collab.gitlab_operations; c collab.gitlab_connections;
BEGIN
 SELECT * INTO o FROM collab.gitlab_operations WHERE id=operation FOR UPDATE;
 IF o.id IS NULL OR o.status<>'running' OR o.claim_id IS DISTINCT FROM claim OR o.backend_pid<>pg_backend_pid() THEN RAISE EXCEPTION 'gitlab_claim_lost' USING ERRCODE='P0001';END IF;
 IF outcome NOT IN ('completed','failed','uncertain') THEN RAISE EXCEPTION 'invalid_gitlab_operation' USING ERRCODE='P0001';END IF;
 IF outcome='completed' THEN
  PERFORM collab_git.gitlab_context(operation,claim);
  IF o.kind='import' THEN
   SELECT * INTO c FROM collab.gitlab_connections WHERE id=o.connection_id;
   INSERT INTO collab.repositories(id,organization_id,project_id,name,provider,base_sha,default_branch) VALUES(o.repository_id,o.organization_id,o.project_id,c.name,'gitlab',detail->>'baseSha',detail->>'defaultBranch');
   UPDATE collab.gitlab_connections SET repository_id=o.repository_id,evidence=detail WHERE id=c.id;
  ELSIF o.kind='sync' THEN
   UPDATE collab.repositories SET base_sha=detail->>'baseSha' WHERE id=o.repository_id;
   UPDATE collab.gitlab_connections SET evidence=detail WHERE id=o.connection_id;
  END IF;
 END IF;
 UPDATE collab.gitlab_operations SET status=outcome,result=result||detail,failure=finish_gitlab.failure,updated_at=now() WHERE id=operation;
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(o.organization_id,o.project_id,o.actor_id,'gitlab.'||o.kind||'_'||outcome,o.id::text,jsonb_build_object('failure',failure));
 RETURN jsonb_build_object('id',operation,'status',outcome);
END $$;
REVOKE ALL ON FUNCTION collab.request_gitlab_operation(uuid,uuid,jsonb),collab.gitlab_review(uuid,text,text,text),collab.gitlab_connection_action(uuid,bigint,boolean,text),collab_git.gitlab_authority(uuid),collab_git.claim_gitlab(),collab_git.gitlab_context(uuid,uuid),collab_git.gitlab_stage(uuid,uuid,text,jsonb),collab_git.finish_gitlab(uuid,uuid,text,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.request_gitlab_operation(uuid,uuid,jsonb),collab.gitlab_review(uuid,text,text,text),collab.gitlab_connection_action(uuid,bigint,boolean,text) TO pi_collab_app;
GRANT EXECUTE ON FUNCTION collab_git.claim_gitlab(),collab_git.gitlab_context(uuid,uuid),collab_git.gitlab_stage(uuid,uuid,text,jsonb),collab_git.finish_gitlab(uuid,uuid,text,jsonb,text) TO pi_collab_git;

-- Serialize broker work touching one imported baseline or delivery connection.
CREATE FUNCTION collab_git.lock_gitlab_connection(operation uuid,claim uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c uuid;
BEGIN
 PERFORM collab_git.gitlab_context(operation,claim);
 SELECT connection_id INTO c FROM collab.gitlab_operations WHERE id=operation;
 PERFORM pg_advisory_lock(hashtextextended(c::text,2052));
END $$;
REVOKE ALL ON FUNCTION collab_git.lock_gitlab_connection(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab_git.lock_gitlab_connection(uuid,uuid) TO pi_collab_git;
