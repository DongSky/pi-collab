CREATE FUNCTION collab_worker.claim_revert_validation(executor uuid, runtime_mode text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE claimed jsonb;
BEGIN
 claimed:=collab_worker.claim_validation_resolutions(executor,true,true,true,runtime_mode);
 IF claimed IS NULL THEN RETURN NULL; END IF;
 RETURN claimed||jsonb_build_object('revert',EXISTS(SELECT 1 FROM collab.validations v JOIN collab.revert_tasks rt ON rt.task_id=v.task_id WHERE v.id=(claimed->>'id')::uuid));
END $$;
ALTER FUNCTION collab.publish_task_result(uuid,uuid,integer,uuid,text,boolean) RENAME TO publish_task_result_v72;
CREATE FUNCTION collab.publish_task_result(task uuid, validation uuid, expected_version integer, request_key uuid, note text, acknowledge_resolution boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result jsonb; rt collab.revert_tasks;
BEGIN
 SELECT * INTO rt FROM collab.revert_tasks WHERE task_id=task;
 IF FOUND THEN
  -- Call the existing boundary before exposing provenance or evidence errors.
  result:=collab.publish_task_result_v72(task,validation,expected_version,request_key,note,false);
  IF acknowledge_resolution IS DISTINCT FROM true OR length(btrim(note))<10 THEN RAISE EXCEPTION 'revert_acknowledgement_required' USING ERRCODE='P0001'; END IF;
  IF NOT EXISTS(SELECT 1 FROM collab.validations WHERE id=validation AND evidence->'revertMarkersAbsent'='true'::jsonb) THEN RAISE EXCEPTION 'revert_validation_required' USING ERRCODE='P0001'; END IF;
  IF NOT (result->>'replayed')::boolean THEN
   INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(rt.organization_id,rt.project_id,collab.actor(),'revert.published',task::text,jsonb_build_object('resultId',result->>'resultId','promotionId',rt.promotion_id,'acknowledgedAllConflictChoices',true));
  END IF;
  RETURN result;
 END IF;
 RETURN collab.publish_task_result_v72(task,validation,expected_version,request_key,note,acknowledge_resolution);
END $$;
REVOKE ALL ON FUNCTION collab.publish_task_result_v72(uuid,uuid,integer,uuid,text,boolean) FROM pi_collab_app;
REVOKE ALL ON FUNCTION collab_worker.claim_revert_validation(uuid,text),collab.publish_task_result(uuid,uuid,integer,uuid,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab_worker.claim_revert_validation(uuid,text) TO pi_collab_executor;
GRANT EXECUTE ON FUNCTION collab.publish_task_result(uuid,uuid,integer,uuid,text,boolean) TO pi_collab_app;
