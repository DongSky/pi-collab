-- Recover the immutable human draft without trusting a failed workspace.
CREATE FUNCTION collab.copy_editor(session uuid, expected_version bigint, note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s collab.editor_sessions; result uuid;
BEGIN
 s:=collab.editor_lock(session,false,true);
 IF s.version IS DISTINCT FROM expected_version THEN RAISE EXCEPTION 'stale_revision' USING ERRCODE='P0001';END IF;
 IF s.state<>'handed_off' OR note IS NULL OR length(btrim(note)) NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'invalid_editor_command' USING ERRCODE='P0001';END IF;
 IF EXISTS(SELECT 1 FROM collab.tasks WHERE id=s.task_id AND status IN ('done','cancelled')) THEN RAISE EXCEPTION 'task_closed' USING ERRCODE='P0001';END IF;
 IF EXISTS(SELECT 1 FROM collab.editor_sessions WHERE task_id=s.task_id AND state IN ('editing','frozen')) THEN RAISE EXCEPTION 'editor_exists' USING ERRCODE='P0001';END IF;
 IF NOT EXISTS(SELECT 1 FROM collab.snapshots WHERE id=s.snapshot_id AND status='ready' AND manifest_hash=s.manifest_hash) THEN RAISE EXCEPTION 'snapshot_unavailable' USING ERRCODE='P0001';END IF;
 INSERT INTO collab.editor_sessions(organization_id,project_id,task_id,snapshot_id,manifest_hash,created_by)
 VALUES(s.organization_id,s.project_id,s.task_id,s.snapshot_id,s.manifest_hash,collab.actor()) RETURNING id INTO result;
 INSERT INTO collab.editor_documents(session_id,path,base_hash,original_text,content,y_state,deleted,updated_by)
 SELECT result,path,base_hash,original_text,content,y_state,deleted,collab.actor() FROM collab.editor_documents WHERE session_id=session;
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail)
 VALUES(s.organization_id,s.project_id,collab.actor(),'editor.copied',result::text,jsonb_build_object('sourceSessionId',s.id,'sourceVersion',s.version,'note',btrim(note)));
 RETURN jsonb_build_object('sessionId',result,'snapshotId',s.snapshot_id,'versionId',NULL);
END $$;
REVOKE EXECUTE ON FUNCTION collab.copy_editor(uuid,bigint,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.copy_editor(uuid,bigint,text) TO pi_collab_app;
