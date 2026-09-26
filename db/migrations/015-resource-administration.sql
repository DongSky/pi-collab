ALTER TABLE collab.resources ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version>0);
ALTER TABLE collab.resources ADD COLUMN change_reason text;
CREATE TABLE collab.resource_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, project_id uuid NOT NULL,
  actor_id text NOT NULL REFERENCES public."user"(id), scope_id uuid NOT NULL, idempotency_key uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('enable','disable','release','cancel')), payload jsonb NOT NULL, result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(actor_id,scope_id,idempotency_key),
  FOREIGN KEY(organization_id,project_id) REFERENCES collab.projects(organization_id,id)
);
ALTER TABLE collab.resource_commands ENABLE ROW LEVEL SECURITY;
CREATE POLICY project_read ON collab.resource_commands FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
GRANT SELECT ON collab.resource_commands TO pi_collab_app;

CREATE FUNCTION collab.manage_resource(resource uuid, action text, expected_version integer, reason text, request_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab.resources; prior collab.resource_commands; request jsonb; response jsonb;
BEGIN
 SELECT * INTO r FROM collab.resources WHERE id=resource;
 IF r.id IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM collab.require_project_management(r.project_id);
 SELECT * INTO STRICT r FROM collab.resources WHERE id=resource FOR UPDATE;
 IF action IS NULL OR action NOT IN ('disable','enable') OR request_key IS NULL OR expected_version IS NULL OR expected_version<1 OR reason IS NULL OR length(btrim(reason)) NOT BETWEEN 10 AND 2000 THEN RAISE EXCEPTION 'invalid_resource_action' USING ERRCODE='P0001'; END IF;
 request:=jsonb_build_object('action',action,'expectedVersion',expected_version,'reason',btrim(reason));
 SELECT * INTO prior FROM collab.resource_commands WHERE actor_id=collab.actor() AND scope_id=resource AND idempotency_key=request_key;
 IF FOUND THEN
  IF prior.kind<>action OR prior.payload<>request THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
  RETURN prior.result||jsonb_build_object('replayed',true);
 END IF;
 IF r.version<>expected_version THEN RAISE EXCEPTION 'stale_resource' USING ERRCODE='P0001'; END IF;
 IF (action='disable' AND r.status='disabled') OR (action='enable' AND r.status<>'disabled') THEN RAISE EXCEPTION 'resource_state_changed' USING ERRCODE='P0001'; END IF;
 IF action='disable' THEN
  UPDATE collab.resources SET status='disabled',epoch=epoch+1,version=version+1,change_reason=btrim(reason) WHERE id=resource;
  -- A disabled member cancels the whole waiting batch; no partial grant escapes.
  UPDATE collab.resource_requests SET status='cancelled',reason='resource_disabled' WHERE status='waiting' AND resource=ANY(resource_ids);
  PERFORM collab_broker.advance(r.organization_id);
 ELSE
  -- Re-enabling never clears a lease or overrides a live/unknown writer.
  IF r.holder_id IS NOT NULL OR EXISTS(SELECT 1 FROM collab.resource_jobs WHERE resource_id=resource AND NOT stopped) THEN RAISE EXCEPTION 'resource_not_drained' USING ERRCODE='P0001'; END IF;
  UPDATE collab.resources SET status=CASE WHEN EXISTS(SELECT 1 FROM collab_broker.credentials WHERE resource_id=resource) THEN 'ready' ELSE 'requested' END,version=version+1,change_reason=btrim(reason) WHERE id=resource;
 END IF;
 SELECT jsonb_build_object('resourceId',id,'status',status,'version',version,'replayed',false) INTO response FROM collab.resources WHERE id=resource;
 INSERT INTO collab.resource_commands(organization_id,project_id,actor_id,scope_id,idempotency_key,kind,payload,result) VALUES(r.organization_id,r.project_id,collab.actor(),resource,request_key,action,request,response);
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(r.organization_id,r.project_id,collab.actor(),'resource.'||action,resource::text,request||response);
 RETURN response;
END $$;

CREATE FUNCTION collab.control_resource(target_kind text, target uuid, reason text, request_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE q collab.resource_requests; j collab.resource_jobs; role text; prior collab.resource_commands; request jsonb; response jsonb; action text;
BEGIN
 IF target_kind IS NULL OR target_kind NOT IN ('request','job') OR target IS NULL OR request_key IS NULL OR reason IS NULL OR length(btrim(reason)) NOT BETWEEN 10 AND 2000 THEN RAISE EXCEPTION 'invalid_resource_action' USING ERRCODE='P0001'; END IF;
 IF target_kind='job' THEN
  SELECT * INTO j FROM collab.resource_jobs WHERE id=target;
  SELECT * INTO q FROM collab.resource_requests WHERE id=j.request_id;
  action:='cancel';
 ELSE
  SELECT * INTO q FROM collab.resource_requests WHERE id=target; action:='release';
 END IF;
 IF q.id IS NULL OR collab.project_role(q.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(q.organization_id::text,811));
 role:=collab.project_role(q.project_id);
 IF role IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 IF role NOT IN ('maintainer','developer') OR (role<>'maintainer' AND q.requested_by<>collab.actor()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF collab.user_requires_mfa(collab.actor()) AND NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
 request:=jsonb_build_object('targetKind',target_kind,'reason',btrim(reason));
 SELECT * INTO prior FROM collab.resource_commands WHERE actor_id=collab.actor() AND scope_id=target AND idempotency_key=request_key;
 IF FOUND THEN
  IF prior.kind<>action OR prior.payload<>request THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
  RETURN prior.result||jsonb_build_object('replayed',true);
 END IF;
 IF target_kind='job' THEN
  UPDATE collab.resource_jobs SET cancel_requested=true,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,stopped=stopped OR status='queued',finished_at=CASE WHEN status='queued' THEN now() ELSE finished_at END WHERE id=target AND NOT stopped;
 ELSE
  UPDATE collab.resource_requests SET status=CASE WHEN status='waiting' THEN 'cancelled' ELSE 'releasing' END,reason='human_release' WHERE id=target AND status IN ('waiting','granted');
 END IF;
 PERFORM collab_broker.advance(q.organization_id);
 response:=jsonb_build_object('targetId',target,'action',action,'replayed',false);
 INSERT INTO collab.resource_commands(organization_id,project_id,actor_id,scope_id,idempotency_key,kind,payload,result) VALUES(q.organization_id,q.project_id,collab.actor(),target,request_key,action,request,response);
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(q.organization_id,q.project_id,collab.actor(),'resource.'||action||'_requested',target::text,request);
 PERFORM collab_worker.emit(q.run_id,'resource.control_requested',jsonb_build_object('targetId',target,'action',action));
 RETURN response;
END $$;
REVOKE ALL ON FUNCTION collab.manage_resource(uuid,text,integer,text,uuid),collab.control_resource(text,uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.manage_resource(uuid,text,integer,text,uuid),collab.control_resource(text,uuid,text,uuid) TO pi_collab_app;
