-- Keep the existing controller, epoch and source checks; permit the container PTY backend.
DO $$
DECLARE previous text;updated text;
BEGIN
 SELECT pg_get_functiondef('collab.submit_work_run(uuid,uuid,text,text,text,uuid,integer,uuid,uuid,uuid,uuid,text)'::regprocedure) INTO previous;
 updated:=replace(previous,'runtime_mode<>''native''','runtime_mode NOT IN (''native'',''docker'')');
 IF updated=previous THEN RAISE EXCEPTION 'Missing terminal backend gate';END IF;EXECUTE updated;
END $$;
DO $$
DECLARE previous text;updated text;
BEGIN
 SELECT pg_get_functiondef('collab.request_validation_v17(uuid,uuid,uuid)'::regprocedure) INTO previous;
 updated:=replace(previous,'w.runtime=''native''','w.runtime IN (''native'',''docker'')');
 IF updated=previous THEN RAISE EXCEPTION 'Missing snapshot validation backend gate';END IF;EXECUTE updated;
 SELECT pg_get_functiondef('collab_worker.claim_validation_resolutions(uuid,boolean,boolean,boolean)'::regprocedure) INTO previous;
 updated:=replace(previous,'resolution_inputs_supported boolean)','resolution_inputs_supported boolean, runtime_mode text)');
 updated:=replace(updated,'candidate.status=''queued''','candidate.status=''queued'' AND (SELECT w.runtime FROM collab.workspaces w WHERE w.id=s.workspace_id)=runtime_mode');
 updated:=replace(updated,'''config'',p.config','''runtime'',runtime_mode,''config'',p.config');
 IF updated=previous THEN RAISE EXCEPTION 'Missing validation dispatch';END IF;EXECUTE updated;
END $$;
CREATE OR REPLACE FUNCTION collab_worker.claim_validation_resolutions(executor uuid,result_inputs_supported boolean,contract_inputs_supported boolean,resolution_inputs_supported boolean) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT collab_worker.claim_validation_resolutions(executor,result_inputs_supported,contract_inputs_supported,resolution_inputs_supported,'native')
$$;
ALTER FUNCTION collab_worker.finish_validation(uuid,uuid,bigint,text,jsonb,text) RENAME TO finish_validation_pre_container;
CREATE FUNCTION collab_worker.finish_validation(executor uuid,validation uuid,generation bigint,requested_outcome text,result jsonb,failure text) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE runtime_mode text;
BEGIN
 SELECT w.runtime INTO runtime_mode FROM collab.validations v JOIN collab.snapshots s ON s.id=v.snapshot_id JOIN collab.workspaces w ON w.id=s.workspace_id WHERE v.id=validation;
 IF requested_outcome='passed' AND EXISTS(SELECT 1 FROM collab.validations v WHERE v.id=validation AND v.status='running' AND v.executor_id=executor AND v.epoch=generation AND v.lease_expires_at>clock_timestamp()) AND (result->'environment'->>'policy' IS DISTINCT FROM CASE runtime_mode WHEN 'docker' THEN 'container-fixed-validation-v1' ELSE 'native-trusted-v1' END) THEN RAISE EXCEPTION 'invalid_validation' USING ERRCODE='P0001';END IF;
 RETURN collab_worker.finish_validation_pre_container(executor,validation,generation,requested_outcome,result,failure);
END $$;
REVOKE ALL ON FUNCTION collab_worker.claim_validation_resolutions(uuid,boolean,boolean,boolean,text),collab_worker.finish_validation(uuid,uuid,bigint,text,jsonb,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION collab_worker.finish_validation_pre_container(uuid,uuid,bigint,text,jsonb,text) FROM PUBLIC,pi_collab_executor;
GRANT EXECUTE ON FUNCTION collab_worker.claim_validation_resolutions(uuid,boolean,boolean,boolean,text),collab_worker.finish_validation(uuid,uuid,bigint,text,jsonb,text) TO pi_collab_executor;
