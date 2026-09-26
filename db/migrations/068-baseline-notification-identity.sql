-- A baseline can originate from a local promotion OR a GitHub sync. The
-- promotion id is NULL for syncs; using it as the notification key aborts the
-- baseline transaction whenever an affected task has a notification recipient.
-- Use the baseline's primary key for both sources, keeping replay deduplicated.
CREATE OR REPLACE FUNCTION collab.baseline_notification() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE task uuid;
BEGIN
 FOR task IN SELECT DISTINCT t.id FROM collab.tasks t WHERE t.project_id=NEW.project_id AND (
  EXISTS(SELECT 1 FROM collab.integration_sources s JOIN collab.promotions p ON p.integration_id=s.integration_id WHERE p.id=NEW.promotion_id AND s.task_id=t.id)
  OR (t.status NOT IN ('done','cancelled') AND EXISTS(SELECT 1 FROM collab.runs r JOIN collab.workspaces w ON w.id=r.workspace_id WHERE r.task_id=t.id AND w.repository_id=NEW.repository_id))) LOOP
  PERFORM collab.notify_task(task,NULL,'repository.baseline','baseline:'||NEW.project_id::text||':'||NEW.sequence::text||':'||task::text);
 END LOOP;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION collab.baseline_notification() FROM PUBLIC;
