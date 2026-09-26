CREATE SCHEMA collab_broker;
REVOKE ALL ON SCHEMA collab_broker FROM PUBLIC;
GRANT USAGE ON SCHEMA collab_broker TO pi_collab_broker;
CREATE TABLE collab.resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, project_id uuid NOT NULL, name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 100),
  kind text NOT NULL DEFAULT 'postgres' CHECK(kind='postgres'), status text NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','ready','disabled')),
  epoch bigint NOT NULL DEFAULT 0, holder_id uuid, created_by text NOT NULL REFERENCES public."user"(id), idempotency_key uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,project_id,id), UNIQUE(project_id,created_by,idempotency_key), FOREIGN KEY(organization_id,project_id) REFERENCES collab.projects(organization_id,id)
);
CREATE TABLE collab.resource_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, project_id uuid NOT NULL, run_id uuid NOT NULL, run_epoch bigint NOT NULL,
  requested_by text NOT NULL REFERENCES public."user"(id), resource_ids uuid[] NOT NULL,
  status text NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting','granted','releasing','released','cancelled','timed_out')),
  expires_at timestamptz, wait_until timestamptz NOT NULL DEFAULT now()+interval '5 minutes', reason text,
  idempotency_key uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(run_id,idempotency_key), UNIQUE(organization_id,project_id,id),
  FOREIGN KEY(organization_id,project_id,run_id) REFERENCES collab.runs(organization_id,project_id,id)
);
CREATE UNIQUE INDEX one_active_resource_request ON collab.resource_requests(run_id) WHERE status IN ('waiting','granted','releasing');
ALTER TABLE collab.resources ADD CONSTRAINT resource_holder_scope FOREIGN KEY(organization_id,project_id,holder_id) REFERENCES collab.resource_requests(organization_id,project_id,id);
CREATE TABLE collab.resource_grants (
  organization_id uuid NOT NULL, project_id uuid NOT NULL, request_id uuid NOT NULL, resource_id uuid NOT NULL, fence bigint NOT NULL,
  PRIMARY KEY(request_id,resource_id), FOREIGN KEY(organization_id,project_id,request_id) REFERENCES collab.resource_requests(organization_id,project_id,id),
  FOREIGN KEY(organization_id,project_id,resource_id) REFERENCES collab.resources(organization_id,project_id,id)
);
CREATE TABLE collab.resource_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, project_id uuid NOT NULL, request_id uuid NOT NULL, resource_id uuid NOT NULL, fence bigint NOT NULL,
  run_id uuid NOT NULL, requested_by text NOT NULL REFERENCES public."user"(id), sql_text text NOT NULL CHECK(length(sql_text) BETWEEN 1 AND 20000), sql_hash text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','failed','cancelled','unknown')), cancel_requested boolean NOT NULL DEFAULT false,
  broker_id uuid, dispatch_id uuid, heartbeat_at timestamptz, backend_pid integer, backend_start timestamptz, stopped boolean NOT NULL DEFAULT false,
  result jsonb, error_code text, idempotency_key uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  UNIQUE(run_id,idempotency_key), FOREIGN KEY(request_id,resource_id) REFERENCES collab.resource_grants(request_id,resource_id),
  FOREIGN KEY(organization_id,project_id,run_id) REFERENCES collab.runs(organization_id,project_id,id),
  FOREIGN KEY(organization_id,project_id,resource_id) REFERENCES collab.resources(organization_id,project_id,id),
  CHECK(sql_hash=encode(sha256(convert_to(sql_text,'UTF8')),'hex'))
);
CREATE UNIQUE INDEX one_resource_job ON collab.resource_jobs(resource_id) WHERE NOT stopped;
CREATE TABLE collab_broker.credentials (
  resource_id uuid PRIMARY KEY REFERENCES collab.resources(id), role_name text NOT NULL UNIQUE, schema_name text NOT NULL UNIQUE, sealed jsonb NOT NULL
);
DO $$ DECLARE n text; BEGIN FOREACH n IN ARRAY ARRAY['resources','resource_requests','resource_grants','resource_jobs'] LOOP
  EXECUTE format('ALTER TABLE collab.%I ENABLE ROW LEVEL SECURITY',n);
  EXECUTE format('CREATE POLICY project_read ON collab.%I FOR SELECT USING(collab.project_role(project_id) IS NOT NULL)',n);
  EXECUTE format('GRANT SELECT ON collab.%I TO pi_collab_app',n);
END LOOP; END $$;
CREATE FUNCTION collab.create_resource(project uuid, name text, request_key uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab.projects; prior collab.resources; resource uuid:=gen_random_uuid();
BEGIN
  p:=collab.require_project_management(project);
  IF request_key IS NULL OR name IS NULL OR length(btrim(name)) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid_resource' USING ERRCODE='P0001'; END IF;
  SELECT * INTO prior FROM collab.resources WHERE project_id=project AND created_by=collab.actor() AND idempotency_key=request_key;
  IF FOUND THEN IF prior.name<>btrim(name) THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF; RETURN jsonb_build_object('resourceId',prior.id,'replayed',true); END IF;
  IF (SELECT count(*) FROM collab.resources WHERE project_id=project)>=16 THEN RAISE EXCEPTION 'resource_limit' USING ERRCODE='P0001'; END IF;
  INSERT INTO collab.resources(id,organization_id,project_id,name,created_by,idempotency_key) VALUES(resource,p.organization_id,project,btrim(name),collab.actor(),request_key);
  INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id) VALUES(p.organization_id,project,collab.actor(),'resource.created',resource::text);
  RETURN jsonb_build_object('resourceId',resource,'replayed',false);
END $$;
CREATE FUNCTION collab_broker.run_active(run uuid, generation bigint) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS(SELECT 1 FROM collab.runs r JOIN collab.workspaces w ON w.id=r.workspace_id WHERE r.id=run AND r.epoch=generation AND w.epoch=generation AND w.lease_owner=r.executor_id AND w.lease_expires_at>clock_timestamp() AND r.status IN ('running','waiting_input') AND collab_worker.authorized(r.id))
$$;
CREATE FUNCTION collab_broker.grant_active(request uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS(SELECT 1 FROM collab.resource_requests q WHERE q.id=request AND q.status='granted' AND q.expires_at>clock_timestamp() AND collab_broker.run_active(q.run_id,q.run_epoch)
    AND NOT EXISTS(SELECT 1 FROM collab.resource_grants g JOIN collab.resources r ON r.id=g.resource_id WHERE g.request_id=q.id AND (r.holder_id IS DISTINCT FROM q.id OR r.epoch<>g.fence OR r.status<>'ready')))
$$;
-- One organization lock serializes batches, without retaining partial resources.
CREATE FUNCTION collab_broker.advance(organization uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE q collab.resource_requests; resource uuid; generation bigint; r collab.runs;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(organization::text,811));
  FOR q IN SELECT * FROM collab.resource_requests WHERE organization_id=organization AND status IN ('waiting','granted','releasing') ORDER BY created_at,id FOR UPDATE LOOP
    IF q.status='waiting' AND (q.wait_until<=clock_timestamp() OR NOT collab_broker.run_active(q.run_id,q.run_epoch)) THEN
      UPDATE collab.resource_requests SET status=CASE WHEN q.wait_until<=clock_timestamp() THEN 'timed_out' ELSE 'cancelled' END,reason='wait_ended' WHERE id=q.id; CONTINUE;
    END IF;
    IF q.status='granted' AND NOT collab_broker.grant_active(q.id) THEN
      UPDATE collab.resource_requests SET status='releasing',reason='lease_or_authority_expired' WHERE id=q.id; q.status:='releasing';
    END IF;
    IF q.status='releasing' THEN
      UPDATE collab.resource_jobs SET status='cancelled',stopped=true,finished_at=now(),error_code='lease_released' WHERE request_id=q.id AND status='queued';
      UPDATE collab.resource_jobs SET cancel_requested=true WHERE request_id=q.id AND NOT stopped;
      IF NOT EXISTS(SELECT 1 FROM collab.resource_jobs WHERE request_id=q.id AND NOT stopped) THEN
        UPDATE collab.resources SET holder_id=NULL WHERE holder_id=q.id;
        UPDATE collab.resource_requests SET status='released',expires_at=NULL WHERE id=q.id;
        PERFORM collab_worker.emit(q.run_id,'resource.released',jsonb_build_object('requestId',q.id));
      END IF;
    END IF;
  END LOOP;
  FOR q IN SELECT * FROM collab.resource_requests WHERE organization_id=organization AND status='waiting' ORDER BY created_at,id FOR UPDATE LOOP
    IF EXISTS(SELECT 1 FROM collab.resources WHERE id=ANY(q.resource_ids) AND (holder_id IS NOT NULL OR status<>'ready')) THEN CONTINUE; END IF;
    IF EXISTS(SELECT 1 FROM collab.resource_requests earlier WHERE earlier.organization_id=organization AND earlier.status='waiting' AND (earlier.created_at,earlier.id)<(q.created_at,q.id) AND earlier.resource_ids&&q.resource_ids) THEN CONTINUE; END IF;
    FOREACH resource IN ARRAY q.resource_ids LOOP
      UPDATE collab.resources SET epoch=epoch+1,holder_id=q.id WHERE id=resource RETURNING epoch INTO generation;
      INSERT INTO collab.resource_grants VALUES(q.organization_id,q.project_id,q.id,resource,generation);
    END LOOP;
    UPDATE collab.resource_requests SET status='granted',expires_at=clock_timestamp()+interval '30 seconds' WHERE id=q.id;
    PERFORM collab_worker.emit(q.run_id,'resource.granted',jsonb_build_object('requestId',q.id));
  END LOOP;
END $$;
CREATE FUNCTION collab_worker.renew_resources(executor uuid, run uuid, generation bigint) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab.runs; organization uuid;
BEGIN
  SELECT organization_id INTO organization FROM collab.runs WHERE id=run;
  IF organization IS NULL THEN RAISE EXCEPTION 'stale_lease' USING ERRCODE='P0001'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(organization::text,811)); r:=collab_worker.assert_lease(executor,run,generation);
  IF collab_broker.run_active(run,generation) THEN UPDATE collab.resource_requests SET expires_at=clock_timestamp()+interval '30 seconds' WHERE run_id=run AND status='granted' AND expires_at>clock_timestamp(); END IF;
  PERFORM collab_broker.advance(organization);
END $$;
CREATE FUNCTION collab_broker.context(run uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('available',true,'kind','postgres','items',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'status',status,'occupied',holder_id IS NOT NULL)) FROM collab.resources WHERE project_id=(SELECT project_id FROM collab.runs WHERE id=run)),'[]'::jsonb),
  'requests',COALESCE((SELECT jsonb_agg(to_jsonb(q)||jsonb_build_object('grants',(SELECT jsonb_agg(jsonb_build_object('resourceId',resource_id,'fence',fence::text)) FROM collab.resource_grants WHERE request_id=q.id))) FROM (SELECT id,status,expires_at,wait_until,reason FROM collab.resource_requests WHERE run_id=run ORDER BY created_at DESC LIMIT 5) q),'[]'::jsonb),
  'jobs',COALESCE((SELECT jsonb_agg(to_jsonb(j)) FROM (SELECT id,resource_id,status,cancel_requested,stopped,result,error_code,sql_hash FROM collab.resource_jobs WHERE run_id=run ORDER BY created_at DESC LIMIT 10) j),'[]'::jsonb))
$$;
CREATE FUNCTION collab_worker.resource_action(executor uuid, run uuid, generation bigint, method text, input jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab.runs; organization uuid; ids uuid[]; q collab.resource_requests; j collab.resource_jobs; resource uuid; fence_value bigint; request_key uuid; result uuid:=gen_random_uuid();
BEGIN
 SELECT organization_id INTO organization FROM collab.runs WHERE id=run; IF organization IS NULL THEN RAISE EXCEPTION 'stale_lease' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(organization::text,811)); r:=collab_worker.assert_lease(executor,run,generation);
 IF generation IS NULL OR NOT collab_broker.run_active(run,generation) THEN RAISE EXCEPTION 'run_not_executable' USING ERRCODE='P0001'; END IF;
 IF input IS NULL OR jsonb_typeof(input)<>'object' OR pg_column_size(input)>65536 THEN RAISE EXCEPTION 'invalid_resource' USING ERRCODE='P0001'; END IF;
 request_key:=(input->>'idempotencyKey')::uuid; IF request_key IS NULL THEN RAISE EXCEPTION 'invalid_resource' USING ERRCODE='P0001'; END IF;
 PERFORM collab_broker.advance(organization);
 IF method='request_resource' THEN
  IF NOT input ?& ARRAY['resourceIds','idempotencyKey'] OR input-ARRAY['resourceIds','idempotencyKey']<>'{}'::jsonb OR jsonb_typeof(input->'resourceIds')<>'array' OR jsonb_array_length(input->'resourceIds') NOT BETWEEN 1 AND 8 THEN RAISE EXCEPTION 'invalid_resource' USING ERRCODE='P0001'; END IF;
  SELECT array_agg(DISTINCT value::uuid ORDER BY value::uuid) INTO ids FROM jsonb_array_elements_text(input->'resourceIds');
  IF EXISTS(SELECT 1 FROM unnest(ids) i WHERE i IS NULL OR NOT EXISTS(SELECT 1 FROM collab.resources WHERE id=i AND project_id=r.project_id AND status<>'disabled')) THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
  SELECT * INTO q FROM collab.resource_requests WHERE run_id=run AND idempotency_key=request_key;
  IF FOUND THEN IF q.resource_ids IS DISTINCT FROM ids THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF; RETURN jsonb_build_object('requestId',q.id,'replayed',true); END IF;
  IF EXISTS(SELECT 1 FROM collab.resource_requests WHERE run_id=run AND status IN ('waiting','granted','releasing')) THEN RAISE EXCEPTION 'resource_request_active' USING ERRCODE='P0001'; END IF;
  INSERT INTO collab.resource_requests(id,organization_id,project_id,run_id,run_epoch,requested_by,resource_ids,idempotency_key) VALUES(result,r.organization_id,r.project_id,run,generation,r.requested_by,ids,request_key);
  PERFORM collab_broker.advance(organization);
  RETURN jsonb_build_object('requestId',result,'replayed',false);
 ELSIF method='execute_resource' THEN
  IF NOT input ?& ARRAY['requestId','resourceId','fence','sql','idempotencyKey'] OR input-ARRAY['requestId','resourceId','fence','sql','idempotencyKey']<>'{}'::jsonb OR jsonb_typeof(input->'sql')<>'string' OR length(input->>'sql') NOT BETWEEN 1 AND 20000 OR jsonb_typeof(input->'fence')<>'string' OR input->>'fence' !~ '^[1-9][0-9]{0,17}$' THEN RAISE EXCEPTION 'invalid_resource' USING ERRCODE='P0001'; END IF;
  SELECT * INTO q FROM collab.resource_requests WHERE id=(input->>'requestId')::uuid AND run_id=run;
  resource:=(input->>'resourceId')::uuid; fence_value:=(input->>'fence')::bigint;
  IF q.id IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
  SELECT * INTO j FROM collab.resource_jobs WHERE run_id=run AND idempotency_key=request_key;
  IF FOUND THEN IF j.request_id<>q.id OR j.resource_id<>resource OR j.fence<>fence_value OR j.sql_text<>input->>'sql' THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF; RETURN jsonb_build_object('jobId',j.id,'replayed',true); END IF;
  IF NOT collab_broker.grant_active(q.id) OR NOT EXISTS(SELECT 1 FROM collab.resource_grants WHERE request_id=q.id AND resource_id=resource AND fence=fence_value) THEN RAISE EXCEPTION 'stale_resource_lease' USING ERRCODE='P0001'; END IF;
  IF EXISTS(SELECT 1 FROM collab.resource_jobs WHERE resource_id=resource AND NOT stopped) THEN RAISE EXCEPTION 'resource_busy' USING ERRCODE='P0001'; END IF;
  IF (SELECT count(*) FROM collab.resource_jobs WHERE run_id=run)>=100 THEN RAISE EXCEPTION 'resource_limit' USING ERRCODE='P0001'; END IF;
  INSERT INTO collab.resource_jobs(id,organization_id,project_id,request_id,resource_id,fence,run_id,requested_by,sql_text,sql_hash,idempotency_key) VALUES(result,r.organization_id,r.project_id,q.id,resource,fence_value,run,r.requested_by,input->>'sql',encode(sha256(convert_to(input->>'sql','UTF8')),'hex'),request_key);
  PERFORM collab_worker.emit(run,'resource.job_queued',jsonb_build_object('jobId',result));
  RETURN jsonb_build_object('jobId',result,'replayed',false);
 ELSIF method='release_resource' THEN
  IF NOT input ?& ARRAY['requestId','idempotencyKey'] OR input-ARRAY['requestId','idempotencyKey']<>'{}'::jsonb THEN RAISE EXCEPTION 'invalid_resource' USING ERRCODE='P0001'; END IF;
  SELECT * INTO q FROM collab.resource_requests WHERE id=(input->>'requestId')::uuid AND run_id=run;
  IF q.id IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
  UPDATE collab.resource_requests SET status=CASE WHEN status='waiting' THEN 'cancelled' ELSE 'releasing' END,reason='explicit_release' WHERE id=q.id AND status IN ('waiting','granted');
  PERFORM collab_broker.advance(organization); RETURN jsonb_build_object('requestId',q.id);
 ELSIF method='cancel_resource_job' THEN
  IF NOT input ?& ARRAY['jobId','idempotencyKey'] OR input-ARRAY['jobId','idempotencyKey']<>'{}'::jsonb THEN RAISE EXCEPTION 'invalid_resource' USING ERRCODE='P0001'; END IF;
  SELECT * INTO j FROM collab.resource_jobs WHERE id=(input->>'jobId')::uuid AND run_id=run;
  IF j.id IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
  UPDATE collab.resource_jobs SET cancel_requested=true,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,stopped=stopped OR status='queued',finished_at=CASE WHEN status='queued' THEN now() ELSE finished_at END WHERE id=j.id;
  RETURN jsonb_build_object('jobId',j.id);
 END IF;
 RAISE EXCEPTION 'invalid_resource' USING ERRCODE='P0001';
END $$;
ALTER FUNCTION collab_worker.coordinate(uuid,uuid,bigint,text,jsonb) RENAME TO coordinate_notes_v1;
REVOKE EXECUTE ON FUNCTION collab_worker.coordinate_notes_v1(uuid,uuid,bigint,text,jsonb) FROM pi_collab_executor;
CREATE FUNCTION collab_worker.coordinate(executor uuid, run uuid, generation bigint, method text, input jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result jsonb; prior collab_worker.coordination_operations; request_key uuid;
BEGIN
 IF method IN ('request_resource','release_resource','execute_resource','cancel_resource_job') THEN
  -- Reuse the existing authority-checked reader before looking up a mutation replay.
  PERFORM collab_worker.coordinate_notes_v1(executor,run,generation,'get_context','{}'::jsonb);
  request_key:=(input->>'idempotencyKey')::uuid;
  SELECT * INTO prior FROM collab_worker.coordination_operations WHERE run_id=run AND idempotency_key=request_key;
  IF FOUND THEN IF prior.method<>method OR prior.payload<>input THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF; RETURN prior.result||jsonb_build_object('replayed',true); END IF;
  IF (SELECT count(*) FROM collab_worker.coordination_operations WHERE run_id=run)>=200 THEN RAISE EXCEPTION 'coordination_limit' USING ERRCODE='P0001'; END IF;
  result:=collab_worker.resource_action(executor,run,generation,method,input);
  INSERT INTO collab_worker.coordination_operations VALUES(run,request_key,method,input,result,now());
  INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) SELECT organization_id,project_id,requested_by,'agent.resource',run::text,jsonb_build_object('method',method,'requestId',request_key,'result',result) FROM collab.runs WHERE id=run;
  RETURN result;
 END IF;
 result:=collab_worker.coordinate_notes_v1(executor,run,generation,method,input);
 IF method='get_context' THEN result:=result||jsonb_build_object('resources',collab_broker.context(run),'supportedTools',(result->'supportedTools')||'["collab_request_resource","collab_release_resource","collab_execute_resource","collab_cancel_resource_job"]'::jsonb); END IF;
 RETURN result;
END $$;
CREATE FUNCTION collab_broker.pending_resources() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'projectId',project_id)),'[]'::jsonb) FROM (SELECT id,project_id FROM collab.resources WHERE status='requested' ORDER BY created_at LIMIT 16) r
$$;
CREATE FUNCTION collab_broker.provision(resource uuid, password text, sealed jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab.resources; role_name text:='pcr_'||replace(resource::text,'-','');
BEGIN
 SELECT * INTO r FROM collab.resources WHERE id=resource; IF r.id IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(r.organization_id::text,811)); SELECT * INTO STRICT r FROM collab.resources WHERE id=resource FOR UPDATE;
 IF r.status='ready' THEN RETURN; END IF;
 IF r.status<>'requested' OR password IS NULL OR password !~ '^[a-f0-9]{64}$' OR sealed IS NULL OR jsonb_typeof(sealed)<>'object' THEN RAISE EXCEPTION 'invalid_resource' USING ERRCODE='P0001'; END IF;
 EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS CONNECTION LIMIT 2',role_name,password);
 EXECUTE format('CREATE SCHEMA %I AUTHORIZATION %I',role_name,role_name);
 EXECUTE format('REVOKE ALL ON SCHEMA %I FROM PUBLIC',role_name);
 INSERT INTO collab_broker.credentials VALUES(resource,role_name,role_name,sealed);
 UPDATE collab.resources SET status='ready' WHERE id=resource;
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id) VALUES(r.organization_id,r.project_id,r.created_by,'resource.ready',resource::text);
 PERFORM collab_broker.advance(r.organization_id);
END $$;
CREATE FUNCTION collab_broker.claim(broker uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j collab.resource_jobs; organization uuid;
BEGIN
 IF broker IS NULL THEN RAISE EXCEPTION 'invalid_resource' USING ERRCODE='P0001'; END IF;
 FOR organization IN SELECT DISTINCT organization_id FROM collab.resource_requests WHERE status IN ('waiting','granted','releasing') ORDER BY organization_id LOOP
  IF pg_try_advisory_xact_lock(hashtextextended(organization::text,811)) THEN PERFORM collab_broker.advance(organization); END IF;
 END LOOP;
 FOR j IN SELECT * FROM collab.resource_jobs WHERE status='queued' ORDER BY created_at,id LOOP
  IF NOT pg_try_advisory_xact_lock(hashtextextended(j.organization_id::text,811)) THEN CONTINUE; END IF;
  SELECT * INTO STRICT j FROM collab.resource_jobs WHERE id=j.id FOR UPDATE;
  IF j.status<>'queued' OR NOT collab_broker.grant_active(j.request_id) THEN CONTINUE; END IF;
  UPDATE collab.resource_jobs SET status='running',broker_id=broker,dispatch_id=gen_random_uuid(),heartbeat_at=clock_timestamp() WHERE id=j.id RETURNING * INTO j;
  RETURN (SELECT jsonb_build_object('id',j.id,'resourceId',j.resource_id,'projectId',j.project_id,'brokerId',broker,'dispatchId',j.dispatch_id,'sql',j.sql_text,'roleName',c.role_name,'schemaName',c.schema_name,'sealed',c.sealed) FROM collab_broker.credentials c WHERE c.resource_id=j.resource_id);
 END LOOP;
 RETURN NULL;
END $$;
CREATE FUNCTION collab_broker.bind_backend(job uuid, broker uuid, dispatch uuid, backend_id integer) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j collab.resource_jobs; started timestamptz;
BEGIN
 SELECT * INTO j FROM collab.resource_jobs WHERE id=job; IF j.id IS NULL THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(j.organization_id::text,811)); SELECT * INTO STRICT j FROM collab.resource_jobs WHERE id=job FOR UPDATE;
 IF j.broker_id IS DISTINCT FROM broker OR j.dispatch_id IS DISTINCT FROM dispatch OR j.status<>'running' OR j.cancel_requested OR j.heartbeat_at<clock_timestamp()-interval '15 seconds' OR j.backend_pid IS NOT NULL OR NOT collab_broker.grant_active(j.request_id) THEN RETURN false; END IF;
 SELECT a.backend_start INTO started FROM pg_stat_activity a JOIN collab_broker.credentials c ON c.role_name=a.usename WHERE a.pid=backend_id AND a.datname=current_database() AND c.resource_id=j.resource_id AND a.application_name='pi-collab-job:'||job::text;
 IF started IS NULL THEN RETURN false; END IF;
 UPDATE collab.resource_jobs SET backend_pid=backend_id,backend_start=started,heartbeat_at=clock_timestamp() WHERE id=job;
 RETURN true;
END $$;
CREATE FUNCTION collab_broker.heartbeat_job(job uuid, broker uuid, dispatch uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j collab.resource_jobs;
BEGIN
 SELECT * INTO j FROM collab.resource_jobs WHERE id=job; IF j.id IS NULL THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(j.organization_id::text,811)); SELECT * INTO STRICT j FROM collab.resource_jobs WHERE id=job FOR UPDATE;
 IF j.broker_id IS DISTINCT FROM broker OR j.dispatch_id IS DISTINCT FROM dispatch OR j.status<>'running' OR j.heartbeat_at<clock_timestamp()-interval '15 seconds' OR j.cancel_requested OR NOT collab_broker.grant_active(j.request_id) THEN RETURN false; END IF;
 UPDATE collab.resource_jobs SET heartbeat_at=clock_timestamp() WHERE id=job; RETURN true;
END $$;
CREATE FUNCTION collab_broker.backend_present(job uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM collab.resource_jobs j JOIN collab_broker.credentials c ON c.resource_id=j.resource_id JOIN pg_stat_activity a ON a.pid=j.backend_pid AND a.backend_start=j.backend_start AND a.usename=c.role_name AND a.datname=current_database() WHERE j.id=job)
$$;
CREATE FUNCTION collab_broker.terminate_job(job uuid, broker uuid, dispatch uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j collab.resource_jobs;
BEGIN
 SELECT * INTO j FROM collab.resource_jobs WHERE id=job; IF j.id IS NULL THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(j.organization_id::text,811)); SELECT * INTO STRICT j FROM collab.resource_jobs WHERE id=job FOR UPDATE;
 IF j.broker_id IS DISTINCT FROM broker OR j.dispatch_id IS DISTINCT FROM dispatch OR j.stopped THEN RETURN false; END IF;
 UPDATE collab.resource_jobs SET cancel_requested=true WHERE id=job;
 IF collab_broker.backend_present(job) THEN PERFORM pg_terminate_backend(j.backend_pid); END IF;
 RETURN true;
END $$;
CREATE FUNCTION collab_broker.finish_job(job uuid, broker uuid, dispatch uuid, outcome text, evidence jsonb, failure_code text) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j collab.resource_jobs; final text;
BEGIN
 SELECT * INTO j FROM collab.resource_jobs WHERE id=job; IF j.id IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(j.organization_id::text,811)); SELECT * INTO STRICT j FROM collab.resource_jobs WHERE id=job FOR UPDATE;
 IF j.broker_id IS DISTINCT FROM broker OR j.dispatch_id IS DISTINCT FROM dispatch THEN RAISE EXCEPTION 'stale_resource_job' USING ERRCODE='P0001'; END IF;
 IF j.stopped THEN RETURN j.status; END IF;
 IF outcome IS NULL OR outcome NOT IN ('succeeded','failed','cancelled','unknown') OR (evidence IS NOT NULL AND pg_column_size(evidence)>131072) OR length(failure_code)>100 THEN RAISE EXCEPTION 'invalid_resource' USING ERRCODE='P0001'; END IF;
 IF outcome='succeeded' AND (j.backend_pid IS NULL OR evidence IS NULL OR jsonb_typeof(evidence)<>'object' OR NOT evidence ?& ARRAY['command','rowCount','rows','sqlHash','commitAcknowledged']
   OR evidence-ARRAY['command','rowCount','rows','sqlHash','commitAcknowledged']<>'{}'::jsonb OR evidence->>'sqlHash' IS DISTINCT FROM j.sql_hash OR evidence->'commitAcknowledged' IS DISTINCT FROM 'true'::jsonb
   OR jsonb_typeof(evidence->'rows')<>'array' OR jsonb_array_length(evidence->'rows')>100 OR jsonb_typeof(evidence->'command')<>'string' OR jsonb_typeof(evidence->'rowCount') NOT IN ('number','null')) THEN RAISE EXCEPTION 'invalid_resource' USING ERRCODE='P0001'; END IF;
 IF collab_broker.backend_present(job) THEN RAISE EXCEPTION 'resource_writer_present' USING ERRCODE='P0001'; END IF;
 final:=CASE WHEN j.status='unknown' OR NOT collab_broker.grant_active(j.request_id) THEN 'unknown' ELSE outcome END;
 UPDATE collab.resource_jobs SET status=final,stopped=true,result=CASE WHEN final='succeeded' THEN evidence END,error_code=failure_code,finished_at=now() WHERE id=job;
 PERFORM collab_worker.emit(j.run_id,'resource.job_finished',jsonb_build_object('jobId',job,'status',final));
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(j.organization_id,j.project_id,j.requested_by,'resource.job_finished',job::text,jsonb_build_object('status',final,'sqlHash',j.sql_hash,'fence',j.fence::text));
 PERFORM collab_broker.advance(j.organization_id); RETURN final;
END $$;
-- Invalidate dispatch before checking a missing backend. A late starter can no longer bind.
CREATE FUNCTION collab_broker.reconcile() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j collab.resource_jobs; count integer:=0;
BEGIN
 FOR j IN SELECT * FROM collab.resource_jobs WHERE NOT stopped AND (status='unknown' OR (status='running' AND heartbeat_at<clock_timestamp()-interval '15 seconds')) ORDER BY id LOOP
  IF NOT pg_try_advisory_xact_lock(hashtextextended(j.organization_id::text,811)) THEN CONTINUE; END IF;
  SELECT * INTO STRICT j FROM collab.resource_jobs WHERE id=j.id FOR UPDATE;
  IF j.stopped OR (j.status='running' AND j.heartbeat_at>=clock_timestamp()-interval '15 seconds') THEN CONTINUE; END IF;
  UPDATE collab.resource_jobs SET status='unknown',cancel_requested=true,dispatch_id=gen_random_uuid(),error_code='broker_outcome_unknown' WHERE id=j.id;
  UPDATE collab.resource_requests SET status='releasing',reason='broker_outcome_unknown' WHERE id=j.request_id AND status='granted';
  IF collab_broker.backend_present(j.id) THEN PERFORM pg_terminate_backend(j.backend_pid);
  ELSE
    UPDATE collab.resource_jobs SET stopped=true,finished_at=now() WHERE id=j.id;
    PERFORM collab_worker.emit(j.run_id,'resource.job_reconciled',jsonb_build_object('jobId',j.id,'status','unknown'));
    PERFORM collab_broker.advance(j.organization_id); count:=count+1;
  END IF;
 END LOOP;
 RETURN count;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA collab_broker FROM PUBLIC;
REVOKE ALL ON FUNCTION collab.create_resource(uuid,text,uuid),collab_worker.renew_resources(uuid,uuid,bigint),collab_worker.resource_action(uuid,uuid,bigint,text,jsonb),collab_worker.coordinate(uuid,uuid,bigint,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.create_resource(uuid,text,uuid) TO pi_collab_app;
GRANT EXECUTE ON FUNCTION collab_worker.renew_resources(uuid,uuid,bigint),collab_worker.coordinate(uuid,uuid,bigint,text,jsonb) TO pi_collab_executor;
GRANT EXECUTE ON FUNCTION collab_broker.pending_resources(),collab_broker.provision(uuid,text,jsonb),collab_broker.claim(uuid),collab_broker.bind_backend(uuid,uuid,uuid,integer),collab_broker.heartbeat_job(uuid,uuid,uuid),collab_broker.terminate_job(uuid,uuid,uuid),collab_broker.finish_job(uuid,uuid,uuid,text,jsonb,text),collab_broker.reconcile() TO pi_collab_broker;
CREATE FUNCTION collab_broker.has_credentials() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT EXISTS(SELECT 1 FROM collab_broker.credentials) $$;
REVOKE ALL ON FUNCTION collab_broker.has_credentials() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab_broker.has_credentials() TO pi_collab_broker;
