-- 076: per-user local bindings + per-document local write-back for unbound projects.
--
-- 1) Bindings become per-user. Agent operations run inside asUser(<the user's id>),
--    so an agent acting for a user automatically inherits that user's binding;
--    no separate agent identity is needed.
ALTER TABLE collab.project_local_bindings ADD COLUMN owner_user_id text;
UPDATE collab.project_local_bindings SET owner_user_id = created_by WHERE owner_user_id IS NULL;
ALTER TABLE collab.project_local_bindings ALTER COLUMN owner_user_id SET NOT NULL;
-- created_by stays as audit info; the new uniqueness is (project, owner).
ALTER TABLE collab.project_local_bindings DROP CONSTRAINT IF EXISTS project_local_bindings_project_id_key;
ALTER TABLE collab.project_local_bindings
  ADD CONSTRAINT project_local_bindings_project_owner_uniq UNIQUE (project_id, owner_user_id);
-- The global one-directory-one-project rule stays (project_local_bindings_path_uniq):
-- two writers to the same files would silently clobber each other's baselines.

CREATE OR REPLACE FUNCTION collab.set_project_local_binding(project uuid, target_path text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE org uuid; new_binding_id uuid; previous_path text; owner text;
BEGIN
 IF project IS NULL OR target_path IS NULL OR target_path = '' OR length(target_path) > 4096 THEN
  RAISE EXCEPTION 'invalid_local_binding' USING ERRCODE='P0001';
 END IF;
 IF collab.project_role(project) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 IF collab.project_role(project) NOT IN ('developer','maintainer') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF collab.user_requires_mfa(collab.actor()) AND NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
 owner := collab.actor();
 SELECT organization_id INTO STRICT org FROM collab.projects WHERE id=project;
 PERFORM pg_advisory_xact_lock(hashtextextended(project::text, 815));
 IF EXISTS (SELECT 1 FROM collab.project_local_bindings b WHERE b.local_path = target_path AND NOT (b.project_id = project AND b.owner_user_id = owner)) THEN
  RAISE EXCEPTION 'local_binding_conflict' USING ERRCODE='P0001';
 END IF;
 SELECT b.local_path INTO previous_path FROM collab.project_local_bindings b WHERE b.project_id = project AND b.owner_user_id = owner;
 INSERT INTO collab.project_local_bindings(project_id, local_path, created_by, owner_user_id)
 VALUES(project, target_path, owner, owner)
 ON CONFLICT ON CONSTRAINT project_local_bindings_project_owner_uniq
 DO UPDATE SET local_path=EXCLUDED.local_path, updated_at=now()
 RETURNING id INTO new_binding_id;
 -- A changed target invalidates per-file baselines; the next save re-derives
 -- them from the import-time content instead of risking a stale ancestor.
 IF previous_path IS DISTINCT FROM target_path THEN
  DELETE FROM collab.local_writeback_state WHERE local_writeback_state.binding_id = new_binding_id;
 END IF;
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail)
 VALUES(org, project, owner, 'project.local_bound', new_binding_id, jsonb_build_object('localPath', target_path));
 RETURN jsonb_build_object('id', new_binding_id, 'projectId', project, 'localPath', target_path);
END $$;
REVOKE ALL ON FUNCTION collab.set_project_local_binding(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.set_project_local_binding(uuid,text) TO pi_collab_app;

CREATE OR REPLACE FUNCTION collab.remove_project_local_binding(project uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE org uuid; binding_id uuid;
BEGIN
 IF collab.project_role(project) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 IF collab.project_role(project) NOT IN ('developer','maintainer') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF collab.user_requires_mfa(collab.actor()) AND NOT collab.actor_has_mfa() THEN
  RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001';
 END IF;
 SELECT organization_id INTO STRICT org FROM collab.projects WHERE id=project;
 PERFORM pg_advisory_xact_lock(hashtextextended(project::text, 815));
 SELECT b.id INTO binding_id FROM collab.project_local_bindings b WHERE b.project_id = project AND b.owner_user_id = collab.actor();
 IF binding_id IS NULL THEN RETURN; END IF;
 DELETE FROM collab.project_local_bindings WHERE id = binding_id;
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail)
 VALUES(org, project, collab.actor(), 'project.local_unbound', binding_id, '{}');
END $$;
REVOKE ALL ON FUNCTION collab.remove_project_local_binding(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.remove_project_local_binding(uuid) TO pi_collab_app;

-- 2) Per-document local backing for projects without a binding.
-- A document with local_path set is "local-backed": saves write straight to
-- that file with the same three-way merge semantics. A document without one
-- is a pure shared draft; the UI offers "save as to local" for it.
ALTER TABLE collab.editor_documents
  ADD COLUMN local_path text CHECK (local_path IS NULL OR (local_path <> '' AND length(local_path) <= 4096));

-- Per-document write-back baseline, mirroring collab.local_writeback_state
-- (which stays keyed by project binding).
CREATE TABLE collab.document_writeback_state (
 document_id uuid PRIMARY KEY REFERENCES collab.editor_documents(id) ON DELETE CASCADE,
 content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
 written_content bytea,
 updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE collab.document_writeback_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY document_writeback_state_read ON collab.document_writeback_state FOR SELECT USING(
 EXISTS (SELECT 1 FROM collab.editor_documents d JOIN collab.editor_sessions s ON s.id = d.session_id
         WHERE d.id = document_writeback_state.document_id AND collab.project_role(s.project_id) IS NOT NULL)
);
GRANT SELECT ON collab.document_writeback_state TO pi_collab_app;

-- Associate (or re-associate) a document with a local file. Changing the path
-- invalidates the baseline, like a binding target change does.
CREATE FUNCTION collab.set_document_local_path(doc uuid, target_path text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE sess collab.editor_sessions; role text; previous_path text;
BEGIN
 IF doc IS NULL OR target_path IS NULL OR target_path = '' OR length(target_path) > 4096 THEN
  RAISE EXCEPTION 'invalid_document_local_path' USING ERRCODE='P0001';
 END IF;
 SELECT s.* INTO sess FROM collab.editor_documents d JOIN collab.editor_sessions s ON s.id = d.session_id WHERE d.id = doc;
 IF sess.id IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 role := collab.project_role(sess.project_id);
 IF role IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 IF role NOT IN ('developer','maintainer') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF collab.user_requires_mfa(collab.actor()) AND NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(doc::text, 816));
 SELECT d.local_path INTO previous_path FROM collab.editor_documents d WHERE d.id = doc;
 UPDATE collab.editor_documents SET local_path = target_path WHERE id = doc;
 IF previous_path IS DISTINCT FROM target_path THEN
  DELETE FROM collab.document_writeback_state WHERE document_writeback_state.document_id = doc;
 END IF;
END $$;
REVOKE ALL ON FUNCTION collab.set_document_local_path(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.set_document_local_path(uuid,text) TO pi_collab_app;

CREATE FUNCTION collab.record_document_writeback(doc uuid, sha text, content bytea)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE proj uuid;
BEGIN
 SELECT s.project_id INTO STRICT proj FROM collab.editor_documents d JOIN collab.editor_sessions s ON s.id = d.session_id WHERE d.id = doc;
 IF collab.project_role(proj) NOT IN ('developer','maintainer') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF sha IS NULL OR sha !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'invalid_document_writeback' USING ERRCODE='P0001'; END IF;
 INSERT INTO collab.document_writeback_state(document_id, content_sha256, written_content, updated_at)
 VALUES(doc, sha, content, now())
 ON CONFLICT (document_id) DO UPDATE SET content_sha256=EXCLUDED.content_sha256, written_content=EXCLUDED.written_content, updated_at=now();
END $$;
REVOKE ALL ON FUNCTION collab.record_document_writeback(uuid,text,bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.record_document_writeback(uuid,text,bytea) TO pi_collab_app;

CREATE FUNCTION collab.clear_document_writeback(doc uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE proj uuid;
BEGIN
 SELECT s.project_id INTO STRICT proj FROM collab.editor_documents d JOIN collab.editor_sessions s ON s.id = d.session_id WHERE d.id = doc;
 IF collab.project_role(proj) NOT IN ('developer','maintainer') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 DELETE FROM collab.document_writeback_state WHERE document_writeback_state.document_id = doc;
END $$;
REVOKE ALL ON FUNCTION collab.clear_document_writeback(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.clear_document_writeback(uuid) TO pi_collab_app;
