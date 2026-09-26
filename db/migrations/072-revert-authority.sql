-- A moved base invalidates queued and active revert runs before dispatch, using
-- the same revocation path as other pinned inputs rather than poisoning claims.
ALTER FUNCTION collab_worker.authorized(uuid) RENAME TO authorized_v71;
CREATE FUNCTION collab_worker.authorized(run uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT collab_worker.authorized_v71(run) AND NOT EXISTS(
  SELECT 1 FROM collab.runs r JOIN collab.revert_tasks rt ON rt.task_id=r.task_id JOIN collab.repositories repo ON repo.id=rt.repository_id
  WHERE r.id=run AND rt.target_sha<>repo.base_sha)
$$;
REVOKE ALL ON FUNCTION collab_worker.authorized(uuid) FROM PUBLIC;
