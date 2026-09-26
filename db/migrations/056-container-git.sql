-- Container source workspaces are consumed only after their container exit receipt is verified.
-- Git effects still run in the restricted host Git broker with the same fixed plans and CAS gates.
DO $$
DECLARE signature text;previous text;updated text;source_expression text:='jsonb_build_object(''workspaceId'',w.id,''identity'',jsonb_build_object(''runId'',r.id,''executorId'',r.executor_id,''epoch'',r.epoch::text))';
BEGIN
 FOREACH signature IN ARRAY ARRAY[
  'collab.request_workspace_git(uuid,uuid,jsonb)',
  'collab_git.workspace_grant(uuid)',
  'collab.request_task_push_preview(uuid,uuid,jsonb)',
  'collab_git.push_preview_grant(uuid)'
 ] LOOP
  SELECT pg_get_functiondef(signature::regprocedure) INTO previous;
  updated:=replace(previous,'w.runtime<>''native''','w.runtime NOT IN (''native'',''docker'')');
  updated:=replace(updated,'w.runtime=''native''','w.runtime IN (''native'',''docker'')');
  updated:=replace(updated,source_expression,'('||source_expression||'||CASE WHEN w.runtime=''docker'' THEN ''{"runtime":"docker"}''::jsonb ELSE ''{}''::jsonb END)');
  IF updated=previous OR position(source_expression IN previous)=0 THEN RAISE EXCEPTION 'Missing container Git source gate: %',signature;END IF;EXECUTE updated;
 END LOOP;
END $$;

-- Freeze the execution boundary with the integration. Legacy rows remain native.
ALTER TABLE collab.integrations ADD COLUMN runtime text NOT NULL DEFAULT 'native' CHECK(runtime IN ('native','docker'));
DO $$
DECLARE previous text;updated text;
BEGIN
 SELECT pg_get_functiondef('collab_worker.request_integration_v16(uuid,text,uuid[],uuid,uuid)'::regprocedure) INTO previous;
 updated:=replace(previous,'w.runtime=''native''','w.runtime IN (''native'',''docker'')');
 updated:=replace(updated,'INSERT INTO collab.audit_events',
 'UPDATE collab.integrations SET runtime=''docker'' WHERE id=candidate AND EXISTS(SELECT 1 FROM collab.integration_sources src JOIN collab.task_results tr ON tr.id=src.result_id JOIN collab.snapshots s ON s.id=tr.snapshot_id JOIN collab.workspaces w ON w.id=s.workspace_id WHERE src.integration_id=candidate AND w.runtime=''docker'');
 INSERT INTO collab.audit_events');
 IF updated=previous THEN RAISE EXCEPTION 'Missing integration source gate';END IF;EXECUTE updated;
 SELECT pg_get_functiondef('collab.submit_run(uuid,uuid,text,text,text,uuid,integer,uuid,uuid)'::regprocedure) INTO previous;
 updated:=replace(previous,'runtime_mode<>''native''',
 '(runtime_mode NOT IN (''native'',''docker'') OR (runtime_mode<>''docker'' AND EXISTS(SELECT 1 FROM collab.integrations WHERE id=rt.integration_id AND runtime=''docker'')))');
 IF updated=previous THEN RAISE EXCEPTION 'Missing resolution runtime gate';END IF;EXECUTE updated;
 SELECT pg_get_functiondef('collab_worker.claim_integration_compatible(uuid,boolean)'::regprocedure) INTO previous;
 updated:=replace(previous,'resolutions_supported boolean)','resolutions_supported boolean, runtime_mode text)');
 updated:=replace(updated,'q.status=''queued''','q.status=''queued'' AND q.runtime=runtime_mode');
 updated:=replace(updated,'''config'',p.config','''runtime'',i.runtime,''config'',p.config');
 IF updated=previous THEN RAISE EXCEPTION 'Missing integration dispatch';END IF;EXECUTE updated;
 -- Check inside the lease-aware completion body, after terminal replay handling.
 SELECT pg_get_functiondef('collab_worker.finish_integration(uuid,uuid,bigint,text,jsonb,text)'::regprocedure) INTO previous;
 updated:=replace(previous,'IF i.status<>''checking'' OR result IS NULL',
 'IF (checks->''environment''->>''policy'' IS DISTINCT FROM CASE i.runtime WHEN ''docker'' THEN ''container-fixed-validation-v1'' ELSE ''native-trusted-v1'' END) OR i.status<>''checking'' OR result IS NULL');
 IF updated=previous THEN RAISE EXCEPTION 'Missing integration evidence gate';END IF;EXECUTE updated;
END $$;
CREATE OR REPLACE FUNCTION collab_worker.claim_integration_compatible(executor uuid,resolutions_supported boolean) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT collab_worker.claim_integration_compatible(executor,resolutions_supported,'native')
$$;
REVOKE ALL ON FUNCTION collab_worker.claim_integration_compatible(uuid,boolean,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab_worker.claim_integration_compatible(uuid,boolean,text) TO pi_collab_executor;

DO $$
DECLARE previous text;updated text;
BEGIN
 SELECT pg_get_functiondef('collab_git.push_confirmation_source_valid(uuid)'::regprocedure) INTO previous;
 updated:=replace(previous,'w.runtime=''native''','w.runtime IN (''native'',''docker'') AND COALESCE(p.admission->''source''->>''runtime'',''native'')=w.runtime');
 IF updated=previous THEN RAISE EXCEPTION 'Missing push confirmation runtime gate';END IF;EXECUTE updated;
END $$;
