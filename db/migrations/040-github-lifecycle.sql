CREATE TABLE collab_git.installation_lifecycle (
 connection_id uuid NOT NULL REFERENCES collab.github_installations(id), actor_id text NOT NULL REFERENCES public."user"(id),
 request_key uuid NOT NULL, request jsonb NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(connection_id,actor_id,request_key)
);
CREATE FUNCTION collab.remove_github_credential(connection uuid, expected bigint, reason text, key uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c collab.github_installations; prior collab_git.installation_lifecycle; payload jsonb; result jsonb;
BEGIN
 SELECT * INTO c FROM collab.github_installations WHERE id=connection;
 IF c.id IS NULL OR collab.org_role(c.organization_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(c.organization_id::text,811));
 SELECT * INTO STRICT c FROM collab.github_installations WHERE id=connection FOR UPDATE;
 PERFORM 1 FROM public."user" WHERE id=collab.actor() FOR SHARE;
 IF collab.org_role(c.organization_id) NOT IN ('owner','admin') OR collab.org_role(c.organization_id) IS NULL OR NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF expected IS NULL OR key IS NULL OR length(btrim(reason)) NOT BETWEEN 10 AND 2000 OR reason IS NULL THEN RAISE EXCEPTION 'invalid_github_connection' USING ERRCODE='P0001'; END IF;
 payload:=jsonb_build_object('action','remove','expectedVersion',expected::text,'reason',btrim(reason));
 SELECT * INTO prior FROM collab_git.installation_lifecycle WHERE connection_id=connection AND actor_id=collab.actor() AND request_key=key;
 IF FOUND THEN IF prior.request<>payload THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF; RETURN prior.result||jsonb_build_object('replayed',true); END IF;
 IF c.version<>expected THEN RAISE EXCEPTION 'stale_github_connection' USING ERRCODE='P0001'; END IF;
 UPDATE collab.github_installations SET enabled=false,version=version+1 WHERE id=connection;
 DELETE FROM collab_git.credentials WHERE connection_id=connection;
 UPDATE collab_git.webhook_keys SET enabled=false,version=version+1 WHERE connection_id=connection;
 result:=jsonb_build_object('connectionId',connection,'version',(c.version+1)::text,'enabled',false,'credentialPresent',false);
 INSERT INTO collab_git.installation_lifecycle(connection_id,actor_id,request_key,request,result) VALUES(connection,collab.actor(),key,payload,result);
 INSERT INTO collab.audit_events(organization_id,actor_id,action,resource_id,detail) VALUES(c.organization_id,collab.actor(),'github.credential_removed',connection::text,payload);
 RETURN result||jsonb_build_object('replayed',false);
END $$;
CREATE FUNCTION collab.github_credential_present(connection uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM collab.github_installations c JOIN collab_git.credentials k ON k.connection_id=c.id WHERE c.id=connection AND collab.org_role(c.organization_id) IN ('owner','admin'))
$$;
REVOKE ALL ON FUNCTION collab.remove_github_credential(uuid,bigint,text,uuid),collab.github_credential_present(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.remove_github_credential(uuid,bigint,text,uuid),collab.github_credential_present(uuid) TO pi_collab_app;
