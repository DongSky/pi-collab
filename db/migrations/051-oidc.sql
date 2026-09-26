CREATE TABLE collab_admin.oidc_providers (
 id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES collab.organizations(id),name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 issuer text NOT NULL,client_id text NOT NULL,secret jsonb NOT NULL,metadata jsonb NOT NULL,
 enabled boolean NOT NULL DEFAULT true,version integer NOT NULL DEFAULT 1,created_by text NOT NULL REFERENCES public."user"(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,issuer,client_id)
);
CREATE TABLE collab_admin.oidc_pending (
 hash text PRIMARY KEY CHECK(hash ~ '^[a-f0-9]{64}$'),user_id text NOT NULL REFERENCES public."user"(id),provider_id uuid NOT NULL REFERENCES collab_admin.oidc_providers(id),
 version integer NOT NULL,expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes',consumed_at timestamptz
);
-- Additional session fields are also declared to Better Auth's schema planner.
ALTER TABLE public.session ADD COLUMN IF NOT EXISTS "oidcProviderId" text;
ALTER TABLE public.session ADD COLUMN IF NOT EXISTS "oidcProviderVersion" text;
ALTER TABLE public.session ADD COLUMN IF NOT EXISTS "oidcChallengeHash" text;
CREATE FUNCTION collab.oidc_list(org uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF org IS NOT NULL AND (coalesce(collab.org_role(org),'') NOT IN ('owner','admin') OR NOT collab.actor_has_mfa()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001';END IF;
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id',p.id,'organizationId',p.organization_id,'organizationName',o.name,'name',p.name,'issuer',p.issuer,'clientId',p.client_id,'enabled',p.enabled,'version',p.version)) FROM collab_admin.oidc_providers p JOIN collab.organizations o ON o.id=p.organization_id WHERE (org IS NULL AND p.enabled) OR p.organization_id=org),'[]');
END $$;
CREATE FUNCTION collab.oidc_runtime(provider uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT to_jsonb(p) FROM collab_admin.oidc_providers p WHERE id=provider AND enabled $$;
CREATE FUNCTION collab.oidc_authorized(provider uuid, person text, revision integer) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM collab_admin.oidc_providers p JOIN collab.memberships m ON m.organization_id=p.organization_id WHERE p.id=provider AND p.enabled AND p.version=revision AND m.user_id=person AND m.active AND (NOT collab.user_requires_mfa(person) OR EXISTS(SELECT 1 FROM public."user" WHERE id=person AND "twoFactorEnabled")))
$$;
CREATE FUNCTION collab.configure_oidc(org uuid,provider uuid,body jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab_admin.oidc_providers;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(org::text,811));
 IF coalesce(collab.org_role(org),'') NOT IN ('owner','admin') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001';END IF;
 IF NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001';END IF;
 IF length(btrim(body->>'reason')) NOT BETWEEN 10 AND 2000 THEN RAISE EXCEPTION 'invalid_oidc' USING ERRCODE='P0001';END IF;
 SELECT * INTO p FROM collab_admin.oidc_providers WHERE id=provider FOR UPDATE;
 IF p.id IS NULL THEN
  IF (SELECT count(*) FROM collab_admin.oidc_providers WHERE organization_id=org)>=10 OR body->>'action'<>'create' THEN RAISE EXCEPTION 'invalid_oidc' USING ERRCODE='P0001';END IF;
  INSERT INTO collab_admin.oidc_providers(id,organization_id,name,issuer,client_id,secret,metadata,created_by) VALUES(provider,org,body->>'name',body->>'issuer',body->>'clientId',body->'secret',body->'metadata',collab.actor());
 ELSE
  IF p.organization_id<>org THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
  IF p.version IS DISTINCT FROM (body->>'expectedVersion')::integer THEN RAISE EXCEPTION 'stale_revision' USING ERRCODE='P0001';END IF;
  IF body->>'action'='toggle' THEN UPDATE collab_admin.oidc_providers SET enabled=(body->>'enabled')::boolean,version=version+1,updated_at=now() WHERE id=provider;
  ELSIF body->>'action'='rotate' THEN UPDATE collab_admin.oidc_providers SET secret=body->'secret',version=version+1,updated_at=now() WHERE id=provider;
  ELSE RAISE EXCEPTION 'invalid_oidc' USING ERRCODE='P0001';END IF;
  DELETE FROM public.session WHERE "userId" IN (SELECT "userId" FROM public.account WHERE "providerId"='oidc-'||provider::text);
  DELETE FROM public.verification WHERE value IN (SELECT "userId" FROM public.account WHERE "providerId"='oidc-'||provider::text);
  DELETE FROM collab_admin.oidc_pending WHERE provider_id=provider;
 END IF;
 INSERT INTO collab.audit_events(organization_id,actor_id,action,resource_id,detail) VALUES(org,collab.actor(),'oidc.'||(body->>'action'),provider::text,jsonb_build_object('reason',body->>'reason'));
 RETURN provider;
END $$;
CREATE FUNCTION collab.oidc_bindings() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'organizationName',o.name,'enabled',p.enabled,'bound',a.id IS NOT NULL,'boundAt',a."createdAt")),'[]') FROM collab_admin.oidc_providers p JOIN collab.organizations o ON o.id=p.organization_id JOIN collab.memberships m ON m.organization_id=p.organization_id AND m.user_id=collab.actor() AND m.active LEFT JOIN public.account a ON a."userId"=collab.actor() AND a."providerId"='oidc-'||p.id::text
$$;
CREATE FUNCTION collab.revoke_oidc_binding(provider uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab_admin.oidc_providers;
BEGIN
 SELECT * INTO p FROM collab_admin.oidc_providers WHERE id=provider;
 IF p.id IS NULL OR collab.org_role(p.organization_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p.organization_id::text,811));
 IF NOT EXISTS(SELECT 1 FROM public.account WHERE "userId"=collab.actor() AND "providerId"='credential' AND password IS NOT NULL) THEN RAISE EXCEPTION 'oidc_local_account_required' USING ERRCODE='P0001';END IF;
 DELETE FROM public.account WHERE "userId"=collab.actor() AND "providerId"='oidc-'||provider::text;
 DELETE FROM public.session WHERE "userId"=collab.actor();
 DELETE FROM public.verification WHERE value=collab.actor();
 DELETE FROM collab_admin.oidc_pending WHERE user_id=collab.actor();
 INSERT INTO collab.audit_events(organization_id,actor_id,action,resource_id) VALUES(p.organization_id,collab.actor(),'oidc.unlinked',provider::text);
END $$;
CREATE FUNCTION collab.oidc_pending_context(digest text,person text DEFAULT NULL) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('providerId',provider_id,'version',version::text) FROM collab_admin.oidc_pending WHERE hash=digest AND (person IS NULL OR user_id=person) AND consumed_at IS NULL AND expires_at>clock_timestamp()
$$;
CREATE FUNCTION collab.record_oidc_pending(digest text,person text,provider uuid,revision integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE org uuid;
BEGIN
 SELECT organization_id INTO org FROM collab_admin.oidc_providers WHERE id=provider;PERFORM pg_advisory_xact_lock(hashtextextended(org::text,811));
 IF NOT collab.oidc_authorized(provider,person,revision) THEN RAISE EXCEPTION 'oidc_unavailable' USING ERRCODE='P0001';END IF;
 DELETE FROM collab_admin.oidc_pending WHERE expires_at<clock_timestamp();
 INSERT INTO collab_admin.oidc_pending(hash,user_id,provider_id,version) VALUES(digest,person,provider,revision);
END $$;
CREATE FUNCTION collab.guard_oidc_session() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab_admin.oidc_providers; proof collab_admin.oidc_pending;
BEGIN
 IF NEW."oidcProviderId" IS NULL THEN RETURN NEW;END IF;
 SELECT * INTO p FROM collab_admin.oidc_providers WHERE id=NEW."oidcProviderId"::uuid;
 IF p.id IS NULL THEN RAISE EXCEPTION 'oidc_unavailable' USING ERRCODE='P0001';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p.organization_id::text,811));
 IF NOT collab.oidc_authorized(p.id,NEW."userId",NEW."oidcProviderVersion"::integer) OR NOT EXISTS(SELECT 1 FROM public.account WHERE "providerId"='oidc-'||p.id::text AND "userId"=NEW."userId") THEN RAISE EXCEPTION 'oidc_unavailable' USING ERRCODE='P0001';END IF;
 IF NEW."oidcChallengeHash" IS NOT NULL THEN
  SELECT * INTO proof FROM collab_admin.oidc_pending WHERE hash=NEW."oidcChallengeHash" FOR UPDATE;
  IF proof.hash IS NULL OR proof.user_id<>NEW."userId" OR proof.provider_id<>p.id OR proof.version<>NEW."oidcProviderVersion"::integer OR proof.consumed_at IS NOT NULL OR proof.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'oidc_unavailable' USING ERRCODE='P0001';END IF;
  UPDATE collab_admin.oidc_pending SET consumed_at=now() WHERE hash=proof.hash;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_oidc_session BEFORE INSERT ON public.session FOR EACH ROW EXECUTE FUNCTION collab.guard_oidc_session();
CREATE FUNCTION collab.guard_oidc_account() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab_admin.oidc_providers;
BEGIN
 IF NEW."providerId" NOT LIKE 'oidc-%' THEN RETURN NEW;END IF;
 SELECT * INTO p FROM collab_admin.oidc_providers WHERE id=substr(NEW."providerId",6)::uuid;
 IF p.id IS NULL THEN RAISE EXCEPTION 'oidc_unavailable' USING ERRCODE='P0001';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p.organization_id::text,811));
 IF NOT collab.oidc_authorized(p.id,NEW."userId",p.version) THEN RAISE EXCEPTION 'oidc_unavailable' USING ERRCODE='P0001';END IF;
 IF TG_OP='INSERT' THEN INSERT INTO collab.audit_events(organization_id,actor_id,action,resource_id) VALUES(p.organization_id,NEW."userId",'oidc.linked',p.id::text);END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_oidc_account BEFORE INSERT OR UPDATE ON public.account FOR EACH ROW EXECUTE FUNCTION collab.guard_oidc_account();
REVOKE ALL ON FUNCTION collab.oidc_list(uuid),collab.oidc_runtime(uuid),collab.oidc_authorized(uuid,text,integer),collab.configure_oidc(uuid,uuid,jsonb),collab.oidc_bindings(),collab.revoke_oidc_binding(uuid),collab.oidc_pending_context(text,text),collab.record_oidc_pending(text,text,uuid,integer),collab.guard_oidc_session(),collab.guard_oidc_account() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.oidc_list(uuid),collab.oidc_runtime(uuid),collab.oidc_authorized(uuid,text,integer),collab.configure_oidc(uuid,uuid,jsonb),collab.oidc_bindings(),collab.revoke_oidc_binding(uuid),collab.oidc_pending_context(text,text),collab.record_oidc_pending(text,text,uuid,integer) TO pi_collab_app;
