-- Logical deletion retains evidence. Only the deleting owner may restore; no
-- membership or capability is resurrected for other users during restoration.
ALTER TABLE collab.organizations ADD COLUMN deleted_at timestamptz;
ALTER TABLE collab.organizations ADD COLUMN deleted_by text REFERENCES public."user"(id);
ALTER TABLE collab.organizations ADD COLUMN lifecycle_version bigint NOT NULL DEFAULT 1;

CREATE OR REPLACE FUNCTION collab.guard_last_owner() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(OLD.organization_id::text,811));
 IF OLD.role='owner' AND OLD.active AND (TG_OP='DELETE' OR NOT NEW.active OR NEW.role<>'owner')
  AND EXISTS(SELECT 1 FROM collab.organizations WHERE id=OLD.organization_id AND deleted_at IS NULL)
  AND NOT EXISTS(SELECT 1 FROM collab.memberships WHERE organization_id=OLD.organization_id AND user_id<>OLD.user_id AND active AND role='owner')
 THEN RAISE EXCEPTION 'last_owner' USING ERRCODE='P0001'; END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE FUNCTION collab.guard_deleted_membership() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text,811));
 IF NEW.active AND EXISTS(SELECT 1 FROM collab.organizations WHERE id=NEW.organization_id AND deleted_at IS NOT NULL)
 THEN RAISE EXCEPTION 'organization_deleted' USING ERRCODE='P0001'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER membership_deleted_guard BEFORE INSERT OR UPDATE ON collab.memberships FOR EACH ROW EXECUTE FUNCTION collab.guard_deleted_membership();

CREATE FUNCTION collab.deleted_organizations() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'deletedAt',deleted_at,'version',lifecycle_version::text) ORDER BY deleted_at DESC),'[]')
 FROM collab.organizations WHERE deleted_by=collab.actor() AND deleted_at IS NOT NULL
$$;

CREATE FUNCTION collab.organization_blockers(org uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE spec text[]; count_value bigint; result jsonb:='[]';
BEGIN
 IF collab.org_role(org) IS DISTINCT FROM 'owner' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 -- Queued work and uncertain side effects must be resolved before deletion.
 -- This includes credential-holding brokers, not just visible AI processes.
 FOREACH spec SLICE 1 IN ARRAY ARRAY[
 ['collab','runs','queued,starting,running,waiting_input,stopping,reconciling'],
 ['collab','workspaces','provisioning,busy,quarantined'],
 ['collab','snapshots','pending'],['collab','validations','queued,running,unknown'],
 ['collab','integrations','queued,integrating,checking,unknown'],
 ['collab','promotions','queued,preparing,applying,unknown,reconcile_queued,reconciling,blocked'],
 ['collab','github_imports','pending,fetching'],['collab','github_syncs','pending,fetching,applying,blocked'],
 ['collab','gitlab_operations','queued,running,uncertain'],
 ['collab','service_previews','queued,starting,ready,stopping,unknown'],
 ['collab','checkpoint_previews','preparing'],
 ['collab','resource_requests','waiting,granted,releasing'],['collab','resource_jobs','queued,running,unknown'],
 ['collab_git','workspace_operations','queued,running,attention'],
 ['collab_git','push_previews','queued,running'],['collab_git','push_confirmations','reserved,quarantined'],
 ['collab_git','push_deliveries','queued,running,unknown'],['collab_git','pull_proposals','queued,running'],
 ['collab_git','pull_deliveries','queued,running,unknown'],['collab_git','pull_observation_jobs','queued,running'],
 ['collab_git','pull_revision_jobs','queued,running'],['collab_git','pull_checks_jobs','queued,running'],
 ['collab_git','pull_releases','queued,running,unknown']
 ] LOOP
  EXECUTE format('SELECT count(*) FROM %I.%I WHERE organization_id=$1 AND status=ANY($2)',spec[1],spec[2]) INTO count_value USING org,string_to_array(spec[3],',');
  IF count_value>0 THEN result:=result||jsonb_build_array(jsonb_build_object('kind',spec[2],'count',count_value)); END IF;
 END LOOP;
 SELECT count(*) INTO count_value FROM collab_worker.artifact_cleanup c JOIN collab.projects p ON p.id=c.project_id WHERE p.organization_id=org AND c.status IN ('queued','deleting','attention');
 IF count_value>0 THEN result:=result||jsonb_build_array(jsonb_build_object('kind','artifact_cleanup','count',count_value)); END IF;
 SELECT count(*) INTO count_value FROM collab.workspace_environments WHERE organization_id=org AND state IN ('resetting','reclaiming');
 IF count_value>0 THEN result:=result||jsonb_build_array(jsonb_build_object('kind','workspace_environments','count',count_value)); END IF;
 RETURN result;
END $$;

CREATE FUNCTION collab.organization_lifecycle(org uuid, operation text, expected_version bigint, confirmation text, reason text, target text DEFAULT NULL, target_version bigint DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE o collab.organizations; member collab.memberships; blockers jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(org::text,811));
 SELECT * INTO o FROM collab.organizations WHERE id=org FOR UPDATE;
 IF o.id IS NULL OR (o.deleted_at IS NULL AND collab.org_role(org) IS DISTINCT FROM 'owner')
  OR (o.deleted_at IS NOT NULL AND o.deleted_by IS DISTINCT FROM collab.actor()) THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 IF NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
 IF expected_version IS DISTINCT FROM o.lifecycle_version THEN RAISE EXCEPTION 'stale_organization' USING ERRCODE='P0001'; END IF;
 IF confirmation IS DISTINCT FROM o.name OR reason IS NULL OR length(btrim(reason)) NOT BETWEEN 10 AND 2000 OR operation IS NULL OR operation NOT IN ('delete','restore','transfer') THEN RAISE EXCEPTION 'invalid_organization_action' USING ERRCODE='P0001'; END IF;
 IF operation='restore' THEN
  IF o.deleted_at IS NULL THEN RAISE EXCEPTION 'stale_organization' USING ERRCODE='P0001'; END IF;
  UPDATE collab.organizations SET deleted_at=NULL,deleted_by=NULL,lifecycle_version=lifecycle_version+1 WHERE id=org;
  UPDATE collab.memberships SET active=true,role='owner' WHERE organization_id=org AND user_id=collab.actor();
 ELSE
  IF o.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'organization_deleted' USING ERRCODE='P0001'; END IF;
  IF operation='transfer' THEN
   SELECT * INTO member FROM collab.memberships WHERE organization_id=org AND user_id=target FOR UPDATE;
   IF member.user_id IS NULL OR NOT member.active OR target=collab.actor() OR member.authorization_version IS DISTINCT FROM target_version THEN RAISE EXCEPTION 'stale_membership' USING ERRCODE='P0001'; END IF;
   PERFORM 1 FROM public."user" WHERE id=target AND "twoFactorEnabled" FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'transfer_mfa_required' USING ERRCODE='P0001'; END IF;
   -- Promote first inside this transaction; the last-owner guard stays enabled.
   PERFORM collab.change_member(org,target,'owner',true);
   PERFORM collab.change_member(org,collab.actor(),'admin',true);
   UPDATE collab.organizations SET lifecycle_version=lifecycle_version+1 WHERE id=org;
  ELSE
   blockers:=collab.organization_blockers(org);
   IF jsonb_array_length(blockers)>0 THEN RAISE EXCEPTION 'organization_busy' USING ERRCODE='P0001'; END IF;
   UPDATE collab.organizations SET deleted_at=clock_timestamp(),deleted_by=collab.actor(),lifecycle_version=lifecycle_version+1 WHERE id=org;
   UPDATE collab.invitations SET revoked_at=coalesce(revoked_at,now()) WHERE organization_id=org AND accepted_at IS NULL;
   UPDATE collab.memberships SET active=false WHERE organization_id=org;
   DELETE FROM public.session WHERE "userId" IN (SELECT user_id FROM collab.memberships WHERE organization_id=org);
   UPDATE collab.checkpoint_previews SET status='revoked' WHERE organization_id=org AND status='ready';
  END IF;
 END IF;
 INSERT INTO collab.audit_events(organization_id,actor_id,action,resource_id,detail) VALUES(org,collab.actor(),'organization.'||operation,org::text,jsonb_build_object('reason',btrim(reason),'previousVersion',o.lifecycle_version::text,'targetUserId',target));
 PERFORM pg_notify('pi_collab_authorization',json_build_object('organizationId',org)::text);
 RETURN jsonb_build_object('id',org,'operation',operation,'version',(o.lifecycle_version+1)::text);
END $$;
REVOKE ALL ON FUNCTION collab.guard_deleted_membership(),collab.deleted_organizations(),collab.organization_blockers(uuid),collab.organization_lifecycle(uuid,text,bigint,text,text,text,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.deleted_organizations(),collab.organization_blockers(uuid),collab.organization_lifecycle(uuid,text,bigint,text,text,text,bigint) TO pi_collab_app;
