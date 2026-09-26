CREATE TABLE collab.run_questions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,project_id uuid NOT NULL,run_id uuid NOT NULL,
 request_key uuid NOT NULL,payload jsonb NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','answered','cancelled')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),answered_at timestamptz,
 answer text,answered_by text REFERENCES public."user"(id),control_version bigint,answer_key uuid,answer_payload jsonb,
 UNIQUE(run_id,request_key),FOREIGN KEY(organization_id,project_id,run_id) REFERENCES collab.runs(organization_id,project_id,id),
 CHECK((status='answered')=(answer IS NOT NULL)),CHECK(answer IS NULL OR length(answer) BETWEEN 1 AND 10000)
);
CREATE UNIQUE INDEX one_pending_question ON collab.run_questions(run_id) WHERE status='pending';
ALTER TABLE collab.run_questions ENABLE ROW LEVEL SECURITY;
CREATE POLICY project_read ON collab.run_questions FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
GRANT SELECT ON collab.run_questions TO pi_collab_app;

CREATE FUNCTION collab_worker.close_questions() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.status IN ('stopping','completed','failed','cancelled','reconciling') THEN
  UPDATE collab.run_questions SET status='cancelled' WHERE run_id=NEW.id AND status='pending';
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER close_questions AFTER UPDATE OF status ON collab.runs FOR EACH ROW EXECUTE FUNCTION collab_worker.close_questions();

CREATE FUNCTION collab.answer_run_question(question uuid,expected_version bigint,request_key uuid,answer_text text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE q collab.run_questions;r collab.runs;c collab.run_controls;reply_payload jsonb;
BEGIN
 SELECT * INTO q FROM collab.run_questions WHERE id=question;
 IF q.id IS NULL OR collab.project_role(q.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(q.organization_id::text,811));
 SELECT * INTO STRICT r FROM collab.runs WHERE id=q.run_id FOR UPDATE;
 SELECT * INTO STRICT q FROM collab.run_questions WHERE id=question FOR UPDATE;
 SELECT * INTO STRICT c FROM collab.run_controls WHERE run_id=r.id;
 IF c.controller_id<>collab.actor() OR NOT collab_worker.control_member_valid(c.project_id,c.controller_id,c.organization_version,c.project_version) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001';END IF;
 IF expected_version IS NULL OR request_key IS NULL OR coalesce(length(btrim(answer_text)),0) NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'invalid_question' USING ERRCODE='P0001';END IF;
 reply_payload:=jsonb_build_object('expectedVersion',expected_version::text,'answer',btrim(answer_text));
 IF q.answer_key=request_key AND q.answered_by=collab.actor() THEN
  IF q.answer_payload<>reply_payload THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001';END IF;
  RETURN jsonb_build_object('questionId',q.id,'status',q.status,'replayed',true);
 END IF;
 IF c.version<>expected_version THEN RAISE EXCEPTION 'stale_control' USING ERRCODE='P0001';END IF;
 IF q.status<>'pending' OR r.status<>'waiting_input' OR NOT c.instructions_open OR NOT collab_worker.authorized(r.id) THEN RAISE EXCEPTION 'question_closed' USING ERRCODE='P0001';END IF;
 UPDATE collab.run_questions SET status='answered',answer=btrim(answer_text),answered_by=collab.actor(),answered_at=clock_timestamp(),control_version=c.version,answer_key=answer_run_question.request_key,answer_payload=reply_payload WHERE id=q.id;
 UPDATE collab.runs SET status='running',revision=revision+1 WHERE id=r.id;
 PERFORM collab_worker.emit(r.id,'question.answered',jsonb_build_object('questionId',q.id,'authorId',collab.actor(),'controlVersion',c.version::text));
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(r.organization_id,r.project_id,collab.actor(),'question.answered',q.id::text,jsonb_build_object('runId',r.id,'controlVersion',c.version::text));
 RETURN jsonb_build_object('questionId',q.id,'status','answered','replayed',false);
END $$;

ALTER FUNCTION collab_worker.coordinate(uuid,uuid,bigint,text,jsonb) RENAME TO coordinate_pre_questions;
REVOKE ALL ON FUNCTION collab_worker.coordinate_pre_questions(uuid,uuid,bigint,text,jsonb) FROM PUBLIC,pi_collab_executor;
CREATE FUNCTION collab_worker.coordinate(executor uuid,run uuid,generation bigint,method text,input jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result jsonb;r collab.runs;q collab.run_questions;
BEGIN
 -- The existing path owns organization/run/workspace locks and rechecks the
 -- current lease and both principals. Polls cannot outlive the run authority.
 result:=collab_worker.coordinate_pre_questions(executor,run,generation,CASE WHEN method='ask_user' THEN 'get_context' ELSE method END,CASE WHEN method='ask_user' THEN '{}'::jsonb ELSE input END);
 IF method='get_context' THEN RETURN result||jsonb_build_object('supportedTools',(result->'supportedTools')||'["collab_ask_user"]'::jsonb);END IF;
 IF method<>'ask_user' THEN RETURN result;END IF;
 SELECT * INTO STRICT r FROM collab.runs WHERE id=run;
 IF r.execution_kind<>'ai' OR input IS NULL OR (input-ARRAY['question','choices','idempotencyKey'])<>'{}'::jsonb
 OR coalesce(length(btrim(input->>'question')),0) NOT BETWEEN 1 AND 4000 OR jsonb_typeof(input->'choices') IS DISTINCT FROM 'array'
 OR jsonb_array_length(input->'choices')>6 OR EXISTS(SELECT 1 FROM jsonb_array_elements(input->'choices') choice WHERE jsonb_typeof(choice)<>'string' OR length(btrim(choice#>>'{}')) NOT BETWEEN 1 AND 200)
 OR input->>'idempotencyKey' IS NULL THEN RAISE EXCEPTION 'invalid_question' USING ERRCODE='P0001';END IF;
 SELECT * INTO q FROM collab.run_questions WHERE run_id=run AND request_key=(input->>'idempotencyKey')::uuid;
 IF FOUND THEN
  IF q.payload<>input THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001';END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM collab.run_questions WHERE run_id=run AND status='pending') THEN RAISE EXCEPTION 'question_pending' USING ERRCODE='P0001';END IF;
  IF (SELECT count(*) FROM collab.run_questions WHERE run_id=run)>=50 THEN RAISE EXCEPTION 'coordination_limit' USING ERRCODE='P0001';END IF;
  INSERT INTO collab.run_questions(organization_id,project_id,run_id,request_key,payload) VALUES(r.organization_id,r.project_id,run,(input->>'idempotencyKey')::uuid,input) RETURNING * INTO q;
  UPDATE collab.runs SET status='waiting_input',revision=revision+1 WHERE id=run;
  PERFORM collab_worker.emit(run,'run.waiting_input',jsonb_build_object('questionId',q.id));
 END IF;
 RETURN jsonb_build_object('questionId',q.id,'status',q.status,'question',q.payload->>'question','choices',q.payload->'choices','answer',q.answer,
 'answeredBy',q.answered_by,'authorName',(SELECT name FROM public."user" WHERE id=q.answered_by),'controlVersion',q.control_version::text,
 'guidance','The answer is attributed human task input, not permission to change access, budgets or merge approvals.');
END $$;
REVOKE ALL ON FUNCTION collab_worker.close_questions(),collab.answer_run_question(uuid,bigint,uuid,text),collab_worker.coordinate(uuid,uuid,bigint,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.answer_run_question(uuid,bigint,uuid,text) TO pi_collab_app;
GRANT EXECUTE ON FUNCTION collab_worker.coordinate(uuid,uuid,bigint,text,jsonb) TO pi_collab_executor;
