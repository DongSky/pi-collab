ALTER TABLE collab.runs ADD COLUMN execution_kind text NOT NULL DEFAULT 'ai' CHECK(execution_kind IN ('ai','terminal'));
CREATE FUNCTION collab.submit_work_run(task uuid, repository uuid, base text, message text, runtime_mode text, request_key uuid, expected_version integer, model_profile uuid, snapshot uuid, suggestion uuid, editor_version uuid, execution_kind text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result jsonb; run uuid; previous text;
BEGIN
 IF execution_kind IS NULL OR execution_kind NOT IN ('ai','terminal') OR (execution_kind='terminal' AND (runtime_mode<>'native' OR model_profile IS NOT NULL)) THEN RAISE EXCEPTION 'invalid_terminal_run' USING ERRCODE='P0001';END IF;
 result:=collab.submit_editor_run(task,repository,base,message,runtime_mode,request_key,expected_version,model_profile,snapshot,suggestion,editor_version);
 run:=(result->>'runId')::uuid;
 IF (result->>'replayed')::boolean THEN
  SELECT r.execution_kind INTO previous FROM collab.runs r WHERE id=run;
  IF previous<>execution_kind THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001';END IF;
 ELSE
  UPDATE collab.runs r SET execution_kind=submit_work_run.execution_kind WHERE id=run;
  IF execution_kind='terminal' THEN
   INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id) SELECT organization_id,project_id,collab.actor(),'terminal.opened',id::text FROM collab.runs WHERE id=run;
  END IF;
 END IF;
 RETURN result;
END $$;
ALTER FUNCTION collab.submit_run_instruction(uuid,bigint,uuid,text,text) RENAME TO submit_run_instruction_v37;
CREATE FUNCTION collab.submit_run_instruction(run uuid, expected_version bigint, request_key uuid, instruction_kind text, message text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM collab.runs WHERE id=run AND execution_kind='ai' AND collab.project_role(project_id) IS NOT NULL) THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 RETURN collab.submit_run_instruction_v37(run,expected_version,request_key,instruction_kind,message);
END $$;
CREATE FUNCTION collab.submit_terminal_input(run uuid, expected_version bigint, request_key uuid, command jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM collab.runs WHERE id=run AND execution_kind='terminal' AND collab.project_role(project_id) IS NOT NULL) THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 IF command IS NULL OR jsonb_typeof(command)<>'object' OR octet_length(command::text)>20000 OR (command->>'type') NOT IN ('input','resize') THEN RAISE EXCEPTION 'invalid_terminal_input' USING ERRCODE='P0001';END IF;
 IF command->>'type'='input' THEN
  IF jsonb_typeof(command->'data')<>'string' OR length(command->>'data') NOT BETWEEN 1 AND 8192 THEN RAISE EXCEPTION 'invalid_terminal_input' USING ERRCODE='P0001';END IF;
 ELSE
  IF jsonb_typeof(command->'cols')<>'number' OR jsonb_typeof(command->'rows')<>'number' OR (command->>'cols')::integer NOT BETWEEN 20 AND 240 OR (command->>'rows')::integer NOT BETWEEN 5 AND 100 THEN RAISE EXCEPTION 'invalid_terminal_input' USING ERRCODE='P0001';END IF;
 END IF;
 RETURN collab.submit_run_instruction_v37(run,expected_version,request_key,'follow_up',command::text);
END $$;
REVOKE ALL ON FUNCTION collab.submit_work_run(uuid,uuid,text,text,text,uuid,integer,uuid,uuid,uuid,uuid,text),collab.submit_run_instruction(uuid,bigint,uuid,text,text),collab.submit_run_instruction_v37(uuid,bigint,uuid,text,text),collab.submit_terminal_input(uuid,bigint,uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION collab.submit_run_instruction_v37(uuid,bigint,uuid,text,text) FROM pi_collab_app;
GRANT EXECUTE ON FUNCTION collab.submit_work_run(uuid,uuid,text,text,text,uuid,integer,uuid,uuid,uuid,uuid,text),collab.submit_run_instruction(uuid,bigint,uuid,text,text),collab.submit_terminal_input(uuid,bigint,uuid,jsonb) TO pi_collab_app;
