CREATE TABLE collab.editor_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, project_id uuid NOT NULL, task_id uuid NOT NULL,
 snapshot_id uuid NOT NULL REFERENCES collab.snapshots(id), manifest_hash text NOT NULL,
 created_by text NOT NULL REFERENCES public."user"(id), state text NOT NULL DEFAULT 'editing' CHECK(state IN ('editing','frozen','handed_off','archived')),
 version bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,project_id,task_id) REFERENCES collab.tasks(organization_id,project_id,id)
);
CREATE UNIQUE INDEX editor_one_writer ON collab.editor_sessions(task_id) WHERE state IN ('editing','frozen');
CREATE TABLE collab.editor_documents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid NOT NULL REFERENCES collab.editor_sessions(id),
 path text NOT NULL CHECK(length(path) BETWEEN 1 AND 1024), base_hash text CHECK(base_hash ~ '^[a-f0-9]{64}$'),
 original_text text NOT NULL, content text NOT NULL CHECK(octet_length(content)<=262144),
 y_state bytea NOT NULL CHECK(octet_length(y_state)<=1048576), deleted boolean NOT NULL DEFAULT false,
 revision bigint NOT NULL DEFAULT 1, updated_by text NOT NULL REFERENCES public."user"(id), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(session_id,path)
);
CREATE TABLE collab.editor_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid NOT NULL REFERENCES collab.editor_sessions(id),
 version bigint NOT NULL, payload jsonb NOT NULL CHECK(octet_length(payload::text)<=2097152),
 payload_hash text NOT NULL CHECK(payload_hash=encode(sha256(convert_to(payload::text,'UTF8')),'hex')),
 note text NOT NULL CHECK(length(note) BETWEEN 1 AND 2000), created_by text NOT NULL REFERENCES public."user"(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(session_id,version)
);
CREATE TABLE collab.editor_presence (
 document_id uuid NOT NULL REFERENCES collab.editor_documents(id), client_id bigint NOT NULL CHECK(client_id BETWEEN 0 AND 4294967295),
 user_id text NOT NULL REFERENCES public."user"(id), selection jsonb, seen_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(document_id,client_id), CHECK(selection IS NULL OR octet_length(selection::text)<=2048)
);
CREATE TABLE collab.run_editor_versions (
 run_id uuid PRIMARY KEY REFERENCES collab.runs(id), version_id uuid NOT NULL UNIQUE REFERENCES collab.editor_versions(id),
 applied_hash text, applied_at timestamptz
);
ALTER TABLE collab.editor_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE collab.editor_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE collab.editor_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE collab.editor_presence ENABLE ROW LEVEL SECURITY;
ALTER TABLE collab.run_editor_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY editor_sessions_read ON collab.editor_sessions FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
CREATE POLICY editor_documents_read ON collab.editor_documents FOR SELECT USING(EXISTS(SELECT 1 FROM collab.editor_sessions s WHERE s.id=session_id));
CREATE POLICY editor_versions_read ON collab.editor_versions FOR SELECT USING(EXISTS(SELECT 1 FROM collab.editor_sessions s WHERE s.id=session_id));
CREATE POLICY editor_presence_read ON collab.editor_presence FOR SELECT USING(EXISTS(SELECT 1 FROM collab.editor_documents d WHERE d.id=document_id));
CREATE POLICY run_editor_read ON collab.run_editor_versions FOR SELECT USING(EXISTS(SELECT 1 FROM collab.runs r WHERE r.id=run_id));
GRANT SELECT ON collab.editor_sessions,collab.editor_documents,collab.editor_versions,collab.editor_presence,collab.run_editor_versions TO pi_collab_app;

CREATE FUNCTION collab.editor_lock(session uuid, writing boolean DEFAULT false, managing boolean DEFAULT false) RETURNS collab.editor_sessions
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s collab.editor_sessions; t collab.tasks; role text;
BEGIN
 SELECT * INTO s FROM collab.editor_sessions WHERE id=session;
 IF s.id IS NULL OR collab.project_role(s.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(s.organization_id::text,811));
 PERFORM pg_advisory_xact_lock(hashtextextended(s.task_id::text,820));
 SELECT * INTO t FROM collab.tasks WHERE id=s.task_id FOR UPDATE;
 SELECT * INTO s FROM collab.editor_sessions WHERE id=session FOR UPDATE;
 role:=collab.project_role(s.project_id);
 IF role IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 IF writing OR managing THEN
  IF role NOT IN ('maintainer','developer') OR (managing AND role<>'maintainer' AND t.owner_id<>collab.actor()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001';END IF;
  IF collab.user_requires_mfa(collab.actor()) AND NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001';END IF;
  IF EXISTS(SELECT 1 FROM collab.runs WHERE task_id=t.id AND status IN ('queued','starting','running','waiting_input','stopping','reconciling')) THEN RAISE EXCEPTION 'task_busy' USING ERRCODE='P0001';END IF;
  IF writing AND (s.state<>'editing' OR t.status IN ('done','cancelled')) THEN RAISE EXCEPTION 'editor_frozen' USING ERRCODE='P0001';END IF;
 END IF;
 RETURN s;
END $$;

CREATE FUNCTION collab.open_editor(task uuid, snapshot uuid, expected_version integer) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t collab.tasks; s collab.snapshots; role text; result uuid;
BEGIN
 SELECT * INTO t FROM collab.tasks WHERE id=task;
 IF t.id IS NULL OR collab.project_role(t.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(t.organization_id::text,811));
 PERFORM pg_advisory_xact_lock(hashtextextended(task::text,820));
 SELECT * INTO t FROM collab.tasks WHERE id=task FOR UPDATE;role:=collab.project_role(t.project_id);
 IF role IS NULL OR role NOT IN ('maintainer','developer') OR (role<>'maintainer' AND t.owner_id<>collab.actor()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001';END IF;
 IF collab.user_requires_mfa(collab.actor()) AND NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001';END IF;
 IF t.version IS DISTINCT FROM expected_version THEN RAISE EXCEPTION 'stale_revision' USING ERRCODE='P0001';END IF;
 IF t.status IN ('done','cancelled') THEN RAISE EXCEPTION 'task_closed' USING ERRCODE='P0001';END IF;
 IF EXISTS(SELECT 1 FROM collab.runs WHERE task_id=task AND status IN ('queued','starting','running','waiting_input','stopping','reconciling')) THEN RAISE EXCEPTION 'task_busy' USING ERRCODE='P0001';END IF;
 SELECT * INTO s FROM collab.snapshots WHERE id=snapshot AND task_id=task AND status='ready';
 IF s.id IS NULL THEN RAISE EXCEPTION 'snapshot_unavailable' USING ERRCODE='P0001';END IF;
 SELECT id INTO result FROM collab.editor_sessions WHERE task_id=task AND state IN ('editing','frozen');
 IF result IS NOT NULL THEN
  IF (SELECT snapshot_id FROM collab.editor_sessions WHERE id=result)<>snapshot THEN RAISE EXCEPTION 'editor_exists' USING ERRCODE='P0001';END IF;
  RETURN result;
 END IF;
 INSERT INTO collab.editor_sessions(organization_id,project_id,task_id,snapshot_id,manifest_hash,created_by) VALUES(t.organization_id,t.project_id,task,snapshot,s.manifest_hash,collab.actor()) RETURNING id INTO result;
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(t.organization_id,t.project_id,collab.actor(),'editor.opened',result::text,jsonb_build_object('snapshotId',snapshot,'taskId',task));
 RETURN result;
END $$;

CREATE FUNCTION collab.save_editor_document(session uuid, file_path text, base text, initial_text text, updated_text text, state_bytes bytea, expected_revision bigint, is_deleted boolean) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s collab.editor_sessions; d collab.editor_documents;
BEGIN
 s:=collab.editor_lock(session,true,false);
 SELECT * INTO d FROM collab.editor_documents WHERE session_id=session AND path=file_path FOR UPDATE;
 IF d.id IS NULL THEN
  IF expected_revision<>0 OR (SELECT count(*) FROM collab.editor_documents WHERE session_id=session)>=40 THEN RAISE EXCEPTION 'editor_document_limit' USING ERRCODE='P0001';END IF;
  INSERT INTO collab.editor_documents(session_id,path,base_hash,original_text,content,y_state,deleted,updated_by) VALUES(session,file_path,base,initial_text,updated_text,state_bytes,is_deleted,collab.actor()) RETURNING * INTO d;
 ELSE
  IF d.revision IS DISTINCT FROM expected_revision OR d.base_hash IS DISTINCT FROM base OR d.original_text IS DISTINCT FROM initial_text THEN RAISE EXCEPTION 'stale_revision' USING ERRCODE='P0001';END IF;
  IF d.y_state=state_bytes AND d.deleted=is_deleted THEN RETURN d.id;END IF;
  UPDATE collab.editor_documents SET content=updated_text,y_state=state_bytes,deleted=is_deleted,revision=revision+1,updated_by=collab.actor(),updated_at=now() WHERE id=d.id;
 END IF;
 UPDATE collab.editor_sessions SET version=version+1,updated_at=now() WHERE id=session;
 RETURN d.id;
END $$;

CREATE FUNCTION collab.editor_checkpoint(session uuid, action text, expected_version bigint, note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s collab.editor_sessions; result uuid; payload jsonb;
BEGIN
 s:=collab.editor_lock(session,false,true);
 IF s.version IS DISTINCT FROM expected_version THEN RAISE EXCEPTION 'stale_revision' USING ERRCODE='P0001';END IF;
 IF action NOT IN ('checkpoint','handoff','reopen','archive') OR note IS NULL OR length(btrim(note)) NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'invalid_editor_command' USING ERRCODE='P0001';END IF;
 IF s.state IN ('handed_off','archived') THEN RAISE EXCEPTION 'editor_frozen' USING ERRCODE='P0001';END IF;
 IF action='reopen' THEN
  UPDATE collab.editor_sessions SET state='editing',version=version+1,updated_at=now() WHERE id=session;
 ELSIF action='archive' THEN
  UPDATE collab.editor_sessions SET state='archived',version=version+1,updated_at=now() WHERE id=session;
 ELSE
  IF s.state<>'editing' THEN RAISE EXCEPTION 'editor_frozen' USING ERRCODE='P0001';END IF;
  SELECT jsonb_build_object('snapshotId',s.snapshot_id,'manifestHash',s.manifest_hash,'files',coalesce(jsonb_agg(jsonb_build_object('path',path,'baseHash',base_hash,'text',CASE WHEN deleted THEN NULL ELSE content END) ORDER BY path) FILTER(WHERE deleted OR base_hash IS NULL OR content<>original_text),'[]'::jsonb)) INTO payload FROM collab.editor_documents WHERE session_id=session;
  INSERT INTO collab.editor_versions(session_id,version,payload,payload_hash,note,created_by) VALUES(session,s.version,payload,encode(sha256(convert_to(payload::text,'UTF8')),'hex'),btrim(note),collab.actor()) RETURNING id INTO result;
  UPDATE collab.editor_sessions SET state=CASE WHEN action='handoff' THEN 'frozen' ELSE 'editing' END,version=version+1,updated_at=now() WHERE id=session;
 END IF;
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(s.organization_id,s.project_id,collab.actor(),'editor.'||action,session::text,jsonb_build_object('versionId',result,'note',btrim(note)));
 RETURN jsonb_build_object('versionId',result,'snapshotId',s.snapshot_id);
END $$;

CREATE FUNCTION collab.touch_editor_presence(document uuid, client bigint, cursor_state jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s collab.editor_sessions;
BEGIN
 SELECT session.* INTO s FROM collab.editor_documents d JOIN collab.editor_sessions session ON session.id=d.session_id WHERE d.id=document;
 IF s.id IS NULL OR collab.project_role(s.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 DELETE FROM collab.editor_presence WHERE document_id=document AND seen_at<now()-interval '1 minute';
 IF EXISTS(SELECT 1 FROM collab.editor_presence WHERE document_id=document AND client_id=client AND user_id<>collab.actor()) THEN RAISE EXCEPTION 'editor_client_conflict' USING ERRCODE='P0001';END IF;
 IF (SELECT count(*) FROM collab.editor_presence WHERE document_id=document AND user_id=collab.actor())>=8 AND NOT EXISTS(SELECT 1 FROM collab.editor_presence WHERE document_id=document AND client_id=client) THEN RAISE EXCEPTION 'editor_document_limit' USING ERRCODE='P0001';END IF;
 INSERT INTO collab.editor_presence(document_id,client_id,user_id,selection) VALUES(document,client,collab.actor(),cursor_state) ON CONFLICT(document_id,client_id) DO UPDATE SET selection=EXCLUDED.selection,seen_at=now() WHERE collab.editor_presence.user_id=collab.actor();
END $$;

CREATE FUNCTION collab.editor_run_gate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM collab.editor_sessions WHERE task_id=NEW.task_id AND state IN ('editing','frozen')) THEN RAISE EXCEPTION 'editor_handoff_required' USING ERRCODE='P0001';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER editor_run_gate BEFORE INSERT ON collab.runs FOR EACH ROW EXECUTE FUNCTION collab.editor_run_gate();
CREATE FUNCTION collab.submit_editor_run(task uuid, repository uuid, base text, message text, runtime_mode text, request_key uuid, expected_version integer, model_profile uuid, snapshot uuid, suggestion uuid, editor_version uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v collab.editor_versions; s collab.editor_sessions; result jsonb; previous uuid; r uuid;
BEGIN
 IF editor_version IS NOT NULL THEN
  SELECT * INTO v FROM collab.editor_versions WHERE id=editor_version;
  IF v.id IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
  s:=collab.editor_lock(v.session_id,false,false);
  IF s.task_id<>task OR s.snapshot_id IS DISTINCT FROM snapshot OR suggestion IS NOT NULL THEN RAISE EXCEPTION 'editor_source_mismatch' USING ERRCODE='P0001';END IF;
  SELECT run_id INTO previous FROM collab.run_editor_versions WHERE version_id=v.id;
  IF previous IS NULL THEN
   IF s.state<>'frozen' OR v.version+1<>s.version THEN RAISE EXCEPTION 'editor_frozen' USING ERRCODE='P0001';END IF;
   UPDATE collab.editor_sessions SET state='handed_off',version=version+1,updated_at=now() WHERE id=s.id;
  END IF;
 END IF;
 result:=collab.submit_suggestion_run(task,repository,base,message,runtime_mode,request_key,expected_version,model_profile,snapshot,suggestion);r:=(result->>'runId')::uuid;
 IF (result->>'replayed')::boolean THEN
  IF (SELECT version_id FROM collab.run_editor_versions WHERE run_id=r) IS DISTINCT FROM editor_version THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001';END IF;
 ELSIF editor_version IS NOT NULL THEN
  IF previous IS NOT NULL THEN RAISE EXCEPTION 'editor_version_used' USING ERRCODE='P0001';END IF;
  INSERT INTO collab.run_editor_versions(run_id,version_id) VALUES(r,editor_version);
 END IF;
 RETURN result;
END $$;
CREATE FUNCTION collab_worker.run_editor_version(executor uuid, run uuid, generation bigint, applied text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab.runs; v collab.editor_versions;
BEGIN
 r:=collab_worker.assert_lease(executor,run,generation);
 IF NOT collab_worker.authorized(run) OR r.status<>'starting' THEN RAISE EXCEPTION 'run_not_executable' USING ERRCODE='P0001';END IF;
 SELECT version.* INTO v FROM collab.run_editor_versions rv JOIN collab.editor_versions version ON version.id=rv.version_id WHERE rv.run_id=run;
 IF v.id IS NULL THEN RETURN NULL;END IF;
 IF applied IS NOT NULL THEN
  IF applied !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'invalid_editor_command' USING ERRCODE='P0001';END IF;
  UPDATE collab.run_editor_versions SET applied_hash=applied,applied_at=now() WHERE run_id=run AND applied_at IS NULL;
 END IF;
 RETURN jsonb_build_object('versionId',v.id,'payload',v.payload,'payloadHash',v.payload_hash);
END $$;
REVOKE EXECUTE ON FUNCTION collab.editor_lock(uuid,boolean,boolean),collab.open_editor(uuid,uuid,integer),collab.save_editor_document(uuid,text,text,text,text,bytea,bigint,boolean),collab.editor_checkpoint(uuid,text,bigint,text),collab.touch_editor_presence(uuid,bigint,jsonb),collab.editor_run_gate(),collab.submit_editor_run(uuid,uuid,text,text,text,uuid,integer,uuid,uuid,uuid,uuid),collab_worker.run_editor_version(uuid,uuid,bigint,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.editor_lock(uuid,boolean,boolean),collab.open_editor(uuid,uuid,integer),collab.save_editor_document(uuid,text,text,text,text,bytea,bigint,boolean),collab.editor_checkpoint(uuid,text,bigint,text),collab.touch_editor_presence(uuid,bigint,jsonb),collab.submit_editor_run(uuid,uuid,text,text,text,uuid,integer,uuid,uuid,uuid,uuid) TO pi_collab_app;
GRANT EXECUTE ON FUNCTION collab_worker.run_editor_version(uuid,uuid,bigint,text) TO pi_collab_executor;
