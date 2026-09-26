-- A run keeps its original provenance and one Pi writer. Control delegates only
-- subsequent human instructions; it never rewrites requested_by or task ownership.
CREATE TABLE collab.run_controls (
 run_id uuid PRIMARY KEY, organization_id uuid NOT NULL, project_id uuid NOT NULL,
 controller_id text NOT NULL REFERENCES public."user"(id), version bigint NOT NULL DEFAULT 1,
 organization_version bigint NOT NULL, project_version bigint NOT NULL,
 instructions_open boolean NOT NULL DEFAULT true, changed_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,project_id,run_id) REFERENCES collab.runs(organization_id,project_id,id)
);
CREATE TABLE collab.control_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, project_id uuid NOT NULL, run_id uuid NOT NULL,
 requester_id text NOT NULL REFERENCES public."user"(id), control_version bigint NOT NULL,
 organization_version bigint NOT NULL, project_version bigint NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected','withdrawn','expired')),
 note text NOT NULL, idempotency_key uuid NOT NULL, payload jsonb NOT NULL,
 handled_by text REFERENCES public."user"(id), decision_key uuid, decision jsonb, resulting_version bigint,
 created_at timestamptz NOT NULL DEFAULT now(), handled_at timestamptz,
 UNIQUE(run_id,requester_id,idempotency_key),
 FOREIGN KEY(organization_id,project_id,run_id) REFERENCES collab.runs(organization_id,project_id,id)
);
CREATE UNIQUE INDEX control_request_pending ON collab.control_requests(run_id,requester_id) WHERE status='pending';
CREATE TABLE collab.run_instructions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 organization_id uuid NOT NULL, project_id uuid NOT NULL, run_id uuid NOT NULL,
 author_id text NOT NULL REFERENCES public."user"(id), control_version bigint NOT NULL,
 kind text NOT NULL CHECK(kind IN ('steer','follow_up')), message text NOT NULL CHECK(length(message) BETWEEN 1 AND 20000),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','dispatching','delivered','rejected','unknown','cancelled')),
 idempotency_key uuid NOT NULL, payload jsonb NOT NULL, executor_id uuid, epoch bigint,
 created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 UNIQUE(run_id,author_id,idempotency_key),
 FOREIGN KEY(organization_id,project_id,run_id) REFERENCES collab.runs(organization_id,project_id,id)
);
CREATE UNIQUE INDEX run_instruction_inflight ON collab.run_instructions(run_id) WHERE status='dispatching';
CREATE INDEX run_instruction_queue ON collab.run_instructions(run_id,sequence) WHERE status='queued';
ALTER TABLE collab.run_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE collab.control_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE collab.run_instructions ENABLE ROW LEVEL SECURITY;
CREATE POLICY run_controls_read ON collab.run_controls FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
CREATE POLICY control_requests_read ON collab.control_requests FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
CREATE POLICY run_instructions_read ON collab.run_instructions FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
GRANT SELECT ON collab.run_controls,collab.control_requests,collab.run_instructions TO pi_collab_app;

CREATE FUNCTION collab_worker.initialize_run_control() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 INSERT INTO collab.run_controls(run_id,organization_id,project_id,controller_id,organization_version,project_version)
 VALUES(NEW.id,NEW.organization_id,NEW.project_id,NEW.requested_by,NEW.authorization_version,NEW.project_authorization_version);
 RETURN NEW;
END $$;
CREATE TRIGGER initialize_run_control AFTER INSERT ON collab.runs FOR EACH ROW EXECUTE FUNCTION collab_worker.initialize_run_control();
INSERT INTO collab.run_controls(run_id,organization_id,project_id,controller_id,organization_version,project_version,instructions_open)
 SELECT id,organization_id,project_id,requested_by,authorization_version,project_authorization_version,status IN ('queued','starting','running','waiting_input') FROM collab.runs;
CREATE FUNCTION collab_worker.control_member_valid(project uuid, person text, organization_version bigint, project_version bigint) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM collab.project_memberships pm JOIN collab.memberships m ON m.organization_id=pm.organization_id AND m.user_id=pm.user_id
 JOIN public."user" u ON u.id=pm.user_id WHERE pm.project_id=project AND pm.user_id=person AND pm.active AND m.active
 AND pm.role IN ('developer','maintainer') AND pm.authorization_version=project_version AND m.authorization_version=organization_version
 AND (m.role='member' OR u."twoFactorEnabled"))
$$;
CREATE OR REPLACE FUNCTION collab_worker.authorized(run uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT collab_worker.authorized_v17(run) AND (collab_worker.resolution_input(run) IS NULL OR collab_worker.dependencies_current(run))
 AND EXISTS(SELECT 1 FROM collab.run_controls c WHERE c.run_id=run AND collab_worker.control_member_valid(c.project_id,c.controller_id,c.organization_version,c.project_version))
$$;
CREATE FUNCTION collab.control_state(run uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('controllerId',c.controller_id,'controllerName',u.name,'version',c.version::text,'instructionsOpen',c.instructions_open,
 'valid',collab_worker.control_member_valid(c.project_id,c.controller_id,c.organization_version,c.project_version))
 FROM collab.run_controls c JOIN public."user" u ON u.id=c.controller_id WHERE c.run_id=run AND collab.project_role(c.project_id) IS NOT NULL
$$;
CREATE FUNCTION collab_worker.close_control_on_stop() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.status IN ('stopping','completed','failed','cancelled','reconciling') THEN
  UPDATE collab.run_controls SET instructions_open=false WHERE run_id=NEW.id;
  UPDATE collab.control_requests SET status='expired',handled_at=now() WHERE run_id=NEW.id AND status='pending';
  UPDATE collab.run_instructions SET status=CASE WHEN status='dispatching' THEN 'unknown' ELSE 'cancelled' END,finished_at=now() WHERE run_id=NEW.id AND status IN ('queued','dispatching');
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER close_control_on_stop AFTER UPDATE OF status ON collab.runs FOR EACH ROW EXECUTE FUNCTION collab_worker.close_control_on_stop();

CREATE FUNCTION collab.request_run_control(run uuid, expected_version bigint, request_key uuid, note text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab.runs; c collab.run_controls; prior collab.control_requests; request jsonb; result uuid:=gen_random_uuid(); ov bigint; pv bigint;
BEGIN
 SELECT * INTO r FROM collab.runs WHERE id=run;
 IF r.id IS NULL OR collab.project_role(r.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(r.organization_id::text,811)); SELECT * INTO STRICT r FROM collab.runs WHERE id=run FOR UPDATE;
 IF collab.project_role(r.project_id) IS NULL OR collab.project_role(r.project_id) NOT IN ('developer','maintainer') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF collab.user_requires_mfa(collab.actor()) AND NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
 IF expected_version IS NULL OR expected_version<1 OR request_key IS NULL OR note IS NULL OR length(btrim(note)) NOT BETWEEN 10 AND 2000 THEN RAISE EXCEPTION 'invalid_control_request' USING ERRCODE='P0001'; END IF;
 request:=jsonb_build_object('expectedVersion',expected_version,'note',btrim(note));
 SELECT * INTO prior FROM collab.control_requests WHERE run_id=run AND requester_id=collab.actor() AND idempotency_key=request_key;
 IF FOUND THEN
  IF prior.payload<>request THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
  RETURN jsonb_build_object('requestId',prior.id,'status',prior.status,'replayed',true);
 END IF;
 SELECT * INTO STRICT c FROM collab.run_controls WHERE run_id=run;
 IF c.version<>expected_version THEN RAISE EXCEPTION 'stale_control' USING ERRCODE='P0001'; END IF;
 IF c.controller_id=collab.actor() THEN RAISE EXCEPTION 'already_controller' USING ERRCODE='P0001'; END IF;
 IF r.status NOT IN ('queued','starting','running','waiting_input') OR NOT c.instructions_open THEN RAISE EXCEPTION 'control_closed' USING ERRCODE='P0001'; END IF;
 IF EXISTS(SELECT 1 FROM collab.control_requests WHERE run_id=run AND requester_id=collab.actor() AND status='pending') THEN RAISE EXCEPTION 'control_request_pending' USING ERRCODE='P0001'; END IF;
 IF (SELECT count(*) FROM collab.control_requests WHERE run_id=run AND status='pending')>=20 THEN RAISE EXCEPTION 'control_queue_full' USING ERRCODE='P0001'; END IF;
 SELECT m.authorization_version,pm.authorization_version INTO ov,pv FROM collab.project_memberships pm JOIN collab.memberships m ON m.organization_id=pm.organization_id AND m.user_id=pm.user_id WHERE pm.project_id=r.project_id AND pm.user_id=collab.actor();
 INSERT INTO collab.control_requests(id,organization_id,project_id,run_id,requester_id,control_version,organization_version,project_version,note,idempotency_key,payload)
 VALUES(result,r.organization_id,r.project_id,run,collab.actor(),c.version,ov,pv,btrim(note),request_key,request);
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(r.organization_id,r.project_id,collab.actor(),'control.requested',run::text,jsonb_build_object('requestId',result));
 PERFORM collab_worker.emit(run,'control.requested',jsonb_build_object('requestId',result));
 RETURN jsonb_build_object('requestId',result,'status','pending','replayed',false);
END $$;

CREATE FUNCTION collab.decide_run_control(request_id uuid, expected_version bigint, request_key uuid, action text, note text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE q collab.control_requests; r collab.runs; c collab.run_controls; response_payload jsonb; result_status text; role text;
BEGIN
 SELECT * INTO q FROM collab.control_requests WHERE id=request_id;
 IF q.id IS NULL OR collab.project_role(q.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(q.organization_id::text,811)); SELECT * INTO STRICT r FROM collab.runs WHERE id=q.run_id FOR UPDATE;
 SELECT * INTO STRICT q FROM collab.control_requests WHERE id=request_id FOR UPDATE; SELECT * INTO STRICT c FROM collab.run_controls WHERE run_id=q.run_id FOR UPDATE;
 role:=collab.project_role(q.project_id);
 IF role IS NULL OR role NOT IN ('developer','maintainer') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF collab.user_requires_mfa(collab.actor()) AND NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
 IF action IS NULL OR action NOT IN ('accept','reject','withdraw') OR expected_version IS NULL OR request_key IS NULL OR note IS NULL OR length(btrim(note)) NOT BETWEEN 10 AND 2000 THEN RAISE EXCEPTION 'invalid_control_request' USING ERRCODE='P0001'; END IF;
 response_payload:=jsonb_build_object('expectedVersion',expected_version,'action',action,'note',btrim(note));
 IF q.handled_by=collab.actor() AND q.decision_key=request_key THEN
  IF q.decision<>response_payload THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
  RETURN jsonb_build_object('requestId',q.id,'status',q.status,'controlVersion',q.resulting_version::text,'replayed',true);
 END IF;
 IF action='withdraw' THEN
  IF q.requester_id<>collab.actor() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 ELSIF c.controller_id<>collab.actor() AND role<>'maintainer' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF q.status<>'pending' OR c.version<>expected_version OR c.version<>q.control_version THEN RAISE EXCEPTION 'stale_control' USING ERRCODE='P0001'; END IF;
 IF action='accept' THEN
  IF r.status NOT IN ('queued','starting','running','waiting_input') OR NOT c.instructions_open THEN RAISE EXCEPTION 'control_closed' USING ERRCODE='P0001'; END IF;
  IF NOT collab_worker.control_member_valid(q.project_id,q.requester_id,q.organization_version,q.project_version) THEN RAISE EXCEPTION 'control_request_revoked' USING ERRCODE='P0001'; END IF;
  IF EXISTS(SELECT 1 FROM collab.run_instructions WHERE run_id=r.id AND status IN ('dispatching','unknown')) THEN RAISE EXCEPTION 'control_delivery_pending' USING ERRCODE='P0001'; END IF;
  UPDATE collab.run_controls SET controller_id=q.requester_id,version=version+1,organization_version=q.organization_version,project_version=q.project_version,changed_at=now() WHERE run_id=r.id RETURNING * INTO c;
  UPDATE collab.run_instructions SET status='cancelled',finished_at=now() WHERE run_id=r.id AND status='queued';
  UPDATE collab.control_requests SET status='expired',handled_at=now() WHERE run_id=r.id AND status='pending' AND id<>q.id;
 END IF;
 result_status:=CASE action WHEN 'accept' THEN 'accepted' WHEN 'reject' THEN 'rejected' ELSE 'withdrawn' END;
 UPDATE collab.control_requests SET status=result_status,handled_by=collab.actor(),decision_key=request_key,decision=response_payload,resulting_version=c.version,handled_at=now() WHERE id=q.id;
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(q.organization_id,q.project_id,collab.actor(),'control.'||result_status,r.id::text,jsonb_build_object('requestId',q.id,'controllerId',c.controller_id,'version',c.version,'note',btrim(note)));
 PERFORM collab_worker.emit(r.id,'control.'||result_status,jsonb_build_object('requestId',q.id,'controllerId',c.controller_id,'version',c.version::text));
 RETURN jsonb_build_object('requestId',q.id,'status',result_status,'controlVersion',c.version::text,'replayed',false);
END $$;

CREATE FUNCTION collab.submit_run_instruction(run uuid, expected_version bigint, request_key uuid, instruction_kind text, message text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab.runs; c collab.run_controls; prior collab.run_instructions; request jsonb; result uuid:=gen_random_uuid();
BEGIN
 SELECT * INTO r FROM collab.runs WHERE id=run;
 IF r.id IS NULL OR collab.project_role(r.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(r.organization_id::text,811)); SELECT * INTO STRICT r FROM collab.runs WHERE id=run FOR UPDATE;
 SELECT * INTO STRICT c FROM collab.run_controls WHERE run_id=run;
 IF c.controller_id<>collab.actor() OR NOT collab_worker.control_member_valid(c.project_id,c.controller_id,c.organization_version,c.project_version) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF expected_version IS NULL OR request_key IS NULL OR instruction_kind IS NULL OR instruction_kind NOT IN ('steer','follow_up') OR message IS NULL OR length(btrim(message)) NOT BETWEEN 1 AND 20000 THEN RAISE EXCEPTION 'invalid_run_instruction' USING ERRCODE='P0001'; END IF;
 request:=jsonb_build_object('expectedVersion',expected_version,'kind',instruction_kind,'message',btrim(message));
 SELECT * INTO prior FROM collab.run_instructions WHERE run_id=run AND author_id=collab.actor() AND idempotency_key=request_key;
 IF FOUND THEN
  IF prior.payload<>request THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
  RETURN jsonb_build_object('instructionId',prior.id,'status',prior.status,'replayed',true);
 END IF;
 IF c.version<>expected_version THEN RAISE EXCEPTION 'stale_control' USING ERRCODE='P0001'; END IF;
 IF r.status NOT IN ('running','waiting_input') OR NOT c.instructions_open OR NOT collab_worker.authorized(run) THEN RAISE EXCEPTION 'control_closed' USING ERRCODE='P0001'; END IF;
 IF (SELECT count(*) FROM collab.run_instructions WHERE run_id=run AND status IN ('queued','dispatching'))>=20 THEN RAISE EXCEPTION 'control_queue_full' USING ERRCODE='P0001'; END IF;
 INSERT INTO collab.run_instructions(id,organization_id,project_id,run_id,author_id,control_version,kind,message,idempotency_key,payload)
 VALUES(result,r.organization_id,r.project_id,run,collab.actor(),c.version,instruction_kind,btrim(message),request_key,request);
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(r.organization_id,r.project_id,collab.actor(),'instruction.submitted',run::text,jsonb_build_object('instructionId',result,'kind',instruction_kind,'controlVersion',c.version));
 PERFORM collab_worker.emit(run,'instruction.queued',jsonb_build_object('instructionId',result));
 RETURN jsonb_build_object('instructionId',result,'status','queued','replayed',false);
END $$;

-- Stop remains available to maintainers for emergency intervention. Once a run
-- has transferred control, every browser must supply the version it observed.
CREATE FUNCTION collab.stop_run(run uuid, request_key uuid, control_version bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab.runs; c collab.run_controls; role text; prior collab.commands; command uuid:=gen_random_uuid(); request jsonb; command_status text;
BEGIN
 SELECT * INTO r FROM collab.runs WHERE id=run;
 IF r.id IS NULL OR collab.project_role(r.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(r.organization_id::text,811)); SELECT * INTO STRICT r FROM collab.runs WHERE id=run FOR UPDATE;
 SELECT * INTO STRICT c FROM collab.run_controls WHERE run_id=run; role:=collab.project_role(r.project_id);
 IF role IS NULL OR role NOT IN ('developer','maintainer') OR (role<>'maintainer' AND (c.controller_id<>collab.actor() OR NOT collab_worker.control_member_valid(c.project_id,c.controller_id,c.organization_version,c.project_version))) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF request_key IS NULL THEN RAISE EXCEPTION 'invalid_run_instruction' USING ERRCODE='P0001'; END IF;
 request:=CASE WHEN control_version IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('controlVersion',control_version) END;
 SELECT * INTO prior FROM collab.commands WHERE requested_by=collab.actor() AND scope_id=run AND idempotency_key=request_key;
 IF FOUND THEN
  IF prior.kind<>'stop' OR prior.payload<>request THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
  RETURN jsonb_build_object('commandId',prior.id,'runId',run,'status',prior.status,'replayed',true);
 END IF;
 IF (control_version IS NULL AND c.version<>1) OR (control_version IS NOT NULL AND c.version<>control_version) THEN RAISE EXCEPTION 'stale_control' USING ERRCODE='P0001'; END IF;
 command_status:=CASE WHEN r.status IN ('completed','failed','cancelled') THEN 'succeeded' WHEN r.status='reconciling' THEN 'unknown' ELSE 'accepted' END;
 INSERT INTO collab.commands(id,organization_id,project_id,run_id,requested_by,scope_id,idempotency_key,kind,payload,status) VALUES(command,r.organization_id,r.project_id,run,collab.actor(),run,request_key,'stop',request,command_status);
 PERFORM collab_worker.request_stop(run,'user_requested');
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id) VALUES(r.organization_id,r.project_id,collab.actor(),'run.stop_requested',run::text);
 RETURN jsonb_build_object('commandId',command,'runId',run,'status',(SELECT status FROM collab.commands WHERE id=command),'replayed',false);
END $$;
CREATE OR REPLACE FUNCTION collab.stop_run(run uuid, request_key uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT collab.stop_run(run,request_key,NULL) $$;

CREATE FUNCTION collab_worker.claim_run_instruction(executor uuid, run uuid, generation bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab.runs; c collab.run_controls; i collab.run_instructions;
BEGIN
 r:=collab_worker.assert_lease(executor,run,generation);
 SELECT * INTO STRICT c FROM collab.run_controls WHERE run_id=run;
 IF r.status NOT IN ('running','waiting_input') OR NOT c.instructions_open OR NOT collab_worker.authorized(run) THEN RETURN NULL; END IF;
 IF EXISTS(SELECT 1 FROM collab.run_instructions WHERE run_id=run AND status IN ('dispatching','unknown')) THEN RETURN NULL; END IF;
 UPDATE collab.run_instructions SET status='cancelled',finished_at=now() WHERE run_id=run AND status='queued' AND (control_version<>c.version OR author_id<>c.controller_id);
 SELECT * INTO i FROM collab.run_instructions WHERE run_id=run AND status='queued' ORDER BY sequence LIMIT 1 FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 UPDATE collab.run_instructions SET status='dispatching',executor_id=executor,epoch=generation WHERE id=i.id;
 RETURN jsonb_build_object('id',i.id,'kind',i.kind,'message',i.message,'authorId',i.author_id,'authorName',(SELECT name FROM public."user" WHERE id=i.author_id),'controlVersion',i.control_version::text);
END $$;
CREATE FUNCTION collab_worker.finish_run_instruction(executor uuid, run uuid, generation bigint, instruction uuid, outcome text) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab.runs; i collab.run_instructions;
BEGIN
 r:=collab_worker.assert_lease(executor,run,generation);
 IF outcome IS NULL OR outcome NOT IN ('delivered','rejected','unknown') THEN RAISE EXCEPTION 'invalid_run_instruction' USING ERRCODE='P0001'; END IF;
 SELECT * INTO i FROM collab.run_instructions WHERE id=instruction AND run_id=run AND executor_id=executor AND epoch=generation FOR UPDATE;
 IF i.id IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 IF i.status<>'dispatching' THEN RETURN i.status; END IF;
 UPDATE collab.run_instructions SET status=outcome,finished_at=now() WHERE id=instruction;
 PERFORM collab_worker.emit(run,'instruction.'||outcome,jsonb_build_object('instructionId',instruction));
 RETURN outcome;
END $$;
CREATE FUNCTION collab_worker.close_instruction_channel(executor uuid, run uuid, generation bigint) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM collab_worker.assert_lease(executor,run,generation);
 UPDATE collab.run_controls SET instructions_open=false WHERE run_id=run;
 UPDATE collab.run_instructions SET status='cancelled',finished_at=now() WHERE run_id=run AND status='queued';
 UPDATE collab.control_requests SET status='expired',handled_at=now() WHERE run_id=run AND status='pending';
END $$;
REVOKE ALL ON FUNCTION collab_worker.initialize_run_control(),collab_worker.control_member_valid(uuid,text,bigint,bigint),collab_worker.close_control_on_stop(),collab_worker.claim_run_instruction(uuid,uuid,bigint),collab_worker.finish_run_instruction(uuid,uuid,bigint,uuid,text),collab_worker.close_instruction_channel(uuid,uuid,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION collab.control_state(uuid),collab.request_run_control(uuid,bigint,uuid,text),collab.decide_run_control(uuid,bigint,uuid,text,text),collab.submit_run_instruction(uuid,bigint,uuid,text,text),collab.stop_run(uuid,uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.control_state(uuid),collab.request_run_control(uuid,bigint,uuid,text),collab.decide_run_control(uuid,bigint,uuid,text,text),collab.submit_run_instruction(uuid,bigint,uuid,text,text),collab.stop_run(uuid,uuid,bigint) TO pi_collab_app;
GRANT EXECUTE ON FUNCTION collab_worker.claim_run_instruction(uuid,uuid,bigint),collab_worker.finish_run_instruction(uuid,uuid,bigint,uuid,text),collab_worker.close_instruction_channel(uuid,uuid,bigint) TO pi_collab_executor;
