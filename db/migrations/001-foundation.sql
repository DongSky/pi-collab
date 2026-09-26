CREATE SCHEMA IF NOT EXISTS collab;
REVOKE ALL ON SCHEMA collab FROM PUBLIC;
GRANT USAGE ON SCHEMA collab TO pi_collab_app;

CREATE FUNCTION collab.actor() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('collab.user_id', true), '')
$$;

CREATE TABLE collab.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  created_by text NOT NULL REFERENCES public."user"(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE collab.memberships (
  organization_id uuid NOT NULL REFERENCES collab.organizations(id),
  user_id text NOT NULL REFERENCES public."user"(id),
  role text NOT NULL CHECK (role IN ('owner','admin','member')),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY(organization_id, user_id)
);
CREATE TABLE collab.projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES collab.organizations(id),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120), description text NOT NULL DEFAULT '',
  created_by text NOT NULL REFERENCES public."user"(id), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,id)
);
CREATE TABLE collab.project_memberships (
  organization_id uuid NOT NULL, project_id uuid NOT NULL, user_id text NOT NULL,
  role text NOT NULL CHECK(role IN ('maintainer','developer','reviewer','viewer')),
  PRIMARY KEY(project_id,user_id),
  FOREIGN KEY(organization_id,project_id) REFERENCES collab.projects(organization_id,id),
  FOREIGN KEY(organization_id,user_id) REFERENCES collab.memberships(organization_id,user_id)
);
CREATE TABLE collab.tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, project_id uuid NOT NULL,
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200), description text NOT NULL DEFAULT '',
  acceptance text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','ready','in_progress','in_review','ready_to_merge','done','blocked','cancelled')),
  owner_id text NOT NULL, created_by text NOT NULL REFERENCES public."user"(id),
  version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,project_id,id),
  FOREIGN KEY(organization_id,project_id) REFERENCES collab.projects(organization_id,id),
  FOREIGN KEY(project_id,owner_id) REFERENCES collab.project_memberships(project_id,user_id)
);
CREATE TABLE collab.task_dependencies (
  organization_id uuid NOT NULL, project_id uuid NOT NULL, task_id uuid NOT NULL, depends_on uuid NOT NULL,
  kind text NOT NULL DEFAULT 'strict' CHECK(kind IN ('strict','soft')),
  PRIMARY KEY(task_id,depends_on), CHECK(task_id <> depends_on),
  FOREIGN KEY(organization_id,project_id,task_id) REFERENCES collab.tasks(organization_id,project_id,id),
  FOREIGN KEY(organization_id,project_id,depends_on) REFERENCES collab.tasks(organization_id,project_id,id)
);
CREATE TABLE collab.audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, organization_id uuid NOT NULL REFERENCES collab.organizations(id),
  project_id uuid, actor_id text NOT NULL REFERENCES public."user"(id),
  action text NOT NULL, resource_id text, detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(organization_id,project_id) REFERENCES collab.projects(organization_id,id)
);
CREATE TABLE collab.installation (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  bootstrap_hash text NOT NULL, initialized_at timestamptz
);

-- Read-only policy helpers are owned by the migration role. They avoid recursive
-- membership RLS, expose only the current actor's role, and have a pinned search_path.
CREATE FUNCTION collab.org_role(org uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT role FROM collab.memberships WHERE organization_id=org AND user_id=collab.actor() AND active
$$;
CREATE FUNCTION collab.project_role(project uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT pm.role FROM collab.project_memberships pm JOIN collab.memberships m
  ON m.organization_id=pm.organization_id AND m.user_id=pm.user_id
  WHERE pm.project_id=project AND pm.user_id=collab.actor() AND m.active
$$;
CREATE FUNCTION collab.is_org_creator(org uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS(SELECT 1 FROM collab.organizations o WHERE o.id=org AND o.created_by=collab.actor())
$$;
CREATE FUNCTION collab.is_project_creator(project uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS(SELECT 1 FROM collab.projects p WHERE p.id=project AND p.created_by=collab.actor() AND collab.org_role(p.organization_id) IN ('owner','admin'))
$$;

ALTER TABLE collab.organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY organizations_read ON collab.organizations FOR SELECT USING(collab.org_role(id) IS NOT NULL);
-- Organization provisioning is deliberately not granted to the web role.
ALTER TABLE collab.memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY memberships_read ON collab.memberships FOR SELECT USING(collab.org_role(organization_id) IS NOT NULL);
ALTER TABLE collab.projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY projects_read ON collab.projects FOR SELECT USING(collab.project_role(id) IS NOT NULL OR collab.is_project_creator(id));
CREATE POLICY projects_create ON collab.projects FOR INSERT WITH CHECK(collab.org_role(organization_id) IN ('owner','admin') AND created_by=collab.actor());
ALTER TABLE collab.project_memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY project_memberships_read ON collab.project_memberships FOR SELECT USING(collab.project_role(project_id) IS NOT NULL OR collab.is_project_creator(project_id));
CREATE POLICY project_memberships_create ON collab.project_memberships FOR INSERT WITH CHECK(
  collab.project_role(project_id)='maintainer' OR (collab.is_project_creator(project_id) AND user_id=collab.actor() AND role='maintainer')
);
ALTER TABLE collab.tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY tasks_read ON collab.tasks FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
CREATE POLICY tasks_create ON collab.tasks FOR INSERT WITH CHECK(collab.project_role(project_id) IN ('maintainer','developer') AND created_by=collab.actor());
CREATE POLICY tasks_update ON collab.tasks FOR UPDATE USING(collab.project_role(project_id)='maintainer' OR (collab.project_role(project_id)='developer' AND owner_id=collab.actor()))
  WITH CHECK(collab.project_role(project_id)='maintainer' OR (collab.project_role(project_id)='developer' AND owner_id=collab.actor()));
ALTER TABLE collab.task_dependencies ENABLE ROW LEVEL SECURITY;
CREATE POLICY dependencies_read ON collab.task_dependencies FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
CREATE POLICY dependencies_create ON collab.task_dependencies FOR INSERT WITH CHECK(collab.project_role(project_id) IN ('maintainer','developer'));
CREATE POLICY dependencies_delete ON collab.task_dependencies FOR DELETE USING(collab.project_role(project_id) IN ('maintainer','developer'));
ALTER TABLE collab.audit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_read ON collab.audit_events FOR SELECT USING(
  (project_id IS NOT NULL AND collab.project_role(project_id) IS NOT NULL)
  OR (project_id IS NULL AND collab.org_role(organization_id) IN ('owner','admin'))
);
CREATE POLICY audit_append ON collab.audit_events FOR INSERT WITH CHECK(actor_id=collab.actor() AND collab.org_role(organization_id) IS NOT NULL AND (project_id IS NULL OR collab.project_role(project_id) IS NOT NULL));

GRANT SELECT ON collab.organizations,collab.memberships TO pi_collab_app;
GRANT SELECT,INSERT ON collab.projects,collab.project_memberships TO pi_collab_app;
GRANT SELECT,INSERT,UPDATE ON collab.tasks TO pi_collab_app;
GRANT SELECT,INSERT,DELETE ON collab.task_dependencies TO pi_collab_app;
GRANT SELECT,INSERT ON collab.audit_events TO pi_collab_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA collab TO pi_collab_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA collab FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA collab TO pi_collab_app;

CREATE INDEX memberships_user ON collab.memberships(user_id) WHERE active;
CREATE INDEX project_memberships_user ON collab.project_memberships(user_id);
CREATE INDEX tasks_project ON collab.tasks(project_id,created_at DESC);
CREATE INDEX audit_project ON collab.audit_events(project_id,id DESC);
