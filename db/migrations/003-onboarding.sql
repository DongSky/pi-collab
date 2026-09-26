CREATE FUNCTION collab.actor_has_mfa() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS(SELECT 1 FROM public."user" WHERE id=collab.actor() AND "twoFactorEnabled")
$$;

CREATE TABLE collab.invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES collab.organizations(id),
  email text NOT NULL CHECK(email=lower(email)), role text NOT NULL CHECK(role IN ('admin','member')),
  project_id uuid, project_role text CHECK(project_role IN ('maintainer','developer','reviewer','viewer')),
  invited_by text NOT NULL REFERENCES public."user"(id), token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL, accepted_at timestamptz, revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(organization_id,project_id) REFERENCES collab.projects(organization_id,id),
  CHECK((project_id IS NULL)=(project_role IS NULL))
);
ALTER TABLE collab.invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY invitations_read ON collab.invitations FOR SELECT USING(collab.org_role(organization_id) IN ('owner','admin'));
CREATE POLICY invitations_create ON collab.invitations FOR INSERT WITH CHECK(
  invited_by=collab.actor() AND collab.actor_has_mfa() AND
  (collab.org_role(organization_id)='owner' OR (collab.org_role(organization_id)='admin' AND role='member')) AND
  (project_id IS NULL OR collab.project_role(project_id)='maintainer')
);
CREATE POLICY invitations_update ON collab.invitations FOR UPDATE USING(
  collab.actor_has_mfa() AND (collab.org_role(organization_id)='owner' OR (collab.org_role(organization_id)='admin' AND role='member'))
) WITH CHECK(collab.org_role(organization_id) IN ('owner','admin'));
GRANT SELECT,INSERT ON collab.invitations TO pi_collab_app;
GRANT UPDATE(revoked_at) ON collab.invitations TO pi_collab_app;

CREATE TABLE collab.public_attempts (
  bucket text PRIMARY KEY, started_at timestamptz NOT NULL, attempts integer NOT NULL
);
CREATE FUNCTION collab.allow_public_attempt(bucket_name text, max_attempts integer, window_seconds integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n integer;
BEGIN
  INSERT INTO collab.public_attempts(bucket,started_at,attempts) VALUES(bucket_name,now(),1)
  ON CONFLICT(bucket) DO UPDATE SET
    attempts=CASE WHEN collab.public_attempts.started_at < now()-make_interval(secs=>window_seconds) THEN 1 ELSE collab.public_attempts.attempts+1 END,
    started_at=CASE WHEN collab.public_attempts.started_at < now()-make_interval(secs=>window_seconds) THEN now() ELSE collab.public_attempts.started_at END
  RETURNING attempts INTO n;
  RETURN n <= max_attempts;
END
$$;
CREATE FUNCTION collab.setup_needed() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS(SELECT 1 FROM collab.installation WHERE initialized_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM collab.organizations)
$$;
CREATE FUNCTION collab.bootstrap_valid(token text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT collab.setup_needed() AND EXISTS(SELECT 1 FROM collab.installation WHERE bootstrap_hash=token AND initialized_at IS NULL)
$$;

-- The maintained Better Auth crypto implementation creates password_hash in the service.
-- These narrow functions make credential + membership provisioning atomic; no remote signup endpoint is enabled.
CREATE FUNCTION collab.bootstrap(token text, user_name text, user_email text, password_hash text, organization_name text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE new_user text := gen_random_uuid()::text; new_org uuid := gen_random_uuid();
BEGIN
  PERFORM pg_advisory_xact_lock(82467103);
  IF NOT collab.bootstrap_valid(token) THEN RAISE EXCEPTION 'setup_unavailable' USING ERRCODE='P0001'; END IF;
  IF EXISTS(SELECT 1 FROM public."user" WHERE email=lower(user_email)) THEN RAISE EXCEPTION 'account_exists' USING ERRCODE='P0001'; END IF;
  INSERT INTO public."user"(id,name,email,"emailVerified","createdAt","updatedAt","twoFactorEnabled")
    VALUES(new_user,user_name,lower(user_email),true,now(),now(),false);
  INSERT INTO public.account(id,"accountId","providerId","userId",password,"createdAt","updatedAt")
    VALUES(gen_random_uuid()::text,new_user,'credential',new_user,password_hash,now(),now());
  INSERT INTO collab.organizations(id,name,created_by) VALUES(new_org,organization_name,new_user);
  INSERT INTO collab.memberships(organization_id,user_id,role) VALUES(new_org,new_user,'owner');
  INSERT INTO collab.audit_events(organization_id,actor_id,action,resource_id) VALUES(new_org,new_user,'organization.bootstrapped',new_org::text);
  UPDATE collab.installation SET initialized_at=now(),bootstrap_hash='' WHERE singleton;
  RETURN jsonb_build_object('userId',new_user,'organizationId',new_org);
END
$$;

CREATE FUNCTION collab.invitation_preview(token text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('email',i.email,'organizationName',o.name,'role',i.role,'projectName',p.name,'projectRole',i.project_role)
  FROM collab.invitations i JOIN collab.organizations o ON o.id=i.organization_id LEFT JOIN collab.projects p ON p.id=i.project_id
  WHERE i.token_hash=token AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>now()
$$;

CREATE FUNCTION collab.accept_invitation(token text, user_name text, user_email text, password_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE invite collab.invitations; target_user text; issuer_role text; actor text := collab.actor();
BEGIN
  SELECT * INTO invite FROM collab.invitations WHERE token_hash=token FOR UPDATE;
  IF NOT FOUND OR invite.accepted_at IS NOT NULL OR invite.revoked_at IS NOT NULL OR invite.expires_at<=now()
    THEN RAISE EXCEPTION 'invitation_unavailable' USING ERRCODE='P0001'; END IF;
  IF lower(user_email) <> invite.email THEN RAISE EXCEPTION 'invitation_email_mismatch' USING ERRCODE='P0001'; END IF;
  -- Serialize acceptance with issuer demotion/deactivation.
  PERFORM pg_advisory_xact_lock(hashtextextended(invite.organization_id::text,811));
  SELECT role INTO issuer_role FROM collab.memberships WHERE organization_id=invite.organization_id AND user_id=invite.invited_by AND active;
  IF issuer_role IS NULL OR issuer_role NOT IN ('owner','admin') OR (invite.role='admin' AND issuer_role<>'owner')
    THEN RAISE EXCEPTION 'inviter_no_longer_authorized' USING ERRCODE='P0001'; END IF;
  IF invite.project_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM collab.project_memberships WHERE project_id=invite.project_id AND user_id=invite.invited_by AND role='maintainer'
  ) THEN RAISE EXCEPTION 'inviter_no_longer_authorized' USING ERRCODE='P0001'; END IF;
  -- Serialize provisioning for an email shared by multiple independent invitations.
  PERFORM pg_advisory_xact_lock(hashtextextended(invite.email, 1042));
  SELECT id INTO target_user FROM public."user" WHERE email=invite.email;
  IF target_user IS NOT NULL THEN
    IF actor IS NULL OR actor<>target_user THEN RAISE EXCEPTION 'sign_in_required' USING ERRCODE='P0001'; END IF;
  ELSE
    IF actor IS NOT NULL THEN RAISE EXCEPTION 'invitation_email_mismatch' USING ERRCODE='P0001'; END IF;
    IF password_hash IS NULL OR length(password_hash)<32 OR user_name IS NULL THEN RAISE EXCEPTION 'registration_required' USING ERRCODE='P0001'; END IF;
    target_user := gen_random_uuid()::text;
    INSERT INTO public."user"(id,name,email,"emailVerified","createdAt","updatedAt","twoFactorEnabled")
      VALUES(target_user,user_name,invite.email,true,now(),now(),false);
    INSERT INTO public.account(id,"accountId","providerId","userId",password,"createdAt","updatedAt")
      VALUES(gen_random_uuid()::text,target_user,'credential',target_user,password_hash,now(),now());
  END IF;
  -- Invitations never reactivate a disabled membership, downgrade an existing role,
  -- or become a way to bypass the member-management approval path.
  IF EXISTS(SELECT 1 FROM collab.memberships WHERE organization_id=invite.organization_id AND user_id=target_user AND NOT active)
    THEN RAISE EXCEPTION 'membership_disabled' USING ERRCODE='P0001'; END IF;
  INSERT INTO collab.memberships(organization_id,user_id,role) VALUES(invite.organization_id,target_user,invite.role) ON CONFLICT DO NOTHING;
  IF invite.project_id IS NOT NULL THEN
    INSERT INTO collab.project_memberships(organization_id,project_id,user_id,role)
      VALUES(invite.organization_id,invite.project_id,target_user,invite.project_role) ON CONFLICT DO NOTHING;
  END IF;
  UPDATE collab.invitations SET accepted_at=now() WHERE id=invite.id;
  INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail)
    VALUES(invite.organization_id,invite.project_id,target_user,'invitation.accepted',invite.id::text,jsonb_build_object('invitedBy',invite.invited_by));
  RETURN jsonb_build_object('userId',target_user,'organizationId',invite.organization_id,'projectId',invite.project_id);
END
$$;

CREATE FUNCTION collab.user_requires_mfa(uid text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS(SELECT 1 FROM collab.memberships WHERE user_id=uid AND active AND role IN ('owner','admin'))
$$;

CREATE FUNCTION collab.guard_mfa() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF OLD."twoFactorEnabled" AND NOT NEW."twoFactorEnabled" AND collab.user_requires_mfa(NEW.id)
    THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
  -- Sessions issued before enrollment must not acquire administrator privileges.
  -- Better Auth creates a fresh cookie/session after successful verification.
  IF NOT coalesce(OLD."twoFactorEnabled",false) AND NEW."twoFactorEnabled" THEN
    DELETE FROM public.session WHERE "userId"=NEW.id;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER user_mfa_guard BEFORE UPDATE OF "twoFactorEnabled" ON public."user" FOR EACH ROW EXECUTE FUNCTION collab.guard_mfa();

CREATE FUNCTION collab.guard_last_owner() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF OLD.role='owner' AND OLD.active AND (TG_OP='DELETE' OR NOT NEW.active OR NEW.role<>'owner') THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(OLD.organization_id::text, 811));
    IF NOT EXISTS(SELECT 1 FROM collab.memberships WHERE organization_id=OLD.organization_id AND user_id<>OLD.user_id AND active AND role='owner')
      THEN RAISE EXCEPTION 'last_owner' USING ERRCODE='P0001'; END IF;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END
$$;
CREATE TRIGGER memberships_last_owner BEFORE UPDATE OF role,active OR DELETE ON collab.memberships FOR EACH ROW EXECUTE FUNCTION collab.guard_last_owner();

CREATE FUNCTION collab.change_member(org uuid, target text, new_role text, enabled boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor_role text; target_role text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(org::text,811));
  actor_role := collab.org_role(org);
  SELECT role INTO target_role FROM collab.memberships WHERE organization_id=org AND user_id=target FOR UPDATE;
  IF actor_role IS NULL OR actor_role NOT IN ('owner','admin') OR target_role IS NULL
    THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public."user" WHERE id=collab.actor() AND "twoFactorEnabled")
    THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
  IF new_role NOT IN ('owner','admin','member') THEN RAISE EXCEPTION 'invalid_role' USING ERRCODE='P0001'; END IF;
  IF actor_role='admin' AND (target_role<>'member' OR new_role<>'member') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
  UPDATE collab.memberships SET role=new_role,active=enabled WHERE organization_id=org AND user_id=target;
  -- Removing/reactivating membership does not implicitly create any project membership.
  DELETE FROM public.session WHERE "userId"=target;
  INSERT INTO collab.audit_events(organization_id,actor_id,action,resource_id,detail)
    VALUES(org,collab.actor(),'member.changed',target,jsonb_build_object('role',new_role,'active',enabled));
  PERFORM pg_notify('pi_collab_authorization',json_build_object('organizationId',org,'userId',target)::text);
END
$$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA collab FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.allow_public_attempt(text,integer,integer),collab.setup_needed(),collab.bootstrap_valid(text),
  collab.bootstrap(text,text,text,text,text),collab.invitation_preview(text),collab.accept_invitation(text,text,text,text),
  collab.user_requires_mfa(text),collab.actor_has_mfa(),collab.change_member(uuid,text,text,boolean) TO pi_collab_app;
