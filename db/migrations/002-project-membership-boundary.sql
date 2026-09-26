-- A creator may only see the project before its first membership is installed
-- in the same creation transaction. Removing membership must revoke content access.
CREATE OR REPLACE FUNCTION collab.is_project_creator(project uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS(SELECT 1 FROM collab.projects p WHERE p.id=project AND p.created_by=collab.actor()
    AND collab.org_role(p.organization_id) IN ('owner','admin')
    AND NOT EXISTS(SELECT 1 FROM collab.project_memberships pm WHERE pm.project_id=project))
$$;
