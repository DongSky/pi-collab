CREATE TABLE collab.checkpoint_previews (
 id uuid PRIMARY KEY,organization_id uuid NOT NULL,project_id uuid NOT NULL,task_id uuid NOT NULL REFERENCES collab.tasks(id),
 validation_id uuid NOT NULL REFERENCES collab.validations(id),snapshot_id uuid NOT NULL REFERENCES collab.snapshots(id),snapshot_hash text NOT NULL,
 author_id text NOT NULL REFERENCES public."user"(id),title text NOT NULL,folder text NOT NULL,entry_path text NOT NULL,
 status text NOT NULL DEFAULT 'preparing' CHECK(status IN ('preparing','ready','failed','revoked','expired')),
 artifact_hash text,file_count integer,total_bytes integer,failure text,expires_at timestamptz NOT NULL DEFAULT now()+interval '1 hour',
 created_at timestamptz NOT NULL DEFAULT now(),cleaned_at timestamptz,
 FOREIGN KEY(organization_id,project_id) REFERENCES collab.projects(organization_id,id)
);
CREATE TABLE collab_gateway.preview_tokens (
 digest text PRIMARY KEY,preview_id uuid NOT NULL REFERENCES collab.checkpoint_previews(id),user_id text NOT NULL REFERENCES public."user"(id),
 org_version bigint NOT NULL,project_version bigint NOT NULL,expires_at timestamptz NOT NULL DEFAULT now()+interval '5 minutes'
);
CREATE TABLE collab.preview_requests (
 id bigserial PRIMARY KEY,preview_id uuid NOT NULL REFERENCES collab.checkpoint_previews(id),path text NOT NULL,status integer NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE collab.checkpoint_previews ENABLE ROW LEVEL SECURITY;ALTER TABLE collab.preview_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY preview_read ON collab.checkpoint_previews FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
CREATE POLICY preview_requests_read ON collab.preview_requests FOR SELECT USING(EXISTS(SELECT 1 FROM collab.checkpoint_previews p WHERE p.id=preview_id));
GRANT SELECT ON collab.checkpoint_previews,collab.preview_requests TO pi_collab_app;
CREATE TRIGGER operations_admission BEFORE INSERT ON collab.checkpoint_previews FOR EACH ROW EXECUTE FUNCTION collab_meta.guard_admission();
CREATE FUNCTION collab.begin_preview(preview uuid,validation uuid,title text,folder text,entry text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v collab.validations;s collab.snapshots;
BEGIN
 SELECT * INTO v FROM collab.validations WHERE id=validation;
 IF v.id IS NULL OR coalesce(collab.project_role(v.project_id),'') NOT IN ('developer','reviewer','maintainer') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(v.organization_id::text,811));
 IF collab.user_requires_mfa(collab.actor()) AND NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001';END IF;
 SELECT * INTO s FROM collab.snapshots WHERE id=v.snapshot_id;
 IF v.status<>'passed' OR s.status<>'ready' OR v.manifest_hash IS DISTINCT FROM s.manifest_hash THEN RAISE EXCEPTION 'preview_source_unavailable' USING ERRCODE='P0001';END IF;
 IF coalesce(length(title),0) NOT BETWEEN 1 AND 120 OR coalesce(length(folder),0) NOT BETWEEN 1 AND 500 OR coalesce(length(entry),0) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'invalid_preview' USING ERRCODE='P0001';END IF;
 IF (SELECT count(*) FROM collab.checkpoint_previews WHERE project_id=v.project_id AND status IN ('preparing','ready') AND expires_at>now())>=20 THEN RAISE EXCEPTION 'preview_limit' USING ERRCODE='P0001';END IF;
 INSERT INTO collab.checkpoint_previews(id,organization_id,project_id,task_id,validation_id,snapshot_id,snapshot_hash,author_id,title,folder,entry_path) VALUES(preview,v.organization_id,v.project_id,v.task_id,v.id,s.id,s.manifest_hash,collab.actor(),title,folder,entry);
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(v.organization_id,v.project_id,collab.actor(),'preview.requested',preview::text,jsonb_build_object('validationId',validation,'snapshotId',s.id,'manifestHash',s.manifest_hash));
 RETURN jsonb_build_object('snapshotId',s.id,'manifestHash',s.manifest_hash);
END $$;
CREATE FUNCTION collab.finish_preview(preview uuid,hash text,files integer,bytes integer,failure text DEFAULT NULL) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab.checkpoint_previews;
BEGIN
 SELECT * INTO p FROM collab.checkpoint_previews WHERE id=preview FOR UPDATE;
 IF p.author_id IS DISTINCT FROM collab.actor() OR coalesce(collab.project_role(p.project_id),'') NOT IN ('developer','reviewer','maintainer') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001';END IF;
 IF p.status<>'preparing' OR p.expires_at<=now() THEN RAISE EXCEPTION 'preview_unavailable' USING ERRCODE='P0001';END IF;
 IF failure IS NULL AND (hash IS NULL OR hash!~'^[a-f0-9]{64}$' OR coalesce(files,0) NOT BETWEEN 1 AND 200 OR coalesce(bytes,0) NOT BETWEEN 1 AND 8388608) THEN RAISE EXCEPTION 'invalid_preview' USING ERRCODE='P0001';END IF;
 UPDATE collab.checkpoint_previews SET status=CASE WHEN finish_preview.failure IS NULL THEN 'ready' ELSE 'failed' END,artifact_hash=hash,file_count=files,total_bytes=bytes,failure=finish_preview.failure WHERE id=preview;
END $$;
CREATE FUNCTION collab.open_preview(preview uuid,digest text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab.checkpoint_previews;ov bigint;pv bigint;
BEGIN
 SELECT * INTO p FROM collab.checkpoint_previews WHERE id=preview;
 IF p.id IS NULL OR collab.project_role(p.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p.organization_id::text,811));
 IF p.status<>'ready' OR p.expires_at<=now() THEN RAISE EXCEPTION 'preview_unavailable' USING ERRCODE='P0001';END IF;
 IF digest IS NULL OR digest!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'invalid_preview' USING ERRCODE='P0001';END IF;
 IF collab.user_requires_mfa(collab.actor()) AND NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001';END IF;
 SELECT authorization_version INTO ov FROM collab.memberships WHERE organization_id=p.organization_id AND user_id=collab.actor();SELECT authorization_version INTO pv FROM collab.project_memberships WHERE project_id=p.project_id AND user_id=collab.actor();
 DELETE FROM collab_gateway.preview_tokens WHERE preview_id=preview AND user_id=collab.actor();
 INSERT INTO collab_gateway.preview_tokens(digest,preview_id,user_id,org_version,project_version) VALUES(digest,preview,collab.actor(),ov,pv);
 RETURN jsonb_build_object('entry',p.entry_path,'expiresAt',least(p.expires_at,now()+interval '5 minutes'));
END $$;
CREATE FUNCTION collab.revoke_preview(preview uuid,reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab.checkpoint_previews;
BEGIN
 SELECT * INTO p FROM collab.checkpoint_previews WHERE id=preview;
 IF p.id IS NULL OR collab.project_role(p.project_id) IS NULL OR (collab.project_role(p.project_id)<>'maintainer' AND p.author_id<>collab.actor()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001';END IF;
 IF coalesce(length(btrim(reason)),0) NOT BETWEEN 10 AND 2000 THEN RAISE EXCEPTION 'invalid_preview' USING ERRCODE='P0001';END IF;
 UPDATE collab.checkpoint_previews SET status='revoked' WHERE id=preview;
 DELETE FROM collab_gateway.preview_tokens WHERE preview_id=preview;
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(p.organization_id,p.project_id,collab.actor(),'preview.revoked',preview::text,jsonb_build_object('reason',reason));
END $$;
CREATE FUNCTION collab_gateway.preview_access(hash text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',p.id,'artifactHash',p.artifact_hash) FROM collab_gateway.preview_tokens tok JOIN collab.checkpoint_previews p ON p.id=tok.preview_id
 JOIN collab.memberships m ON m.organization_id=p.organization_id AND m.user_id=tok.user_id AND m.active AND m.authorization_version=tok.org_version
 JOIN collab.project_memberships pm ON pm.project_id=p.project_id AND pm.user_id=tok.user_id AND pm.active AND pm.authorization_version=tok.project_version
 JOIN public."user" u ON u.id=tok.user_id
 WHERE tok.digest=hash AND tok.expires_at>now() AND p.status='ready' AND p.expires_at>now() AND (NOT collab.user_requires_mfa(u.id) OR u."twoFactorEnabled")
$$;
CREATE FUNCTION collab_gateway.preview_log(hash text,file text,code integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE access jsonb:=collab_gateway.preview_access(hash);preview uuid;
BEGIN
 IF access IS NULL THEN RETURN;END IF;preview:=(access->>'id')::uuid;
 INSERT INTO collab.preview_requests(preview_id,path,status) VALUES(preview,left(file,500),code);
 DELETE FROM collab.preview_requests WHERE preview_id=preview AND id NOT IN (SELECT id FROM collab.preview_requests WHERE preview_id=preview ORDER BY id DESC LIMIT 100);
END $$;
CREATE FUNCTION collab_gateway.expired_previews() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 UPDATE collab.checkpoint_previews SET status='expired' WHERE status IN ('ready','preparing') AND (expires_at<=now() OR status='preparing' AND created_at<now()-interval '5 minutes');
 DELETE FROM collab_gateway.preview_tokens WHERE expires_at<=now();
 RETURN coalesce((SELECT jsonb_agg(id) FROM (SELECT id FROM collab.checkpoint_previews WHERE status IN ('expired','revoked','failed') AND cleaned_at IS NULL LIMIT 50)p),'[]');
END $$;
CREATE FUNCTION collab_gateway.preview_cleaned(preview uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 UPDATE collab.checkpoint_previews SET cleaned_at=now() WHERE id=preview AND status IN ('expired','revoked','failed')
$$;
REVOKE ALL ON FUNCTION collab.begin_preview(uuid,uuid,text,text,text),collab.finish_preview(uuid,text,integer,integer,text),collab.open_preview(uuid,text),collab.revoke_preview(uuid,text),collab_gateway.preview_access(text),collab_gateway.preview_log(text,text,integer),collab_gateway.expired_previews(),collab_gateway.preview_cleaned(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.begin_preview(uuid,uuid,text,text,text),collab.finish_preview(uuid,text,integer,integer,text),collab.open_preview(uuid,text),collab.revoke_preview(uuid,text) TO pi_collab_app;
GRANT EXECUTE ON FUNCTION collab_gateway.preview_access(text),collab_gateway.preview_log(text,text,integer),collab_gateway.expired_previews(),collab_gateway.preview_cleaned(uuid) TO pi_collab_gateway;
