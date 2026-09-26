-- Human task planning is separate from code approval and Git delivery.
CREATE TABLE collab.task_edits (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, project_id uuid NOT NULL, task_id uuid NOT NULL,
 actor_id text NOT NULL REFERENCES public."user"(id), version integer NOT NULL,
 idempotency_key uuid NOT NULL, request jsonb NOT NULL, previous jsonb NOT NULL, updated jsonb NOT NULL,
 reason text NOT NULL, evidence_invalidated boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(task_id,actor_id,idempotency_key), UNIQUE(task_id,version),
 FOREIGN KEY(organization_id,project_id,task_id) REFERENCES collab.tasks(organization_id,project_id,id)
);
ALTER TABLE collab.task_edits ENABLE ROW LEVEL SECURITY;
CREATE POLICY task_edits_read ON collab.task_edits FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
GRANT SELECT ON collab.task_edits TO pi_collab_app;
-- Column grants from migration 010 must not bypass version checks and invalidation.
REVOKE UPDATE(title,description,acceptance,status,version,updated_at) ON collab.tasks FROM pi_collab_app;

CREATE FUNCTION collab.edit_task(task uuid, expected_version integer, request_key uuid, change jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t collab.tasks; prior collab.task_edits; role text; request jsonb; previous jsonb; updated jsonb;
 task_title text; task_description text; task_acceptance text; task_status text; reason text; invalidate boolean; edit uuid:=gen_random_uuid();
BEGIN
 SELECT * INTO t FROM collab.tasks WHERE id=task;
 IF t.id IS NULL OR collab.project_role(t.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(t.organization_id::text,811));
 PERFORM pg_advisory_xact_lock(hashtextextended(task::text,820));
 -- Same run-before-task row order as reassignment and executor completion.
 PERFORM 1 FROM collab.runs WHERE task_id=task AND status IN ('queued','starting','running','waiting_input','stopping','reconciling') ORDER BY id FOR UPDATE;
 SELECT * INTO STRICT t FROM collab.tasks WHERE id=task FOR UPDATE;
 role:=collab.project_role(t.project_id);
 IF role IS NULL OR role NOT IN ('maintainer','developer') OR (role='developer' AND t.owner_id<>collab.actor()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF collab.user_requires_mfa(collab.actor()) AND NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
 IF expected_version IS NULL OR expected_version<1 OR request_key IS NULL OR change IS NULL OR jsonb_typeof(change)<>'object'
   OR NOT change ?& ARRAY['title','description','acceptance','status','reason','acknowledgeCompletion']
   OR (change-ARRAY['title','description','acceptance','status','reason','acknowledgeCompletion'])<>'{}'::jsonb
   OR jsonb_typeof(change->'title')<>'string' OR jsonb_typeof(change->'description')<>'string'
   OR jsonb_typeof(change->'acceptance')<>'string' OR jsonb_typeof(change->'status')<>'string'
   OR jsonb_typeof(change->'reason')<>'string' OR jsonb_typeof(change->'acknowledgeCompletion')<>'boolean'
   THEN RAISE EXCEPTION 'invalid_task_edit' USING ERRCODE='P0001'; END IF;
 task_title:=btrim(change->>'title'); task_description:=change->>'description'; task_acceptance:=change->>'acceptance';
 task_status:=change->>'status'; reason:=btrim(change->>'reason');
 IF length(task_title) NOT BETWEEN 1 AND 200 OR length(task_description)>20000 OR length(task_acceptance)>20000 OR length(reason) NOT BETWEEN 10 AND 2000
   OR task_status NOT IN ('draft','ready','in_progress','in_review','ready_to_merge','done','blocked','cancelled')
   THEN RAISE EXCEPTION 'invalid_task_edit' USING ERRCODE='P0001'; END IF;
 request:=jsonb_build_object('expectedVersion',expected_version,'change',change);
 SELECT * INTO prior FROM collab.task_edits WHERE task_id=task AND actor_id=collab.actor() AND idempotency_key=request_key;
 IF FOUND THEN
   IF prior.request<>request THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
   RETURN jsonb_build_object('editId',prior.id,'taskId',task,'version',prior.version,'evidenceInvalidated',prior.evidence_invalidated,'replayed',true);
 END IF;
 IF t.version<>expected_version THEN RAISE EXCEPTION 'stale_revision' USING ERRCODE='P0001'; END IF;
 IF EXISTS(SELECT 1 FROM collab.runs WHERE task_id=task AND status IN ('queued','starting','running','waiting_input','stopping','reconciling')) THEN RAISE EXCEPTION 'task_busy' USING ERRCODE='P0001'; END IF;
 IF task_status<>t.status AND task_status IN ('in_progress','ready_to_merge') THEN RAISE EXCEPTION 'task_status_managed' USING ERRCODE='P0001'; END IF;
 IF task_status='done' AND t.status<>'done' AND NOT (change->>'acknowledgeCompletion')::boolean THEN RAISE EXCEPTION 'task_completion_acknowledgement' USING ERRCODE='P0001'; END IF;
 IF (task_description<>t.description OR task_acceptance<>t.acceptance) AND EXISTS(SELECT 1 FROM collab.resolution_tasks WHERE task_id=task)
   THEN RAISE EXCEPTION 'resolution_task_fixed' USING ERRCODE='P0001'; END IF;
 invalidate:=task_description<>t.description OR task_acceptance<>t.acceptance OR (task_status='cancelled' AND t.status<>'cancelled');
 previous:=jsonb_build_object('title',t.title,'description',t.description,'acceptance',t.acceptance,'status',t.status);
 updated:=jsonb_build_object('title',task_title,'description',task_description,'acceptance',task_acceptance,'status',task_status);
 IF previous=updated THEN RAISE EXCEPTION 'task_edit_unchanged' USING ERRCODE='P0001'; END IF;
 UPDATE collab.tasks SET title=task_title,description=task_description,acceptance=task_acceptance,status=task_status,
   version=version+1,updated_at=now(),dependency_version=dependency_version+CASE WHEN invalidate THEN 1 ELSE 0 END,
   current_result_id=CASE WHEN invalidate THEN NULL ELSE current_result_id END WHERE id=task;
 INSERT INTO collab.task_edits(id,organization_id,project_id,task_id,actor_id,version,idempotency_key,request,previous,updated,reason,evidence_invalidated)
 VALUES(edit,t.organization_id,t.project_id,task,collab.actor(),t.version+1,request_key,request,previous,updated,reason,invalidate);
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail)
 VALUES(t.organization_id,t.project_id,collab.actor(),'task.updated',task::text,jsonb_build_object('editId',edit,'previousStatus',t.status,'status',task_status,'evidenceInvalidated',invalidate,'reason',reason));
 RETURN jsonb_build_object('editId',edit,'taskId',task,'version',t.version+1,'evidenceInvalidated',invalidate,'replayed',false);
END
$$;
REVOKE EXECUTE ON FUNCTION collab.edit_task(uuid,integer,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.edit_task(uuid,integer,uuid,jsonb) TO pi_collab_app;
