CREATE SCHEMA collab_admin;
REVOKE ALL ON SCHEMA collab_admin FROM PUBLIC;
ALTER TABLE collab.model_profiles ADD COLUMN version integer NOT NULL DEFAULT 1;
CREATE TABLE collab_admin.model_operations (
 profile_id uuid NOT NULL REFERENCES collab.model_profiles(id), actor_id text NOT NULL, request_key uuid NOT NULL,payload jsonb NOT NULL,result jsonb NOT NULL,
 PRIMARY KEY(profile_id,actor_id,request_key)
);
CREATE FUNCTION collab.admin_overview(org uuid, search text, before_id bigint) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF coalesce(collab.org_role(org),'') NOT IN ('owner','admin') THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 IF NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
 IF search IS NULL OR length(search)>100 THEN RAISE EXCEPTION 'invalid_admin_query' USING ERRCODE='P0001'; END IF;
 RETURN jsonb_build_object('events',(SELECT coalesce(jsonb_agg(x),'[]'::jsonb) FROM (SELECT e.id::text,e.action,e.resource_id,e.project_id,p.name AS project_name,u.name AS actor_name,e.created_at,CASE WHEN e.project_id IS NULL OR collab.project_role(e.project_id) IS NOT NULL THEN e.detail ELSE NULL END AS detail FROM collab.audit_events e LEFT JOIN collab.projects p ON p.id=e.project_id LEFT JOIN public."user" u ON u.id=e.actor_id WHERE e.organization_id=org AND (before_id IS NULL OR e.id<before_id) AND (search='' OR strpos(lower(e.action||' '||coalesce(u.name,'')||' '||coalesce(p.name,'')||' '||e.resource_id),lower(search))>0) ORDER BY e.id DESC LIMIT 50) x),
 'models',(SELECT coalesce(jsonb_agg(x),'[]'::jsonb) FROM (SELECT m.id,m.name,m.model_id,m.project_id,p.name AS project_name,m.version,m.enabled,m.context_window,m.max_output_tokens,m.run_token_limit,m.run_request_limit,EXISTS(SELECT 1 FROM collab_gateway.credentials WHERE profile_id=m.id) AS credential_present,collab.project_role(m.project_id)='maintainer' AS can_manage FROM collab.model_profiles m JOIN collab.projects p ON p.id=m.project_id WHERE m.organization_id=org ORDER BY p.name,m.name) x),
 'runs',(SELECT coalesce(jsonb_agg(x),'[]'::jsonb) FROM (SELECT r.id,r.project_id,r.revision::text,r.status,t.title,w.status AS workspace_status,a.status AS recovery_status,a.result_code FROM collab.runs r JOIN collab.tasks t ON t.id=r.task_id JOIN collab.workspaces w ON w.id=r.workspace_id LEFT JOIN LATERAL (SELECT status,result_code FROM collab.run_actions WHERE run_id=r.id ORDER BY created_at DESC LIMIT 1) a ON true WHERE r.organization_id=org AND r.status='reconciling' AND collab.project_role(r.project_id)='maintainer' ORDER BY r.created_at LIMIT 100) x));
END $$;
CREATE FUNCTION collab.manage_model(profile uuid, body jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE m collab.model_profiles; prior collab_admin.model_operations; response jsonb;
BEGIN
 SELECT * INTO m FROM collab.model_profiles WHERE id=profile;
 IF m.id IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM collab.require_project_management(m.project_id);
 IF NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
 SELECT * INTO STRICT m FROM collab.model_profiles WHERE id=profile FOR UPDATE;
 SELECT * INTO prior FROM collab_admin.model_operations WHERE profile_id=profile AND actor_id=collab.actor() AND request_key=(body->>'idempotencyKey')::uuid;
 IF FOUND THEN IF prior.payload<>body THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;RETURN prior.result; END IF;
 IF m.version IS DISTINCT FROM (body->>'expectedVersion')::integer THEN RAISE EXCEPTION 'stale_revision' USING ERRCODE='P0001'; END IF;
 IF body->>'action' IS NULL OR body->>'action' NOT IN ('enable','disable','remove_credential') OR length(btrim(body->>'reason')) NOT BETWEEN 10 AND 2000 THEN RAISE EXCEPTION 'invalid_model_action' USING ERRCODE='P0001'; END IF;
 IF body->>'action'='enable' AND NOT EXISTS(SELECT 1 FROM collab_gateway.credentials WHERE profile_id=profile) THEN RAISE EXCEPTION 'model_credential_missing' USING ERRCODE='P0001'; END IF;
 IF body->>'action'='remove_credential' THEN DELETE FROM collab_gateway.credentials WHERE profile_id=profile; END IF;
 UPDATE collab.model_profiles SET enabled=body->>'action'='enable',version=version+1 WHERE id=profile RETURNING jsonb_build_object('version',version,'enabled',enabled) INTO response;
 IF body->>'action'<>'enable' THEN UPDATE collab_gateway.capabilities SET revoked=true WHERE run_id IN (SELECT id FROM collab.runs WHERE model_profile_id=profile); END IF;
 INSERT INTO collab_admin.model_operations VALUES(profile,collab.actor(),(body->>'idempotencyKey')::uuid,body,response);
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(m.organization_id,m.project_id,collab.actor(),'model.'||(body->>'action'),profile,body);
 RETURN response;
END $$;
-- An explicit disposition records a human decision without fabricating exit evidence.
CREATE TABLE collab.run_dispositions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,project_id uuid NOT NULL,run_id uuid NOT NULL REFERENCES collab.runs(id),
 actor_id text NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),request_key uuid NOT NULL,UNIQUE(run_id,actor_id,request_key)
);
ALTER TABLE collab.run_dispositions ENABLE ROW LEVEL SECURITY;
CREATE POLICY disposition_read ON collab.run_dispositions FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
GRANT SELECT ON collab.run_dispositions TO pi_collab_app;
CREATE FUNCTION collab.record_run_disposition(run uuid, reason text, expected_revision bigint, request_key uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab.runs; prior collab.run_dispositions;
BEGIN
 SELECT * INTO r FROM collab.runs WHERE id=run;IF r.id IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 PERFORM collab.require_project_management(r.project_id);
 SELECT * INTO STRICT r FROM collab.runs WHERE id=run FOR UPDATE;
 IF reason IS NULL OR length(btrim(reason)) NOT BETWEEN 10 AND 2000 OR request_key IS NULL THEN RAISE EXCEPTION 'invalid_run_action' USING ERRCODE='P0001';END IF;
 SELECT * INTO prior FROM collab.run_dispositions WHERE run_id=run AND actor_id=collab.actor() AND run_dispositions.request_key=record_run_disposition.request_key;
 IF FOUND THEN IF prior.reason<>reason THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001';END IF;RETURN jsonb_build_object('id',prior.id);END IF;
 IF r.revision IS DISTINCT FROM expected_revision THEN RAISE EXCEPTION 'stale_revision' USING ERRCODE='P0001';END IF;
 IF r.status<>'reconciling' THEN RAISE EXCEPTION 'run_not_reconciling' USING ERRCODE='P0001';END IF;
 INSERT INTO collab.run_dispositions(organization_id,project_id,run_id,actor_id,reason,request_key) VALUES(r.organization_id,r.project_id,run,collab.actor(),reason,request_key) RETURNING * INTO prior;
 UPDATE collab_gateway.capabilities SET revoked=true WHERE run_id=run;
 UPDATE collab.resource_requests SET status=CASE WHEN status='waiting' THEN 'cancelled' ELSE 'releasing' END,reason='manual_isolation' WHERE run_id=run AND status IN ('waiting','granted');
 PERFORM collab_broker.advance(r.organization_id);
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(r.organization_id,r.project_id,collab.actor(),'run.isolation_recorded',run,jsonb_build_object('reason',reason,'dispositionId',prior.id));
 RETURN jsonb_build_object('id',prior.id);
END $$;
REVOKE EXECUTE ON FUNCTION collab.admin_overview(uuid,text,bigint),collab.manage_model(uuid,jsonb),collab.record_run_disposition(uuid,text,bigint,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.admin_overview(uuid,text,bigint),collab.manage_model(uuid,jsonb),collab.record_run_disposition(uuid,text,bigint,uuid) TO pi_collab_app;
