-- Automatically allocated scratch resources. These are managed PostgreSQL
-- schemas, not production databases; credentials stay inside the SQL broker.
CREATE SEQUENCE collab_broker.environment_ports MINVALUE 41000 MAXVALUE 60999 CYCLE;
CREATE TABLE collab.workspace_environments (
 workspace_id uuid PRIMARY KEY REFERENCES collab.workspaces(id), organization_id uuid NOT NULL, project_id uuid NOT NULL,
 resource_id uuid NOT NULL UNIQUE REFERENCES collab.resources(id), port integer CHECK(port BETWEEN 41000 AND 60999),
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','resetting','reclaiming','released')),
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), released_at timestamptz,
 FOREIGN KEY(organization_id,project_id) REFERENCES collab.projects(organization_id,id)
);
CREATE UNIQUE INDEX environment_port_occupied ON collab.workspace_environments(port) WHERE port IS NOT NULL;
ALTER TABLE collab.workspace_environments ENABLE ROW LEVEL SECURITY;
CREATE POLICY environment_read ON collab.workspace_environments FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
GRANT SELECT ON collab.workspace_environments TO pi_collab_app;
CREATE TABLE collab_broker.environment_operations (
 workspace_id uuid NOT NULL REFERENCES collab.workspaces(id), actor_id text NOT NULL, request_key uuid NOT NULL, payload jsonb NOT NULL,result jsonb NOT NULL,
 PRIMARY KEY(workspace_id,actor_id,request_key)
);
CREATE FUNCTION collab_broker.allocate_environment() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE resource uuid:=gen_random_uuid(); assigned integer; attempts integer:=0;
BEGIN
 IF NEW.status<>'starting' OR OLD.status='starting' OR EXISTS(SELECT 1 FROM collab.workspace_environments WHERE workspace_id=NEW.workspace_id) THEN RETURN NEW; END IF;
 -- Claim holds the global scheduler lock before the organization lock.
 LOOP
  assigned:=nextval('collab_broker.environment_ports');attempts:=attempts+1;
  EXIT WHEN NOT EXISTS(SELECT 1 FROM collab.workspace_environments WHERE port=assigned);
  IF attempts>=20000 THEN RAISE EXCEPTION 'environment_capacity_exhausted' USING ERRCODE='P0001'; END IF;
 END LOOP;
 INSERT INTO collab.resources(id,organization_id,project_id,name,created_by,idempotency_key) VALUES(resource,NEW.organization_id,NEW.project_id,'工作区 '||left(NEW.workspace_id::text,8)||' 测试库',NEW.requested_by,gen_random_uuid());
 INSERT INTO collab.workspace_environments(workspace_id,organization_id,project_id,resource_id,port) VALUES(NEW.workspace_id,NEW.organization_id,NEW.project_id,resource,assigned);
 RETURN NEW;
END $$;
CREATE TRIGGER allocate_run_environment AFTER UPDATE OF status ON collab.runs FOR EACH ROW EXECUTE FUNCTION collab_broker.allocate_environment();

-- Auto resources must not consume the manually-created shared-resource quota.
CREATE OR REPLACE FUNCTION collab.create_resource(project uuid, name text, request_key uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab.projects; prior collab.resources; resource uuid:=gen_random_uuid();
BEGIN
  p:=collab.require_project_management(project);
  IF request_key IS NULL OR name IS NULL OR length(btrim(name)) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid_resource' USING ERRCODE='P0001'; END IF;
  SELECT * INTO prior FROM collab.resources WHERE project_id=project AND created_by=collab.actor() AND idempotency_key=request_key;
  IF FOUND THEN IF prior.name<>btrim(name) THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF; RETURN jsonb_build_object('resourceId',prior.id,'replayed',true); END IF;
  IF (SELECT count(*) FROM collab.resources WHERE project_id=project AND id NOT IN (SELECT resource_id FROM collab.workspace_environments))>=16 THEN RAISE EXCEPTION 'resource_limit' USING ERRCODE='P0001'; END IF;
  INSERT INTO collab.resources(id,organization_id,project_id,name,created_by,idempotency_key) VALUES(resource,p.organization_id,project,btrim(name),collab.actor(),request_key);
  INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id) VALUES(p.organization_id,project,collab.actor(),'resource.created',resource::text);
  RETURN jsonb_build_object('resourceId',resource,'replayed',false);
END $$;
ALTER FUNCTION collab_worker.resource_action(uuid,uuid,bigint,text,jsonb) RENAME TO resource_action_shared;
CREATE FUNCTION collab_worker.resource_action(executor uuid, run uuid, generation bigint, method text, input jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE org uuid;
BEGIN
 SELECT organization_id INTO org FROM collab.runs WHERE id=run;
 IF org IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(org::text,811));
 IF method='request_resource' AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(input->'resourceIds') i JOIN collab.workspace_environments e ON e.resource_id=i.value::uuid WHERE e.state<>'active' OR e.workspace_id IS DISTINCT FROM (SELECT workspace_id FROM collab.runs WHERE id=run)) THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 RETURN collab_worker.resource_action_shared(executor,run,generation,method,input);
END $$;
ALTER FUNCTION collab_broker.context(uuid) RENAME TO context_shared;
CREATE FUNCTION collab_broker.context(run uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT collab_broker.context_shared(run)||jsonb_build_object(
 'environment',(SELECT jsonb_build_object('workspaceId',e.workspace_id,'resourceId',e.resource_id,'port',e.port,'state',e.state,'databaseKind','isolated-postgres-schema','lifetime','scratch; reclaimed 24h after confirmed stop') FROM collab.workspace_environments e JOIN collab.runs r ON r.workspace_id=e.workspace_id WHERE r.id=run),
 'items',coalesce((SELECT jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'status',s.status,'occupied',s.holder_id IS NOT NULL)) FROM collab.resources s LEFT JOIN collab.workspace_environments e ON e.resource_id=s.id WHERE s.project_id=(SELECT project_id FROM collab.runs WHERE id=run) AND (e.workspace_id IS NULL OR e.workspace_id=(SELECT workspace_id FROM collab.runs WHERE id=run))),'[]'::jsonb))
$$;
CREATE FUNCTION collab_worker.run_environment(executor uuid, run uuid, generation bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab.runs;
BEGIN r:=collab_worker.assert_lease(executor,run,generation);
 RETURN (SELECT jsonb_build_object('port',port,'resourceId',resource_id,'state',state) FROM collab.workspace_environments WHERE workspace_id=r.workspace_id);
END $$;
CREATE FUNCTION collab.manage_environment(workspace uuid, request_body jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE e collab.workspace_environments; prior collab_broker.environment_operations; response jsonb; w collab.workspaces;
BEGIN
 SELECT * INTO e FROM collab.workspace_environments WHERE workspace_id=workspace;
 IF e.workspace_id IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM collab.require_project_management(e.project_id);
 SELECT * INTO STRICT e FROM collab.workspace_environments WHERE workspace_id=workspace FOR UPDATE;
 IF request_body->>'action' NOT IN ('reset','reclaim') OR request_body->>'action' IS NULL OR request_body->>'acknowledgeLoss' IS DISTINCT FROM 'true' OR length(btrim(request_body->>'reason')) NOT BETWEEN 10 AND 2000 THEN RAISE EXCEPTION 'invalid_environment' USING ERRCODE='P0001'; END IF;
 SELECT * INTO prior FROM collab_broker.environment_operations WHERE workspace_id=workspace AND actor_id=collab.actor() AND request_key=(request_body->>'idempotencyKey')::uuid;
 IF FOUND THEN IF prior.payload<>request_body THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;RETURN prior.result;END IF;
 IF e.version IS DISTINCT FROM (request_body->>'expectedVersion')::integer OR e.state<>'active' THEN RAISE EXCEPTION 'stale_revision' USING ERRCODE='P0001'; END IF;
 SELECT * INTO STRICT w FROM collab.workspaces WHERE id=workspace;
 IF (request_body->>'action'='reclaim' AND w.status<>'stopped') OR w.status='quarantined' OR EXISTS(SELECT 1 FROM collab.resources WHERE id=e.resource_id AND holder_id IS NOT NULL) OR EXISTS(SELECT 1 FROM collab.resource_jobs WHERE resource_id=e.resource_id AND NOT stopped) OR EXISTS(SELECT 1 FROM collab.resource_requests WHERE e.resource_id=ANY(resource_ids) AND status IN ('waiting','granted','releasing')) THEN RAISE EXCEPTION 'resource_not_drained' USING ERRCODE='P0001'; END IF;
 UPDATE collab.resources SET status='disabled',epoch=epoch+1,version=version+1 WHERE id=e.resource_id;
 UPDATE collab.workspace_environments SET state=CASE WHEN request_body->>'action'='reset' THEN 'resetting' ELSE 'reclaiming' END,version=version+1 WHERE workspace_id=workspace RETURNING jsonb_build_object('version',version,'state',state) INTO response;
 INSERT INTO collab_broker.environment_operations VALUES(workspace,collab.actor(),(request_body->>'idempotencyKey')::uuid,request_body,response);
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(e.organization_id,e.project_id,collab.actor(),'environment.'||(request_body->>'action'),workspace,request_body);
 RETURN response;
END $$;
CREATE FUNCTION collab_broker.reconcile_environments() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE e collab.workspace_environments; credential collab_broker.credentials; count integer:=0;
BEGIN
 FOR e IN SELECT env.* FROM collab.workspace_environments env JOIN collab.workspaces w ON w.id=env.workspace_id WHERE env.state IN ('resetting','reclaiming') OR (env.state='active' AND w.status='stopped' AND EXISTS(SELECT 1 FROM collab.runs WHERE workspace_id=w.id AND finished_at<clock_timestamp()-interval '24 hours')) ORDER BY env.created_at LIMIT 32 LOOP
  IF NOT pg_try_advisory_xact_lock(hashtextextended(e.organization_id::text,811)) THEN CONTINUE; END IF;
  PERFORM collab_broker.advance(e.organization_id);
  SELECT * INTO STRICT e FROM collab.workspace_environments WHERE workspace_id=e.workspace_id FOR UPDATE;
  IF e.state='released' OR EXISTS(SELECT 1 FROM collab.resources WHERE id=e.resource_id AND holder_id IS NOT NULL) OR EXISTS(SELECT 1 FROM collab.resource_jobs WHERE resource_id=e.resource_id AND NOT stopped) OR EXISTS(SELECT 1 FROM collab.resource_requests WHERE e.resource_id=ANY(resource_ids) AND status IN ('waiting','granted','releasing')) THEN CONTINUE; END IF;
  SELECT * INTO credential FROM collab_broker.credentials WHERE resource_id=e.resource_id;
  IF credential.resource_id IS NOT NULL THEN
   IF EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename=credential.role_name) THEN CONTINUE; END IF;
   EXECUTE format('DROP SCHEMA %I CASCADE',credential.schema_name);
   EXECUTE format('DROP OWNED BY %I',credential.role_name);
   EXECUTE format('DROP ROLE %I',credential.role_name);
   DELETE FROM collab_broker.credentials WHERE resource_id=e.resource_id;
  END IF;
  UPDATE collab.resources SET status=CASE WHEN e.state='resetting' THEN 'requested' ELSE 'disabled' END,epoch=epoch+1,version=version+1 WHERE id=e.resource_id;
  UPDATE collab.workspace_environments SET state=CASE WHEN e.state='resetting' THEN 'active' ELSE 'released' END,port=CASE WHEN e.state='resetting' THEN port ELSE NULL END,released_at=CASE WHEN e.state='resetting' THEN NULL ELSE clock_timestamp() END,version=version+1 WHERE workspace_id=e.workspace_id;
  INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) SELECT e.organization_id,e.project_id,created_by,'environment.reconciled',e.workspace_id,jsonb_build_object('operation',CASE WHEN e.state='resetting' THEN 'reset' ELSE 'reclaim' END) FROM collab.resources WHERE id=e.resource_id;
  count:=count+1;
 END LOOP;
 RETURN count;
END $$;
-- Released scratch schemas cannot be resurrected through the shared-resource UI.
ALTER FUNCTION collab.manage_resource(uuid,text,integer,text,uuid) RENAME TO manage_shared_resource;
REVOKE EXECUTE ON FUNCTION collab.manage_shared_resource(uuid,text,integer,text,uuid) FROM pi_collab_app;
CREATE FUNCTION collab.manage_resource(resource uuid, action text, expected_version integer, reason text, request_key uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE project uuid;
BEGIN
 SELECT project_id INTO project FROM collab.resources WHERE id=resource;
 IF project IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM collab.require_project_management(project);
 IF EXISTS(SELECT 1 FROM collab.workspace_environments WHERE resource_id=resource AND state<>'active') THEN RAISE EXCEPTION 'resource_state_changed' USING ERRCODE='P0001'; END IF;
 RETURN collab.manage_shared_resource(resource,action,expected_version,reason,request_key);
END $$;
REVOKE EXECUTE ON FUNCTION collab_broker.allocate_environment(),collab_worker.resource_action(uuid,uuid,bigint,text,jsonb),collab_broker.context(uuid),collab_worker.run_environment(uuid,uuid,bigint),collab.manage_environment(uuid,jsonb),collab_broker.reconcile_environments(),collab.manage_resource(uuid,text,integer,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab_worker.run_environment(uuid,uuid,bigint) TO pi_collab_executor;
GRANT EXECUTE ON FUNCTION collab.manage_environment(uuid,jsonb),collab.manage_resource(uuid,text,integer,text,uuid) TO pi_collab_app;
GRANT EXECUTE ON FUNCTION collab_broker.reconcile_environments() TO pi_collab_broker;
