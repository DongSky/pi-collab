CREATE TABLE collab.imported_histories (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES collab.organizations(id),
 project_id uuid NOT NULL REFERENCES collab.projects(id),
 owner_id text NOT NULL REFERENCES public."user"(id),
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
 messages jsonb NOT NULL CHECK(jsonb_typeof(messages)='array' AND jsonb_array_length(messages) BETWEEN 1 AND 200 AND octet_length(messages::text)<=500000),
 content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 shared boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(project_id,owner_id,content_hash,shared)
);
ALTER TABLE collab.imported_histories ENABLE ROW LEVEL SECURITY;
CREATE POLICY history_read ON collab.imported_histories FOR SELECT USING(collab.project_role(project_id) IS NOT NULL AND (owner_id=collab.actor() OR shared));
CREATE POLICY history_insert ON collab.imported_histories FOR INSERT WITH CHECK(
 collab.project_role(project_id) IN ('maintainer','developer') AND collab.actor_has_mfa()
 AND owner_id=collab.actor() AND organization_id=(SELECT p.organization_id FROM collab.projects p WHERE p.id=project_id));
CREATE POLICY history_delete ON collab.imported_histories FOR DELETE USING(
 collab.project_role(project_id) IS NOT NULL AND collab.actor_has_mfa() AND owner_id=collab.actor());
GRANT SELECT,INSERT,DELETE ON collab.imported_histories TO pi_collab_app;
CREATE INDEX imported_history_listing ON collab.imported_histories(project_id,created_at DESC,id DESC);
