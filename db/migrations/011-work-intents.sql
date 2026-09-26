-- Advisory collaboration metadata; never a filesystem permission or a lock.
ALTER TABLE collab.runs ADD CONSTRAINT runs_task_scope UNIQUE(organization_id,project_id,task_id,id);
CREATE TABLE collab.work_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, project_id uuid NOT NULL,
  task_id uuid NOT NULL, run_id uuid NOT NULL, revision integer NOT NULL CHECK(revision>0),
  declared_by text NOT NULL REFERENCES public."user"(id), declaration jsonb NOT NULL,
  idempotency_key uuid NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(run_id,revision), UNIQUE(run_id,declared_by,idempotency_key),
  FOREIGN KEY(organization_id,project_id,task_id) REFERENCES collab.tasks(organization_id,project_id,id),
  FOREIGN KEY(organization_id,project_id,task_id,run_id) REFERENCES collab.runs(organization_id,project_id,task_id,id)
);
CREATE INDEX work_intents_project ON collab.work_intents(project_id,run_id,revision DESC);
ALTER TABLE collab.work_intents ENABLE ROW LEVEL SECURITY;
CREATE POLICY work_intents_read ON collab.work_intents FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
GRANT SELECT ON collab.work_intents TO pi_collab_app;

CREATE FUNCTION collab.declare_work_intent(run uuid, expected_revision integer, request_key uuid, declaration jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab.runs; t collab.tasks; role text; prior collab.work_intents; current_revision integer; item jsonb; value text; request jsonb; intent uuid:=gen_random_uuid();
BEGIN
  SELECT * INTO r FROM collab.runs WHERE id=run;
  IF r.id IS NULL OR collab.project_role(r.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(r.organization_id::text,811));
  SELECT * INTO STRICT r FROM collab.runs WHERE id=run FOR UPDATE;
  SELECT * INTO STRICT t FROM collab.tasks WHERE id=r.task_id;
  role := collab.project_role(r.project_id);
  IF role IS NULL OR role NOT IN ('maintainer','developer') OR (role<>'maintainer' AND (t.owner_id<>collab.actor() OR r.requested_by<>collab.actor())) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
  IF collab.user_requires_mfa(collab.actor()) AND NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
  IF expected_revision IS NULL OR expected_revision<0 OR request_key IS NULL OR declaration IS NULL OR jsonb_typeof(declaration)<>'object' OR pg_column_size(declaration)>32768
    OR NOT declaration ?& ARRAY['paths','symbols','changeType','summary','expectedCompletion']
    OR (declaration-ARRAY['paths','symbols','changeType','summary','expectedCompletion'])<>'{}'::jsonb THEN RAISE EXCEPTION 'invalid_work_intent' USING ERRCODE='P0001'; END IF;
  IF jsonb_typeof(declaration->'paths')<>'array' OR jsonb_typeof(declaration->'symbols')<>'array'
    OR jsonb_typeof(declaration->'summary')<>'string' OR length(declaration->>'summary') NOT BETWEEN 1 AND 2000
    OR jsonb_typeof(declaration->'changeType')<>'string' OR declaration->>'changeType' NOT IN ('feature','fix','refactor','api','schema','config','docs','test')
    OR jsonb_typeof(declaration->'expectedCompletion') NOT IN ('null','string') THEN RAISE EXCEPTION 'invalid_work_intent' USING ERRCODE='P0001'; END IF;
  IF jsonb_array_length(declaration->'paths') NOT BETWEEN 1 AND 64 OR jsonb_array_length(declaration->'symbols')>32 THEN RAISE EXCEPTION 'invalid_work_intent' USING ERRCODE='P0001'; END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(declaration->'paths') LOOP
    value := item #>> '{}';
    IF jsonb_typeof(item)<>'string' OR length(value) NOT BETWEEN 1 AND 512 OR value ~ '[[:cntrl:]\\:*?\[\]{}]' OR value ~* '^/|//|(^|/)(\.|\.\.|\.git)(/|$)|[. ](/|$)' OR value<>btrim(value) THEN RAISE EXCEPTION 'invalid_work_intent' USING ERRCODE='P0001'; END IF;
  END LOOP;
  FOR item IN SELECT * FROM jsonb_array_elements(declaration->'symbols') LOOP
    IF jsonb_typeof(item)<>'string' OR length(item #>> '{}') NOT BETWEEN 1 AND 200 OR (item #>> '{}') ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'invalid_work_intent' USING ERRCODE='P0001'; END IF;
  END LOOP;
  IF declaration->>'expectedCompletion' IS NOT NULL THEN
    BEGIN
      IF length(declaration->>'expectedCompletion')>40 OR (declaration->>'expectedCompletion') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$' THEN RAISE EXCEPTION 'invalid_work_intent'; END IF;
      PERFORM (declaration->>'expectedCompletion')::timestamptz;
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'invalid_work_intent' USING ERRCODE='P0001'; END;
  END IF;
  request := jsonb_build_object('expectedRevision',expected_revision,'declaration',declaration);
  SELECT * INTO prior FROM collab.work_intents WHERE run_id=run AND declared_by=collab.actor() AND idempotency_key=request_key;
  IF FOUND THEN
    IF prior.payload<>request THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
    RETURN jsonb_build_object('intentId',prior.id,'revision',prior.revision,'replayed',true);
  END IF;
  -- Once a run stops, no late declaration can hide an undeclared change.
  IF r.status NOT IN ('queued','starting','running','waiting_input') OR NOT collab_worker.authorized(run) THEN RAISE EXCEPTION 'intent_run_closed' USING ERRCODE='P0001'; END IF;
  SELECT COALESCE(max(revision),0) INTO current_revision FROM collab.work_intents WHERE run_id=run;
  IF current_revision<>expected_revision THEN RAISE EXCEPTION 'stale_revision' USING ERRCODE='P0001'; END IF;
  INSERT INTO collab.work_intents(id,organization_id,project_id,task_id,run_id,revision,declared_by,declaration,idempotency_key,payload)
    VALUES(intent,r.organization_id,r.project_id,r.task_id,run,current_revision+1,collab.actor(),declaration,request_key,request);
  INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail)
    VALUES(r.organization_id,r.project_id,collab.actor(),'work_intent.declared',intent::text,jsonb_build_object('runId',run,'revision',current_revision+1));
  PERFORM collab_worker.emit(run,'work_intent.declared',jsonb_build_object('intentId',intent,'revision',current_revision+1));
  RETURN jsonb_build_object('intentId',intent,'revision',current_revision+1,'replayed',false);
END
$$;
REVOKE ALL ON FUNCTION collab.declare_work_intent(uuid,integer,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.declare_work_intent(uuid,integer,uuid,jsonb) TO pi_collab_app;
