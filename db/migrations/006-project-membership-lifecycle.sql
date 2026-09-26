ALTER TABLE collab.project_memberships ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE collab.project_memberships ADD COLUMN authorization_version bigint NOT NULL DEFAULT 1;
ALTER TABLE collab.runs ADD COLUMN project_authorization_version bigint NOT NULL DEFAULT 1;
UPDATE collab.runs r SET project_authorization_version=pm.authorization_version FROM collab.project_memberships pm WHERE pm.project_id=r.project_id AND pm.user_id=r.requested_by;

CREATE OR REPLACE FUNCTION collab.project_role(project uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT pm.role FROM collab.project_memberships pm JOIN collab.memberships m
  ON m.organization_id=pm.organization_id AND m.user_id=pm.user_id
  WHERE pm.project_id=project AND pm.user_id=collab.actor() AND m.active AND pm.active
$$;
-- Direct application inserts remain limited to the initial project transaction.
-- All subsequent grants require the audited membership function or an invitation.
DROP POLICY project_memberships_create ON collab.project_memberships;
CREATE POLICY project_memberships_create ON collab.project_memberships FOR INSERT WITH CHECK(
  collab.is_project_creator(project_id) AND user_id=collab.actor() AND role='maintainer' AND active AND authorization_version=1
);

CREATE FUNCTION collab.guard_project_member() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(OLD.organization_id::text,811));
  IF OLD.role='maintainer' AND OLD.active AND (TG_OP='DELETE' OR NEW.role<>'maintainer' OR NOT NEW.active)
    AND EXISTS(SELECT 1 FROM collab.memberships WHERE organization_id=OLD.organization_id AND user_id=OLD.user_id AND active)
    AND NOT EXISTS(SELECT 1 FROM collab.project_memberships pm JOIN collab.memberships m ON m.organization_id=pm.organization_id AND m.user_id=pm.user_id
      WHERE pm.project_id=OLD.project_id AND pm.user_id<>OLD.user_id AND pm.role='maintainer' AND pm.active AND m.active)
    THEN RAISE EXCEPTION 'last_maintainer' USING ERRCODE='P0001'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF NEW.role IS DISTINCT FROM OLD.role OR NEW.active IS DISTINCT FROM OLD.active THEN NEW.authorization_version := OLD.authorization_version+1; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER project_member_guard BEFORE UPDATE OF role,active OR DELETE ON collab.project_memberships FOR EACH ROW EXECUTE FUNCTION collab.guard_project_member();

-- Reserve the full affected run set before emitting project events. Taking one
-- run at a time can deadlock against another run finishing on the same project.
CREATE FUNCTION collab_worker.stop_member_runs(org uuid, target text, project uuid, reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab.runs;
BEGIN
  PERFORM 1 FROM collab.runs WHERE organization_id=org AND requested_by=target AND (project IS NULL OR project_id=project)
    AND status IN ('queued','starting','running','waiting_input') ORDER BY id FOR UPDATE;
  FOR r IN SELECT * FROM collab.runs WHERE organization_id=org AND requested_by=target AND (project IS NULL OR project_id=project)
    AND status IN ('queued','starting','running','waiting_input') ORDER BY id LOOP
    PERFORM collab_worker.request_stop(r.id,reason);
  END LOOP;
END
$$;
CREATE OR REPLACE FUNCTION collab_worker.membership_revoked() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM collab_worker.stop_member_runs(NEW.organization_id,NEW.user_id,NULL,'authorization_revoked');
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION collab_worker.stop_member_runs(uuid,text,uuid,text) FROM PUBLIC;

CREATE FUNCTION collab_worker.project_member_changed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.role=OLD.role AND NEW.active=OLD.active THEN RETURN NEW; END IF;
  PERFORM collab_worker.stop_member_runs(OLD.organization_id,OLD.user_id,OLD.project_id,'project_authorization_changed');
  -- Re-granting a former inviter never resurrects their earlier invitations.
  UPDATE collab.invitations SET revoked_at=now() WHERE project_id=OLD.project_id AND invited_by=OLD.user_id AND accepted_at IS NULL AND revoked_at IS NULL;
  PERFORM pg_notify('pi_collab_authorization',json_build_object('projectId',OLD.project_id,'userId',OLD.user_id)::text);
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END
$$;
CREATE TRIGGER project_member_runs AFTER UPDATE OF role,active OR DELETE ON collab.project_memberships FOR EACH ROW EXECUTE FUNCTION collab_worker.project_member_changed();

CREATE FUNCTION collab_worker.bind_project_authorization() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  SELECT authorization_version INTO NEW.project_authorization_version FROM collab.project_memberships WHERE project_id=NEW.project_id AND user_id=NEW.requested_by AND active;
  IF NEW.project_authorization_version IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER run_project_authorization BEFORE INSERT ON collab.runs FOR EACH ROW EXECUTE FUNCTION collab_worker.bind_project_authorization();
CREATE OR REPLACE FUNCTION collab_worker.authorized(run uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS(
    SELECT 1 FROM collab.runs r JOIN collab.tasks t ON t.id=r.task_id
    JOIN collab.memberships m ON m.organization_id=r.organization_id AND m.user_id=r.requested_by
    JOIN collab.project_memberships pm ON pm.project_id=r.project_id AND pm.user_id=r.requested_by
    JOIN public."user" u ON u.id=r.requested_by
    WHERE r.id=run AND m.active AND m.authorization_version=r.authorization_version
      AND pm.active AND pm.authorization_version=r.project_authorization_version
      AND pm.role IN ('maintainer','developer') AND (t.owner_id=r.requested_by OR pm.role='maintainer')
      AND (m.role='member' OR u."twoFactorEnabled")
  )
$$;

CREATE FUNCTION collab.require_project_management(project uuid) RETURNS collab.projects LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab.projects;
BEGIN
  SELECT * INTO p FROM collab.projects WHERE id=project;
  IF p.id IS NULL OR collab.project_role(project) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p.organization_id::text,811));
  IF collab.project_role(project) IS DISTINCT FROM 'maintainer' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
  IF collab.user_requires_mfa(collab.actor()) AND NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
  RETURN p;
END
$$;
CREATE FUNCTION collab.add_project_member(project uuid, email_address text, new_role text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab.projects; target text; member collab.project_memberships;
BEGIN
  p := collab.require_project_management(project);
  IF new_role IS NULL OR new_role NOT IN ('maintainer','developer','reviewer','viewer') THEN RAISE EXCEPTION 'invalid_role' USING ERRCODE='P0001'; END IF;
  SELECT m.user_id INTO target FROM collab.memberships m JOIN public."user" u ON u.id=m.user_id WHERE m.organization_id=p.organization_id AND m.active AND u.email=lower(email_address);
  IF target IS NULL THEN RAISE EXCEPTION 'project_member_ineligible' USING ERRCODE='P0001'; END IF;
  SELECT * INTO member FROM collab.project_memberships WHERE project_id=project AND user_id=target;
  IF FOUND THEN RAISE EXCEPTION 'project_member_exists' USING ERRCODE='P0001'; END IF;
  INSERT INTO collab.project_memberships(organization_id,project_id,user_id,role) VALUES(p.organization_id,project,target,new_role) RETURNING * INTO member;
  INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(p.organization_id,project,collab.actor(),'project.member_added',target,jsonb_build_object('role',new_role));
  RETURN jsonb_build_object('userId',target,'version',member.authorization_version::text);
END
$$;
CREATE FUNCTION collab.change_project_member(project uuid, target text, new_role text, enabled boolean, expected_version bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab.projects; member collab.project_memberships;
BEGIN
  p := collab.require_project_management(project);
  IF new_role IS NULL OR new_role NOT IN ('maintainer','developer','reviewer','viewer') OR enabled IS NULL THEN RAISE EXCEPTION 'invalid_role' USING ERRCODE='P0001'; END IF;
  SELECT * INTO member FROM collab.project_memberships WHERE project_id=project AND user_id=target FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
  IF expected_version IS NULL OR expected_version<>member.authorization_version THEN RAISE EXCEPTION 'stale_membership' USING ERRCODE='P0001'; END IF;
  IF enabled AND NOT EXISTS(SELECT 1 FROM collab.memberships WHERE organization_id=p.organization_id AND user_id=target AND active) THEN RAISE EXCEPTION 'project_member_ineligible' USING ERRCODE='P0001'; END IF;
  IF member.role=new_role AND member.active=enabled THEN RETURN jsonb_build_object('version',member.authorization_version::text,'changed',false); END IF;
  UPDATE collab.project_memberships SET role=new_role,active=enabled WHERE project_id=project AND user_id=target RETURNING authorization_version INTO expected_version;
  INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(p.organization_id,project,collab.actor(),'project.member_changed',target,
    jsonb_build_object('previousRole',member.role,'previousActive',member.active,'role',new_role,'active',enabled,'version',expected_version::text));
  RETURN jsonb_build_object('version',expected_version::text,'changed',true);
END
$$;

-- Organization governance reveals names/management metadata, never project contents.
CREATE FUNCTION collab.project_governance(org uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF collab.org_role(org) IS NULL OR collab.org_role(org) NOT IN ('owner','admin') THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
  RETURN coalesce((SELECT jsonb_agg(row_data ORDER BY row_data->>'name') FROM (
    SELECT jsonb_build_object('id',p.id,'name',p.name,'ownRole',collab.project_role(p.id),'maintainers',
      (SELECT count(*) FROM collab.project_memberships pm JOIN collab.memberships m ON m.organization_id=pm.organization_id AND m.user_id=pm.user_id WHERE pm.project_id=p.id AND pm.role='maintainer' AND pm.active AND m.active)) row_data
    FROM collab.projects p WHERE p.organization_id=org
  ) q),'[]'::jsonb);
END
$$;
CREATE FUNCTION collab.recover_project(project uuid, reason text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab.projects; version bigint;
BEGIN
  SELECT * INTO p FROM collab.projects WHERE id=project;
  IF p.id IS NULL OR collab.org_role(p.organization_id) IS NULL OR collab.org_role(p.organization_id) NOT IN ('owner','admin') THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p.organization_id::text,811));
  IF collab.org_role(p.organization_id) IS NULL OR collab.org_role(p.organization_id) NOT IN ('owner','admin') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
  IF NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
  IF reason IS NULL OR length(btrim(reason)) NOT BETWEEN 10 AND 2000 THEN RAISE EXCEPTION 'recovery_reason_required' USING ERRCODE='P0001'; END IF;
  IF collab.project_role(project)='maintainer' THEN RAISE EXCEPTION 'already_maintainer' USING ERRCODE='P0001'; END IF;
  INSERT INTO collab.project_memberships(organization_id,project_id,user_id,role,active) VALUES(p.organization_id,project,collab.actor(),'maintainer',true)
    ON CONFLICT(project_id,user_id) DO UPDATE SET role='maintainer',active=true RETURNING authorization_version INTO version;
  INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(p.organization_id,project,collab.actor(),'project.emergency_access',project::text,jsonb_build_object('reason',btrim(reason),'version',version::text));
  RETURN jsonb_build_object('projectId',project,'version',version::text);
END
$$;

CREATE FUNCTION collab.reassign_task(task uuid, target text, expected_version integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t collab.tasks; p collab.projects; r collab.runs;
BEGIN
  SELECT * INTO t FROM collab.tasks WHERE id=task;
  IF t.id IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
  p := collab.require_project_management(t.project_id);
  PERFORM pg_advisory_xact_lock(hashtextextended(task::text,820));
  -- Match executor lock order (run before task), avoiding a finish/reassign deadlock.
  PERFORM 1 FROM collab.runs WHERE task_id=task AND status IN ('queued','starting','running','waiting_input','stopping','reconciling') ORDER BY id FOR UPDATE;
  SELECT * INTO t FROM collab.tasks WHERE id=task FOR UPDATE;
  IF expected_version IS NULL OR expected_version<>t.version THEN RAISE EXCEPTION 'stale_revision' USING ERRCODE='P0001'; END IF;
  IF NOT EXISTS(SELECT 1 FROM collab.project_memberships pm JOIN collab.memberships m ON m.organization_id=pm.organization_id AND m.user_id=pm.user_id WHERE pm.project_id=p.id AND pm.user_id=target AND pm.active AND m.active AND pm.role IN ('maintainer','developer'))
    THEN RAISE EXCEPTION 'invalid_owner' USING ERRCODE='P0001'; END IF;
  IF t.owner_id=target THEN RETURN jsonb_build_object('taskId',task,'changed',false); END IF;
  -- Retain the old run identity/workspace. Assignment never hands a live process
  -- or an old model capability to the new owner.
  FOR r IN SELECT * FROM collab.runs WHERE task_id=task AND status IN ('queued','starting','running','waiting_input') ORDER BY id LOOP
    PERFORM collab_worker.request_stop(r.id,'task_reassigned');
  END LOOP;
  UPDATE collab.tasks SET owner_id=target,version=version+1,updated_at=now() WHERE id=task;
  INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(p.organization_id,p.id,collab.actor(),'task.reassigned',task::text,jsonb_build_object('previousOwner',t.owner_id,'ownerId',target));
  RETURN jsonb_build_object('taskId',task,'changed',true);
END
$$;

REVOKE EXECUTE ON FUNCTION collab.guard_project_member(),collab.require_project_management(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION collab_worker.project_member_changed(),collab_worker.bind_project_authorization() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION collab.add_project_member(uuid,text,text),collab.change_project_member(uuid,text,text,boolean,bigint),collab.project_governance(uuid),collab.recover_project(uuid,text),collab.reassign_task(uuid,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.add_project_member(uuid,text,text),collab.change_project_member(uuid,text,text,boolean,bigint),collab.project_governance(uuid),collab.recover_project(uuid,text),collab.reassign_task(uuid,text,integer) TO pi_collab_app;

-- Invitation acceptance must share the new project-membership boundary.
CREATE OR REPLACE FUNCTION collab.accept_invitation(token text, user_name text, user_email text, password_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE invite collab.invitations; target_user text; issuer_role text; actor text := collab.actor();
BEGIN
  SELECT * INTO invite FROM collab.invitations WHERE token_hash=token;
  IF NOT FOUND OR invite.accepted_at IS NOT NULL OR invite.revoked_at IS NOT NULL OR invite.expires_at<=now()
    THEN RAISE EXCEPTION 'invitation_unavailable' USING ERRCODE='P0001'; END IF;
  IF lower(user_email) <> invite.email THEN RAISE EXCEPTION 'invitation_email_mismatch' USING ERRCODE='P0001'; END IF;
  -- Serialize acceptance with issuer demotion/deactivation.
  PERFORM pg_advisory_xact_lock(hashtextextended(invite.organization_id::text,811));
  -- Project membership revocation also locks the organization before invitations.
  -- Re-read under the row lock only after acquiring that shared lock order.
  SELECT * INTO invite FROM collab.invitations WHERE token_hash=token FOR UPDATE;
  IF NOT FOUND OR invite.accepted_at IS NOT NULL OR invite.revoked_at IS NOT NULL OR invite.expires_at<=now()
    THEN RAISE EXCEPTION 'invitation_unavailable' USING ERRCODE='P0001'; END IF;
  SELECT role INTO issuer_role FROM collab.memberships WHERE organization_id=invite.organization_id AND user_id=invite.invited_by AND active;
  IF issuer_role IS NULL OR issuer_role NOT IN ('owner','admin') OR (invite.role='admin' AND issuer_role<>'owner')
    THEN RAISE EXCEPTION 'inviter_no_longer_authorized' USING ERRCODE='P0001'; END IF;
  IF invite.project_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM collab.project_memberships WHERE project_id=invite.project_id AND user_id=invite.invited_by AND role='maintainer' AND active
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
    IF EXISTS(SELECT 1 FROM collab.project_memberships WHERE project_id=invite.project_id AND user_id=target_user AND NOT active)
      THEN RAISE EXCEPTION 'project_membership_disabled' USING ERRCODE='P0001'; END IF;
    INSERT INTO collab.project_memberships(organization_id,project_id,user_id,role)
      VALUES(invite.organization_id,invite.project_id,target_user,invite.project_role) ON CONFLICT DO NOTHING;
  END IF;
  UPDATE collab.invitations SET accepted_at=now() WHERE id=invite.id;
  INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail)
    VALUES(invite.organization_id,invite.project_id,target_user,'invitation.accepted',invite.id::text,jsonb_build_object('invitedBy',invite.invited_by));
  RETURN jsonb_build_object('userId',target_user,'organizationId',invite.organization_id,'projectId',invite.project_id);
END
$$;

-- Task ownership changes must pass through stop/reassignment protocol, even if
-- application code accidentally attempts a direct UPDATE.
REVOKE UPDATE ON collab.tasks FROM pi_collab_app;
GRANT UPDATE(title,description,acceptance,status,version,updated_at) ON collab.tasks TO pi_collab_app;
DROP POLICY tasks_create ON collab.tasks;
CREATE POLICY tasks_create ON collab.tasks FOR INSERT WITH CHECK(
  created_by=collab.actor() AND (collab.project_role(project_id)='maintainer' OR (collab.project_role(project_id)='developer' AND owner_id=collab.actor()))
  AND EXISTS(SELECT 1 FROM collab.project_memberships pm JOIN collab.memberships m ON m.organization_id=pm.organization_id AND m.user_id=pm.user_id
    WHERE pm.project_id=tasks.project_id AND pm.user_id=tasks.owner_id AND pm.active AND m.active AND pm.role IN ('developer','maintainer'))
);
