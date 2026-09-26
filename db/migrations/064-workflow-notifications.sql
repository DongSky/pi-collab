-- Personal quiet periods affect attention badges, never delivery or authorization.
CREATE TABLE collab.notification_preferences (
 user_id text PRIMARY KEY REFERENCES public."user"(id),
 quiet_until timestamptz,
 version integer NOT NULL DEFAULT 1 CHECK(version>0)
);
ALTER TABLE collab.notification_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY notification_preferences_read ON collab.notification_preferences FOR SELECT USING(user_id=collab.actor());
GRANT SELECT ON collab.notification_preferences TO pi_collab_app;
CREATE FUNCTION collab.set_notification_quiet(expected integer, until_time timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE current_version integer;
BEGIN
 IF collab.actor() IS NULL OR NOT EXISTS(SELECT 1 FROM public."user" WHERE id=collab.actor()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF expected IS NULL OR expected<0 OR (until_time IS NOT NULL AND (until_time<=now() OR until_time>now()+interval '30 days')) THEN RAISE EXCEPTION 'invalid_notification_preferences' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(collab.actor(),1064));
 SELECT version INTO current_version FROM collab.notification_preferences WHERE user_id=collab.actor();
 IF coalesce(current_version,0)<>expected THEN RAISE EXCEPTION 'stale_notification_preferences' USING ERRCODE='P0001'; END IF;
 INSERT INTO collab.notification_preferences(user_id,quiet_until) VALUES(collab.actor(),until_time)
 ON CONFLICT(user_id) DO UPDATE SET quiet_until=EXCLUDED.quiet_until,version=notification_preferences.version+1;
END $$;
REVOKE ALL ON FUNCTION collab.set_notification_quiet(integer,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.set_notification_quiet(integer,timestamptz) TO pi_collab_app;

-- Reviewers can discover review work without already subscribing to its task.
-- An explicit unsubscribe still suppresses these role-based notifications.
CREATE OR REPLACE FUNCTION collab.notify_task(task uuid, who text, event_kind text, event text, thread uuid DEFAULT NULL, mentioned text[] DEFAULT '{}') RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 INSERT INTO collab.inbox(organization_id,project_id,task_id,recipient_id,actor_id,kind,thread_id,event_key)
 SELECT t.organization_id,t.project_id,t.id,pm.user_id,who,
   CASE WHEN event_kind='discussion.message' AND pm.user_id=ANY(mentioned) THEN 'mention' ELSE event_kind END,thread,event
 FROM collab.tasks t JOIN collab.project_memberships pm ON pm.project_id=t.project_id AND pm.active
 JOIN collab.memberships m ON m.organization_id=pm.organization_id AND m.user_id=pm.user_id AND m.active
 LEFT JOIN collab.task_subscriptions s ON s.task_id=t.id AND s.user_id=pm.user_id
 WHERE t.id=task AND pm.user_id IS DISTINCT FROM who AND
 (pm.user_id=ANY(mentioned) OR s.enabled OR (s.enabled IS NULL AND pm.user_id=t.owner_id)
  OR (event_kind IN ('task.review_requested','pull.ready','integration.checked','gitlab.ready')
      AND pm.role IN ('reviewer','maintainer') AND pm.user_id<>t.owner_id AND s.enabled IS DISTINCT FROM false))
 ON CONFLICT(recipient_id,event_key) DO NOTHING
$$;

CREATE FUNCTION collab.control_notification() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE task uuid; controller text;
BEGIN
 IF TG_OP='UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
 SELECT r.task_id,c.controller_id INTO task,controller FROM collab.runs r JOIN collab.run_controls c ON c.run_id=r.id WHERE r.id=NEW.run_id;
 IF NEW.status='pending' THEN
  PERFORM collab.notify_task(task,NEW.requester_id,'control.requested','control:'||NEW.id::text||':pending',NULL,ARRAY[controller]);
 ELSIF NEW.status IN ('accepted','rejected','expired') THEN
  PERFORM collab.notify_task(task,NEW.handled_by,'control.'||NEW.status,'control:'||NEW.id::text||':'||NEW.status,NULL,ARRAY[NEW.requester_id]);
 ELSIF NEW.status='withdrawn' THEN
  PERFORM collab.notify_task(task,NEW.requester_id,'control.withdrawn','control:'||NEW.id::text||':withdrawn',NULL,ARRAY[controller]);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER control_notification AFTER INSERT OR UPDATE OF status ON collab.control_requests FOR EACH ROW EXECUTE FUNCTION collab.control_notification();

CREATE FUNCTION collab.task_review_notification() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.status='in_review' AND NEW.status IS DISTINCT FROM OLD.status THEN
  PERFORM collab.notify_task(NEW.id,nullif(collab.actor(),''),'task.review_requested','task-review:'||NEW.id::text||':'||NEW.version::text);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER task_review_notification AFTER UPDATE OF status ON collab.tasks FOR EACH ROW EXECUTE FUNCTION collab.task_review_notification();

CREATE OR REPLACE FUNCTION collab.discussion_run_notification() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE controller text;
BEGIN
 IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('completed','failed','cancelled','reconciling','waiting_input') THEN
  SELECT controller_id INTO controller FROM collab.run_controls WHERE run_id=NEW.id;
  PERFORM collab.notify_task(NEW.task_id,NULL,'run.'||NEW.status,'run:'||NEW.id::text||':'||NEW.revision::text,NULL,ARRAY[NEW.requested_by,controller]);
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION collab.pull_checks_notification() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE rule jsonb;
BEGIN
 IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
 IF NEW.status='observed' THEN
  -- The same required check reread by a new observation job does not notify twice.
  FOR rule IN SELECT value FROM jsonb_array_elements(collab_git.checks_verdict(NEW.admission->'policy'->'config',NEW.evidence->'checks')) WHERE value->>'state'='failed' LOOP
   PERFORM collab.notify_task(NEW.task_id,NULL,'ci.failed','ci:'||NEW.revision_id::text||':'||(NEW.admission->'policy'->>'id')||':'||(rule->>'checkId'),NULL,ARRAY[NEW.actor_id]);
  END LOOP;
 ELSIF NEW.status='failed' THEN
  PERFORM collab.notify_task(NEW.task_id,NULL,'ci.unavailable','ci-reader:'||NEW.id::text,NULL,ARRAY[NEW.actor_id]);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pull_checks_notification AFTER UPDATE OF status ON collab_git.pull_checks_jobs FOR EACH ROW EXECUTE FUNCTION collab.pull_checks_notification();

CREATE FUNCTION collab.integration_notification() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE source record;
BEGIN
 IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('checked','conflicted','check_failed','unknown') THEN
  FOR source IN SELECT task_id FROM collab.integration_sources WHERE integration_id=NEW.id LOOP
   PERFORM collab.notify_task(source.task_id,NULL,'integration.'||NEW.status,'integration:'||NEW.id::text||':'||NEW.status||':'||source.task_id::text,NULL,ARRAY[NEW.requested_by]);
  END LOOP;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER integration_notification AFTER UPDATE OF status ON collab.integrations FOR EACH ROW EXECUTE FUNCTION collab.integration_notification();

CREATE FUNCTION collab.baseline_notification() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE task uuid;
BEGIN
 -- All affected task owners/subscribers can discover the new baseline. No AI
 -- instruction, workspace rewrite, or implicit rebase is created by notification.
 FOR task IN SELECT DISTINCT t.id FROM collab.tasks t WHERE t.project_id=NEW.project_id AND (
  EXISTS(SELECT 1 FROM collab.integration_sources s JOIN collab.promotions p ON p.integration_id=s.integration_id WHERE p.id=NEW.promotion_id AND s.task_id=t.id)
  OR (t.status NOT IN ('done','cancelled') AND EXISTS(SELECT 1 FROM collab.runs r JOIN collab.workspaces w ON w.id=r.workspace_id WHERE r.task_id=t.id AND w.repository_id=NEW.repository_id))) LOOP
  PERFORM collab.notify_task(task,NULL,'repository.baseline','baseline:'||NEW.promotion_id::text||':'||task::text);
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER baseline_notification AFTER INSERT ON collab.repository_baselines FOR EACH ROW EXECUTE FUNCTION collab.baseline_notification();

CREATE FUNCTION collab.gitlab_notification() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE task uuid; pipeline jsonb;
BEGIN
 IF NEW.status IS NOT DISTINCT FROM OLD.status OR NEW.result_id IS NULL THEN RETURN NEW; END IF;
 SELECT task_id INTO task FROM collab.task_results WHERE id=NEW.result_id AND project_id=NEW.project_id;
 IF NEW.status='completed' THEN
  IF NEW.kind IN ('ready','merge') THEN
   PERFORM collab.notify_task(task,NULL,CASE NEW.kind WHEN 'ready' THEN 'gitlab.ready' ELSE 'gitlab.merged' END,'gitlab:'||NEW.id::text,NULL,ARRAY[NEW.actor_id]);
  END IF;
  pipeline:=NEW.result->'mr'->'head_pipeline';
  IF NEW.kind IN ('observe','ready','merge') AND pipeline->>'sha'=NEW.result->>'commitSha' AND pipeline->>'status' IN ('failed','canceled') THEN
   PERFORM collab.notify_task(task,NULL,'gitlab.ci_failed','gitlab-ci:'||NEW.connection_id::text||':'||(pipeline->>'id')||':'||task::text,NULL,ARRAY[NEW.actor_id]);
  END IF;
 ELSIF NEW.status IN ('failed','uncertain') THEN
  PERFORM collab.notify_task(task,NULL,'gitlab.'||NEW.status,'gitlab:'||NEW.id::text||':'||NEW.status,NULL,ARRAY[NEW.actor_id]);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER gitlab_notification AFTER UPDATE OF status ON collab.gitlab_operations FOR EACH ROW EXECUTE FUNCTION collab.gitlab_notification();
REVOKE ALL ON FUNCTION collab.control_notification(),collab.task_review_notification(),collab.pull_checks_notification(),collab.integration_notification(),collab.baseline_notification(),collab.gitlab_notification() FROM PUBLIC;
