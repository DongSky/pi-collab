CREATE TABLE collab.service_previews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,project_id uuid NOT NULL REFERENCES collab.projects(id),task_id uuid NOT NULL REFERENCES collab.tasks(id),
 validation_id uuid NOT NULL REFERENCES collab.validations(id),snapshot_id uuid NOT NULL REFERENCES collab.snapshots(id),snapshot_hash text NOT NULL,repository_id uuid NOT NULL REFERENCES collab.repositories(id),
 author_id text NOT NULL REFERENCES public."user"(id),org_version bigint NOT NULL,project_version bigint NOT NULL,
 title text NOT NULL,config jsonb NOT NULL,runtime text NOT NULL CHECK(runtime IN ('native','docker')),request_key uuid NOT NULL,payload jsonb NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','starting','ready','stopping','stopped','failed','unknown')),
 executor_id uuid,lease_until timestamptz,port integer CHECK(port BETWEEN 61000 AND 61999),
 expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),started_at timestamptz,finished_at timestamptz,
 cleanup_confirmed boolean NOT NULL DEFAULT false,cleaned_at timestamptz,failure text,evidence jsonb,output_tail text NOT NULL DEFAULT '',
 UNIQUE(project_id,author_id,request_key)
);
CREATE UNIQUE INDEX service_preview_port ON collab.service_previews(port) WHERE port IS NOT NULL AND NOT cleanup_confirmed;
CREATE TABLE collab_gateway.service_tokens (
 digest text PRIMARY KEY,preview_id uuid NOT NULL REFERENCES collab.service_previews(id),user_id text NOT NULL REFERENCES public."user"(id),
 org_version bigint NOT NULL,project_version bigint NOT NULL,expires_at timestamptz NOT NULL DEFAULT now()+interval '5 minutes'
);
CREATE TABLE collab_gateway.service_http (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),preview_id uuid NOT NULL REFERENCES collab.service_previews(id),digest text NOT NULL,
 method text NOT NULL,path text NOT NULL,content_type text NOT NULL,body text,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','done')),response jsonb,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE collab.service_request_log (
 id bigserial PRIMARY KEY,preview_id uuid NOT NULL REFERENCES collab.service_previews(id),method text NOT NULL,path text NOT NULL,code integer NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE collab.service_previews ENABLE ROW LEVEL SECURITY;ALTER TABLE collab.service_request_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_read ON collab.service_previews FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
CREATE POLICY service_log_read ON collab.service_request_log FOR SELECT USING(EXISTS(SELECT 1 FROM collab.service_previews WHERE id=preview_id));
GRANT SELECT ON collab.service_previews,collab.service_request_log TO pi_collab_app;
CREATE TRIGGER operations_admission BEFORE INSERT ON collab.service_previews FOR EACH ROW EXECUTE FUNCTION collab_meta.guard_admission();
CREATE FUNCTION collab.create_service_preview(task uuid,input jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v collab.validations;s collab.snapshots;w collab.workspaces;prior collab.service_previews;p uuid;c jsonb:=input->'config';
BEGIN
 SELECT * INTO v FROM collab.validations WHERE id=(input->>'validationId')::uuid AND task_id=task;
 IF v.id IS NULL OR coalesce(collab.project_role(v.project_id),'') NOT IN ('maintainer','developer') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(v.organization_id::text,811));
 IF collab.user_requires_mfa(collab.actor()) AND NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001';END IF;
 SELECT * INTO prior FROM collab.service_previews WHERE project_id=v.project_id AND author_id=collab.actor() AND request_key=(input->>'idempotencyKey')::uuid;
 IF FOUND THEN IF prior.payload IS DISTINCT FROM input THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001';END IF;RETURN jsonb_build_object('id',prior.id);END IF;
 SELECT * INTO s FROM collab.snapshots WHERE id=v.snapshot_id;SELECT * INTO w FROM collab.workspaces WHERE id=s.workspace_id;
 IF v.status<>'passed' OR s.status<>'ready' OR v.manifest_hash IS DISTINCT FROM s.manifest_hash THEN RAISE EXCEPTION 'preview_source_unavailable' USING ERRCODE='P0001';END IF;
 IF input->'acknowledge' IS DISTINCT FROM 'true'::jsonb OR coalesce(length(input->>'title'),0) NOT BETWEEN 1 AND 120 OR c->>'install' NOT IN ('none','npm-ci') OR c->>'install' IS NULL
 OR coalesce((c->>'seconds')::integer,0) NOT BETWEEN 30 AND 3600 OR coalesce(c->>'healthPath','')!~'^/[^[:cntrl:] ]*$' OR left(c->>'healthPath',2)='//'
 OR NOT collab.valid_validation_config(jsonb_build_object('version',1,'steps',jsonb_build_array((c->'start')||'{"timeoutSeconds":30}'::jsonb)))
 OR (c->'build'<>'null'::jsonb AND NOT collab.valid_validation_config(c->'build')) THEN RAISE EXCEPTION 'invalid_service_preview' USING ERRCODE='P0001';END IF;
 IF (SELECT count(*) FROM collab.service_previews WHERE project_id=v.project_id AND status IN ('queued','starting','ready','stopping','unknown'))>=4 THEN RAISE EXCEPTION 'service_preview_limit' USING ERRCODE='P0001';END IF;
 INSERT INTO collab.service_previews(organization_id,project_id,task_id,validation_id,snapshot_id,snapshot_hash,repository_id,author_id,org_version,project_version,title,config,runtime,request_key,payload,expires_at)
 VALUES(v.organization_id,v.project_id,task,v.id,s.id,s.manifest_hash,w.repository_id,collab.actor(),(SELECT authorization_version FROM collab.memberships WHERE organization_id=v.organization_id AND user_id=collab.actor()),(SELECT authorization_version FROM collab.project_memberships WHERE project_id=v.project_id AND user_id=collab.actor()),input->>'title',c,w.runtime,(input->>'idempotencyKey')::uuid,input,clock_timestamp()+make_interval(secs=>(c->>'seconds')::integer)) RETURNING id INTO p;
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(v.organization_id,v.project_id,collab.actor(),'service_preview.requested',p::text,jsonb_build_object('snapshotId',s.id,'validationId',v.id,'config',c));
 RETURN jsonb_build_object('id',p);
END $$;
CREATE FUNCTION collab_worker.service_authorized(preview uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM collab.service_previews p JOIN collab.memberships m ON m.organization_id=p.organization_id AND m.user_id=p.author_id AND m.active AND m.authorization_version=p.org_version
 JOIN collab.project_memberships pm ON pm.project_id=p.project_id AND pm.user_id=p.author_id AND pm.active AND pm.role IN ('developer','maintainer') AND pm.authorization_version=p.project_version
 JOIN collab.snapshots s ON s.id=p.snapshot_id AND s.status='ready' AND s.manifest_hash=p.snapshot_hash JOIN collab.validations v ON v.id=p.validation_id AND v.status='passed'
 JOIN public."user" u ON u.id=p.author_id WHERE p.id=preview AND p.expires_at>clock_timestamp() AND (NOT collab.user_requires_mfa(u.id) OR u."twoFactorEnabled"))
$$;
CREATE FUNCTION collab_worker.claim_service(executor uuid,mode text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab.service_previews;selected_port integer;
BEGIN
 PERFORM pg_advisory_xact_lock(82467160);
 SELECT * INTO p FROM collab.service_previews WHERE status='queued' AND runtime=mode ORDER BY created_at LIMIT 1 FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL;END IF;
 IF NOT collab_worker.service_authorized(p.id) THEN
  UPDATE collab.service_previews SET status='failed',failure='service_admission_expired',cleanup_confirmed=true,cleaned_at=now(),finished_at=now() WHERE id=p.id;
  UPDATE collab_worker.artifacts SET state='deleted',bytes=0 WHERE kind='service' AND id=p.id;RETURN NULL;
 END IF;
 SELECT n INTO selected_port FROM generate_series(61000,61999) n WHERE NOT EXISTS(SELECT 1 FROM collab.service_previews WHERE port=n AND NOT cleanup_confirmed) ORDER BY n LIMIT 1;
 IF selected_port IS NULL THEN RETURN NULL;END IF;
 UPDATE collab.service_previews SET status='starting',executor_id=executor,lease_until=clock_timestamp()+interval '15 seconds',port=selected_port,started_at=clock_timestamp() WHERE id=p.id;
 RETURN jsonb_build_object('id',p.id,'executorId',executor,'runtime',mode,'snapshotId',p.snapshot_id,'manifestHash',p.snapshot_hash,'repositoryId',p.repository_id,'port',selected_port,'config',p.config);
END $$;
CREATE FUNCTION collab_worker.heartbeat_service(executor uuid,preview uuid,ready boolean DEFAULT false,info jsonb DEFAULT NULL,tail text DEFAULT NULL) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab.service_previews;
BEGIN
 SELECT * INTO p FROM collab.service_previews WHERE id=preview FOR UPDATE;
 IF p.executor_id IS DISTINCT FROM executor OR p.status NOT IN ('starting','ready') OR p.lease_until<clock_timestamp() OR NOT collab_worker.service_authorized(preview) THEN RETURN false;END IF;
 UPDATE collab.service_previews SET status=CASE WHEN ready THEN 'ready' ELSE status END,lease_until=clock_timestamp()+interval '15 seconds',evidence=coalesce(info,evidence),output_tail=coalesce(right(tail,16000),output_tail) WHERE id=preview;RETURN true;
END $$;
CREATE FUNCTION collab.stop_service(preview uuid,reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab.service_previews;
BEGIN
 SELECT * INTO p FROM collab.service_previews WHERE id=preview FOR UPDATE;
 IF p.id IS NULL OR collab.project_role(p.project_id) IS NULL OR (p.author_id<>collab.actor() AND collab.project_role(p.project_id)<>'maintainer') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001';END IF;
 IF length(btrim(reason)) NOT BETWEEN 10 AND 2000 OR reason IS NULL THEN RAISE EXCEPTION 'invalid_service_preview' USING ERRCODE='P0001';END IF;
 UPDATE collab.service_previews SET status=CASE WHEN status='queued' THEN 'stopped' WHEN status IN ('starting','ready') THEN 'stopping' ELSE status END,cleanup_confirmed=CASE WHEN status='queued' THEN true ELSE cleanup_confirmed END,cleaned_at=CASE WHEN status='queued' THEN now() ELSE cleaned_at END WHERE id=preview;
 UPDATE collab_worker.artifacts SET state='deleted',bytes=0 WHERE kind='service' AND id=preview AND p.status='queued';
 DELETE FROM collab_gateway.service_tokens WHERE preview_id=preview;
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(p.organization_id,p.project_id,collab.actor(),'service_preview.stop_requested',preview::text,jsonb_build_object('reason',reason));
END $$;
CREATE FUNCTION collab_worker.finish_service(executor uuid,preview uuid,outcome text,confirmed boolean,failure text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab.service_previews;
BEGIN
 SELECT * INTO p FROM collab.service_previews WHERE id=preview FOR UPDATE;
 IF p.cleanup_confirmed THEN RETURN;END IF;
 IF p.executor_id IS DISTINCT FROM executor OR outcome NOT IN ('stopped','failed','unknown') THEN RAISE EXCEPTION 'service_lease_lost' USING ERRCODE='P0001';END IF;
 UPDATE collab.service_previews SET status=CASE WHEN confirmed THEN outcome ELSE 'unknown' END,cleanup_confirmed=confirmed,finished_at=clock_timestamp(),lease_until=NULL,failure=finish_service.failure WHERE id=preview;
 DELETE FROM collab_gateway.service_tokens WHERE preview_id=preview;
 UPDATE collab_gateway.service_http SET status='done',body=NULL,response='{"status":503,"body":"","contentType":"text/plain"}' WHERE preview_id=preview AND status<>'done';
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(p.organization_id,p.project_id,p.author_id,'service_preview.finished',preview::text,jsonb_build_object('outcome',outcome,'cleanupConfirmed',confirmed,'failure',failure));
END $$;
CREATE FUNCTION collab_worker.service_recovery(mode text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 DELETE FROM collab_gateway.service_http WHERE created_at<clock_timestamp()-interval '30 seconds';
 DELETE FROM collab_gateway.service_tokens WHERE expires_at<clock_timestamp();
 UPDATE collab.service_previews SET status='unknown',failure='service_lease_expired' WHERE runtime=mode AND status IN ('starting','ready','stopping') AND lease_until<clock_timestamp();
 RETURN coalesce((SELECT jsonb_agg(row) FROM (SELECT id,executor_id AS "executorId",runtime,cleanup_confirmed AS confirmed FROM collab.service_previews WHERE runtime=mode AND (status='unknown' OR cleanup_confirmed AND cleaned_at IS NULL) ORDER BY created_at LIMIT 10) row),'[]');
END $$;
CREATE FUNCTION collab_worker.service_cleaned(preview uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM collab.service_previews WHERE id=preview AND cleanup_confirmed) THEN RAISE EXCEPTION 'service_exit_unconfirmed' USING ERRCODE='P0001';END IF;
 UPDATE collab.service_previews SET cleaned_at=clock_timestamp() WHERE id=preview;
 UPDATE collab_worker.artifacts SET state='deleted',bytes=0,measurement_error=NULL,measured_at=clock_timestamp() WHERE kind='service' AND id=preview;
END $$;
CREATE FUNCTION collab.open_service(preview uuid,digest text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab.service_previews;
BEGIN
 SELECT * INTO p FROM collab.service_previews WHERE id=preview FOR UPDATE;
 IF p.id IS NULL OR collab.project_role(p.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 IF p.status<>'ready' OR p.lease_until<clock_timestamp() OR NOT collab_worker.service_authorized(preview) THEN RAISE EXCEPTION 'preview_unavailable' USING ERRCODE='P0001';END IF;
 IF digest IS NULL OR digest!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'invalid_service_preview' USING ERRCODE='P0001';END IF;
 IF collab.user_requires_mfa(collab.actor()) AND NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001';END IF;
 DELETE FROM collab_gateway.service_tokens WHERE preview_id=preview AND user_id=collab.actor();
 INSERT INTO collab_gateway.service_tokens(digest,preview_id,user_id,org_version,project_version) VALUES(digest,preview,collab.actor(),(SELECT authorization_version FROM collab.memberships WHERE organization_id=p.organization_id AND user_id=collab.actor()),(SELECT authorization_version FROM collab.project_memberships WHERE project_id=p.project_id AND user_id=collab.actor()));
 RETURN jsonb_build_object('expiresAt',least(p.expires_at,clock_timestamp()+interval '5 minutes'));
END $$;
CREATE FUNCTION collab_gateway.service_access(hash text) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT p.id FROM collab_gateway.service_tokens tok JOIN collab.service_previews p ON p.id=tok.preview_id
 JOIN collab.memberships m ON m.organization_id=p.organization_id AND m.user_id=tok.user_id AND m.active AND m.authorization_version=tok.org_version
 JOIN collab.project_memberships pm ON pm.project_id=p.project_id AND pm.user_id=tok.user_id AND pm.active AND pm.authorization_version=tok.project_version
 JOIN public."user" u ON u.id=tok.user_id WHERE tok.digest=hash AND tok.expires_at>clock_timestamp() AND p.status='ready' AND p.lease_until>clock_timestamp()
 AND collab_worker.service_authorized(p.id) AND (NOT collab.user_requires_mfa(u.id) OR u."twoFactorEnabled")
$$;
CREATE FUNCTION collab_gateway.service_enqueue(hash text,method text,target text,content_type text,body text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE preview uuid:=collab_gateway.service_access(hash);job uuid;
BEGIN
 IF preview IS NULL THEN RETURN NULL;END IF;
 IF method NOT IN ('GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS') OR length(target)>4096 OR target!~'^/' OR left(target,2)='//' OR target~'[[:cntrl:] ]' OR coalesce(length(body),0)>1398104 OR length(content_type)>200 THEN RAISE EXCEPTION 'invalid_service_preview' USING ERRCODE='P0001';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(preview::text,816));
 DELETE FROM collab_gateway.service_http WHERE created_at<clock_timestamp()-interval '30 seconds';
 IF (SELECT count(*) FROM collab_gateway.service_http WHERE preview_id=preview)>=16 THEN RAISE EXCEPTION 'service_preview_busy' USING ERRCODE='P0001';END IF;
 INSERT INTO collab_gateway.service_http(preview_id,digest,method,path,content_type,body) VALUES(preview,hash,method,target,content_type,body) RETURNING id INTO job;RETURN job;
END $$;
CREATE FUNCTION collab_gateway.service_response(hash text,job uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE preview uuid:=collab_gateway.service_access(hash);response jsonb;
BEGIN
 IF preview IS NULL THEN RETURN '{"status":404,"body":"","contentType":"text/plain"}';END IF;
 SELECT h.response INTO response FROM collab_gateway.service_http h WHERE h.id=job AND h.preview_id=preview AND h.digest=hash AND h.status='done';
 IF response IS NOT NULL THEN DELETE FROM collab_gateway.service_http WHERE id=job;END IF;
 RETURN response;
END $$;
CREATE FUNCTION collab_worker.service_requests(executor uuid,preview uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM collab.service_previews WHERE id=preview AND executor_id=executor AND status='ready' AND lease_until>clock_timestamp()) THEN RETURN '[]';END IF;
 WITH chosen AS(SELECT id FROM collab_gateway.service_http WHERE preview_id=preview AND status='queued' AND created_at>clock_timestamp()-interval '10 seconds' AND collab_gateway.service_access(digest)=preview ORDER BY created_at LIMIT 4 FOR UPDATE SKIP LOCKED),updated AS(UPDATE collab_gateway.service_http h SET status='running' FROM chosen c WHERE h.id=c.id RETURNING h.id,h.method,h.path,h.content_type AS "contentType",h.body) SELECT coalesce(jsonb_agg(updated),'[]') INTO result FROM updated;
 RETURN result;
END $$;
CREATE FUNCTION collab_worker.service_respond(executor uuid,preview uuid,job uuid,result jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab.service_previews;r collab_gateway.service_http;
BEGIN
 SELECT * INTO p FROM collab.service_previews WHERE id=preview FOR UPDATE;
 IF p.executor_id IS DISTINCT FROM executor OR p.status<>'ready' OR p.lease_until<clock_timestamp() THEN RETURN;END IF;
 IF octet_length(result::text)>3000000 OR (result->>'status')::integer NOT BETWEEN 200 AND 599 THEN RAISE EXCEPTION 'invalid_service_preview' USING ERRCODE='P0001';END IF;
 UPDATE collab_gateway.service_http SET status='done',body=NULL,response=result WHERE id=job AND preview_id=preview AND status='running' RETURNING * INTO r;
 IF r.id IS NULL THEN RETURN;END IF;
 INSERT INTO collab.service_request_log(preview_id,method,path,code) VALUES(preview,r.method,left(split_part(r.path,'?',1),500),(result->>'status')::integer);
 DELETE FROM collab.service_request_log WHERE preview_id=preview AND id NOT IN(SELECT id FROM collab.service_request_log WHERE preview_id=preview ORDER BY id DESC LIMIT 100);
END $$;
-- Include disposable preview copies in the existing project artifact budget.
ALTER TABLE collab_worker.artifacts DROP CONSTRAINT artifacts_kind_check;
ALTER TABLE collab_worker.artifacts ADD CHECK(kind IN ('workspace','snapshot','validation','integration','repository','service'));
ALTER VIEW collab_worker.artifact_inventory RENAME TO artifact_inventory_before_service;
CREATE VIEW collab_worker.artifact_inventory AS SELECT * FROM collab_worker.artifact_inventory_before_service UNION ALL
 SELECT 'service',p.id,p.organization_id,p.project_id,p.author_id,p.created_at,p.title,p.status,NULL,p.runtime,'{}'::jsonb FROM collab.service_previews p;
CREATE TRIGGER register_service_artifact AFTER INSERT ON collab.service_previews FOR EACH ROW EXECUTE FUNCTION collab_worker.register_artifact('service');
CREATE OR REPLACE FUNCTION collab_worker.artifact_charge(project uuid) RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT coalesce(sum(CASE WHEN a.state='deleted' THEN 0 ELSE greatest(coalesce(a.bytes,a.reserved_bytes),CASE WHEN i.status IN ('pending','queued','running','starting','integrating','checking','unknown') OR (a.kind='service' AND i.status IN ('ready','stopping')) OR a.measurement_error IS NOT NULL THEN a.reserved_bytes ELSE 0 END) END),0)
 FROM collab_worker.artifacts a JOIN collab_worker.artifact_inventory i ON i.kind=a.kind AND i.id=a.id WHERE a.project_id=project AND a.kind<>'workspace'
$$;
ALTER FUNCTION collab_worker.artifact_protection(text,uuid) RENAME TO artifact_protection_before_service;
CREATE FUNCTION collab_worker.artifact_protection(k text,artifact uuid) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF k='service' THEN RETURN CASE WHEN EXISTS(SELECT 1 FROM collab.service_previews WHERE id=artifact AND cleaned_at IS NOT NULL) THEN 'deleted' ELSE 'service_runtime_managed' END;END IF;
 IF k='snapshot' AND EXISTS(SELECT 1 FROM collab.service_previews WHERE snapshot_id=artifact AND cleaned_at IS NULL) THEN RETURN 'snapshot_referenced';END IF;
 RETURN collab_worker.artifact_protection_before_service(k,artifact);
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA collab_worker FROM PUBLIC;
REVOKE ALL ON collab_gateway.service_tokens,collab_gateway.service_http FROM PUBLIC;
REVOKE ALL ON FUNCTION collab.create_service_preview(uuid,jsonb),collab_worker.service_authorized(uuid),collab_worker.claim_service(uuid,text),collab_worker.heartbeat_service(uuid,uuid,boolean,jsonb,text),collab.stop_service(uuid,text),collab_worker.finish_service(uuid,uuid,text,boolean,text),collab_worker.service_recovery(text),collab_worker.service_cleaned(uuid),collab.open_service(uuid,text),collab_gateway.service_access(text),collab_gateway.service_enqueue(text,text,text,text,text),collab_gateway.service_response(text,uuid),collab_worker.service_requests(uuid,uuid),collab_worker.service_respond(uuid,uuid,uuid,jsonb),collab_worker.artifact_protection(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.create_service_preview(uuid,jsonb),collab.stop_service(uuid,text),collab.open_service(uuid,text) TO pi_collab_app;
GRANT EXECUTE ON FUNCTION collab_worker.claim_service(uuid,text),collab_worker.heartbeat_service(uuid,uuid,boolean,jsonb,text),collab_worker.finish_service(uuid,uuid,text,boolean,text),collab_worker.service_recovery(text),collab_worker.service_cleaned(uuid),collab_worker.service_requests(uuid,uuid),collab_worker.service_respond(uuid,uuid,uuid,jsonb) TO pi_collab_executor;
GRANT EXECUTE ON FUNCTION collab_gateway.service_access(text),collab_gateway.service_enqueue(text,text,text,text,text),collab_gateway.service_response(text,uuid) TO pi_collab_gateway;
