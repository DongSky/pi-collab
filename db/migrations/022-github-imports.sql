-- An admission precedes any network/filesystem work. Repository identity is
-- reserved once; abandoned imports never reuse another writer's directory.
CREATE TABLE collab.github_imports (
 id uuid PRIMARY KEY, repository_id uuid NOT NULL UNIQUE,
 organization_id uuid NOT NULL, project_id uuid NOT NULL, connection_id uuid NOT NULL,
 github_repository_id text NOT NULL CHECK(github_repository_id~'^[1-9][0-9]{0,15}$'),
 actor_id text NOT NULL REFERENCES public."user"(id), idempotency_key uuid NOT NULL,
 organization_version bigint NOT NULL, project_version bigint NOT NULL, installation_version bigint NOT NULL,
 request jsonb NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','fetching','completed','failed')),
 evidence jsonb, failure text, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 UNIQUE(project_id,actor_id,idempotency_key),
 FOREIGN KEY(organization_id,project_id) REFERENCES collab.projects(organization_id,id),
 FOREIGN KEY(organization_id,connection_id) REFERENCES collab.github_installations(organization_id,id),
 CHECK((status='completed')=(evidence IS NOT NULL)),
 CHECK((status IN ('completed','failed'))=(finished_at IS NOT NULL))
);
CREATE UNIQUE INDEX github_import_remote_occupied ON collab.github_imports(github_repository_id) WHERE status<>'failed';
ALTER TABLE collab.github_imports ENABLE ROW LEVEL SECURITY;
CREATE POLICY github_import_read ON collab.github_imports FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
GRANT SELECT ON collab.github_imports TO pi_collab_app;
