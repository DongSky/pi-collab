-- GitHub App material belongs to the trusted Git broker/administrator only.
-- No agent, Web or existing model/resource broker receives these credentials.
CREATE SCHEMA collab_git;
REVOKE ALL ON SCHEMA collab_git FROM PUBLIC;
CREATE TABLE collab.github_installations (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES collab.organizations(id),
 app_id text NOT NULL CHECK(app_id~'^[1-9][0-9]{0,15}$'), installation_id text NOT NULL CHECK(installation_id~'^[1-9][0-9]{0,15}$'),
 account_id text NOT NULL CHECK(account_id~'^[1-9][0-9]{0,15}$'), account_login text NOT NULL, account_type text NOT NULL CHECK(account_type IN ('User','Organization')),
 app_slug text NOT NULL, public_key_fingerprint text NOT NULL CHECK(public_key_fingerprint~'^[a-f0-9]{64}$'),
 evidence jsonb NOT NULL, enabled boolean NOT NULL DEFAULT true, version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 registered_by text NOT NULL REFERENCES public."user"(id), idempotency_key uuid NOT NULL, request jsonb NOT NULL,
 verified_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(app_id,installation_id), UNIQUE(organization_id,id), UNIQUE(organization_id,registered_by,idempotency_key)
);
CREATE TABLE collab_git.credentials (
 connection_id uuid PRIMARY KEY REFERENCES collab.github_installations(id), sealed jsonb NOT NULL
);
CREATE TABLE collab.github_bindings (
 repository_id uuid PRIMARY KEY, organization_id uuid NOT NULL, project_id uuid NOT NULL, connection_id uuid NOT NULL, installation_version bigint NOT NULL,
 github_repository_id text NOT NULL UNIQUE CHECK(github_repository_id~'^[1-9][0-9]{0,15}$'),
 evidence jsonb NOT NULL, bound_by text NOT NULL REFERENCES public."user"(id), idempotency_key uuid NOT NULL, request jsonb NOT NULL,
 verified_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(repository_id,bound_by,idempotency_key),
 FOREIGN KEY(organization_id,project_id,repository_id) REFERENCES collab.repositories(organization_id,project_id,id),
 FOREIGN KEY(organization_id,connection_id) REFERENCES collab.github_installations(organization_id,id)
);
CREATE TABLE collab.github_installation_actions (
 connection_id uuid NOT NULL REFERENCES collab.github_installations(id), actor_id text NOT NULL REFERENCES public."user"(id), idempotency_key uuid NOT NULL,
 expected_version bigint NOT NULL, reason text NOT NULL CHECK(length(reason) BETWEEN 10 AND 2000), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(connection_id,actor_id,idempotency_key)
);
ALTER TABLE collab.github_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE collab.github_bindings ENABLE ROW LEVEL SECURITY;
CREATE POLICY github_admin_read ON collab.github_installations FOR SELECT USING(collab.org_role(organization_id) IN ('owner','admin'));
CREATE POLICY github_project_read ON collab.github_bindings FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
GRANT SELECT ON collab.github_installations,collab.github_bindings TO pi_collab_app;

CREATE FUNCTION collab.github_binding_state(repository uuid) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE binding collab.github_bindings; connection collab.github_installations;
BEGIN
 SELECT * INTO binding FROM collab.github_bindings WHERE repository_id=repository;
 IF binding.repository_id IS NULL OR collab.project_role(binding.project_id) IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO STRICT connection FROM collab.github_installations WHERE id=binding.connection_id;
 RETURN CASE WHEN NOT connection.enabled OR connection.version<>binding.installation_version THEN 'disabled' ELSE 'observed' END;
END $$;
CREATE FUNCTION collab.disable_github_installation(connection uuid, expected bigint, reason text, request_key uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c collab.github_installations; prior collab.github_installation_actions;
BEGIN
 SELECT * INTO c FROM collab.github_installations WHERE id=connection;
 IF c.id IS NULL OR collab.org_role(c.organization_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(c.organization_id::text,811)); SELECT * INTO STRICT c FROM collab.github_installations WHERE id=connection FOR UPDATE;
 PERFORM 1 FROM public."user" WHERE id=collab.actor() FOR SHARE;
 IF collab.org_role(c.organization_id) NOT IN ('owner','admin') OR collab.org_role(c.organization_id) IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
 IF expected IS NULL OR expected<1 OR reason IS NULL OR length(btrim(reason)) NOT BETWEEN 10 AND 2000 OR request_key IS NULL THEN RAISE EXCEPTION 'invalid_github_connection' USING ERRCODE='P0001'; END IF;
 SELECT * INTO prior FROM collab.github_installation_actions WHERE connection_id=connection AND actor_id=collab.actor() AND idempotency_key=request_key;
 IF FOUND THEN
  IF prior.expected_version<>expected OR prior.reason<>btrim(reason) THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
 ELSE
  IF c.version<>expected THEN RAISE EXCEPTION 'stale_github_connection' USING ERRCODE='P0001'; END IF;
  INSERT INTO collab.github_installation_actions VALUES(connection,collab.actor(),request_key,expected,btrim(reason),now());
  UPDATE collab.github_installations SET enabled=false,version=version+1 WHERE id=connection;
  INSERT INTO collab.audit_events(organization_id,actor_id,action,resource_id,detail) VALUES(c.organization_id,collab.actor(),'github.installation_disabled',connection::text,jsonb_build_object('reason',btrim(reason),'previousVersion',c.version::text));
 END IF;
 RETURN jsonb_build_object('connectionId',connection,'version',(SELECT version::text FROM collab.github_installations WHERE id=connection),'enabled',(SELECT enabled FROM collab.github_installations WHERE id=connection),'replayed',prior.connection_id IS NOT NULL);
END $$;
REVOKE ALL ON FUNCTION collab.github_binding_state(uuid),collab.disable_github_installation(uuid,bigint,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.github_binding_state(uuid),collab.disable_github_installation(uuid,bigint,text,uuid) TO pi_collab_app;
