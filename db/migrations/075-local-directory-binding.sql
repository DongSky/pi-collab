-- Persistent local directory binding ("direct-link" workspace mode).
-- A bound project writes saved editor content back to the linked local directory
-- with the same three-way merge semantics as collaborative saving, instead of
-- requiring the branch-based delivery flow to get changes out.
-- Imported copies (folder import) are untouched by this: they stay isolated
-- snapshots until a project is explicitly bound to a local directory.

CREATE TABLE collab.project_local_bindings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 project_id uuid NOT NULL UNIQUE REFERENCES collab.projects(id) ON DELETE CASCADE,
 local_path text NOT NULL CHECK (local_path <> '' AND length(local_path) <= 4096),
 created_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
-- One local directory serves at most one project: two projects writing back to
-- the same files would silently clobber each other's baselines.
CREATE UNIQUE INDEX project_local_bindings_path_uniq ON collab.project_local_bindings(local_path);
ALTER TABLE collab.project_local_bindings ENABLE ROW LEVEL SECURITY;
CREATE POLICY local_binding_read ON collab.project_local_bindings FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
GRANT SELECT ON collab.project_local_bindings TO pi_collab_app;

-- Per-file write-back baseline: the exact bytes the server last wrote to the
-- bound directory (NULL = never written by write-back). The three-way merge on
-- save uses this as the common ancestor of the new draft content and the
-- current disk content, so external edits are detected instead of overwritten.
CREATE TABLE collab.local_writeback_state (
 binding_id uuid NOT NULL REFERENCES collab.project_local_bindings(id) ON DELETE CASCADE,
 path text NOT NULL CHECK (path <> '' AND length(path) <= 1024),
 content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
 written_content bytea,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (binding_id, path)
);
ALTER TABLE collab.local_writeback_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY local_writeback_state_read ON collab.local_writeback_state FOR SELECT USING(
 EXISTS (SELECT 1 FROM collab.project_local_bindings b WHERE b.id = binding_id AND collab.project_role(b.project_id) IS NOT NULL)
);
GRANT SELECT ON collab.local_writeback_state TO pi_collab_app;

CREATE FUNCTION collab.set_project_local_binding(project uuid, target_path text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE org uuid; new_binding_id uuid; previous_path text;
BEGIN
 IF project IS NULL OR target_path IS NULL OR target_path = '' OR length(target_path) > 4096 THEN
  RAISE EXCEPTION 'invalid_local_binding' USING ERRCODE='P0001';
 END IF;
 IF collab.project_role(project) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 IF collab.project_role(project) NOT IN ('developer','maintainer') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF collab.user_requires_mfa(collab.actor()) AND NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
 SELECT organization_id INTO STRICT org FROM collab.projects WHERE id=project;
 PERFORM pg_advisory_xact_lock(hashtextextended(project::text, 815));
 IF EXISTS (SELECT 1 FROM collab.project_local_bindings b WHERE b.local_path = target_path AND b.project_id <> project) THEN
  RAISE EXCEPTION 'local_binding_conflict' USING ERRCODE='P0001';
 END IF;
 SELECT b.local_path INTO previous_path FROM collab.project_local_bindings b WHERE b.project_id = project;
 INSERT INTO collab.project_local_bindings(project_id, local_path, created_by)
 VALUES(project, target_path, collab.actor())
 ON CONFLICT (project_id) DO UPDATE SET local_path=EXCLUDED.local_path, updated_at=now()
 RETURNING id INTO new_binding_id;
 -- A changed target invalidates per-file baselines; the next save re-derives
 -- them from the import-time content instead of risking a stale ancestor.
 IF previous_path IS DISTINCT FROM target_path THEN
  DELETE FROM collab.local_writeback_state WHERE local_writeback_state.binding_id = new_binding_id;
 END IF;
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail)
 VALUES(org, project, collab.actor(), 'project.local_bound', new_binding_id, jsonb_build_object('localPath', target_path));
 RETURN jsonb_build_object('id', new_binding_id, 'projectId', project, 'localPath', target_path);
END $$;
REVOKE ALL ON FUNCTION collab.set_project_local_binding(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.set_project_local_binding(uuid,text) TO pi_collab_app;

CREATE FUNCTION collab.remove_project_local_binding(project uuid)
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
 SELECT b.id INTO binding_id FROM collab.project_local_bindings b WHERE b.project_id = project;
 IF binding_id IS NULL THEN RETURN; END IF;
 DELETE FROM collab.project_local_bindings WHERE id = binding_id;
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail)
 VALUES(org, project, collab.actor(), 'project.local_unbound', binding_id, '{}');
END $$;
REVOKE ALL ON FUNCTION collab.remove_project_local_binding(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.remove_project_local_binding(uuid) TO pi_collab_app;

CREATE FUNCTION collab.record_local_writeback(binding uuid, file_path text, sha text, content bytea)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE proj uuid;
BEGIN
 SELECT project_id INTO STRICT proj FROM collab.project_local_bindings WHERE id = binding;
 IF collab.project_role(proj) NOT IN ('developer','maintainer') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF file_path IS NULL OR file_path = '' OR length(file_path) > 1024 OR sha IS NULL OR sha !~ '^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'invalid_local_writeback' USING ERRCODE='P0001';
 END IF;
 INSERT INTO collab.local_writeback_state(binding_id, path, content_sha256, written_content, updated_at)
 VALUES(binding, file_path, sha, content, now())
 ON CONFLICT (binding_id, path) DO UPDATE SET content_sha256=EXCLUDED.content_sha256, written_content=EXCLUDED.written_content, updated_at=now();
END $$;
REVOKE ALL ON FUNCTION collab.record_local_writeback(uuid,text,text,bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.record_local_writeback(uuid,text,text,bytea) TO pi_collab_app;

CREATE FUNCTION collab.clear_local_writeback(binding uuid, file_path text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE proj uuid;
BEGIN
 SELECT project_id INTO STRICT proj FROM collab.project_local_bindings WHERE id = binding;
 IF collab.project_role(proj) NOT IN ('developer','maintainer') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 DELETE FROM collab.local_writeback_state WHERE local_writeback_state.binding_id = binding AND local_writeback_state.path = file_path;
END $$;
REVOKE ALL ON FUNCTION collab.clear_local_writeback(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.clear_local_writeback(uuid,text) TO pi_collab_app;
