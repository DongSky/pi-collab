CREATE TABLE collab.subtask_policies (
 project_id uuid PRIMARY KEY REFERENCES collab.projects(id),version integer NOT NULL DEFAULT 1,
 concurrent_children integer NOT NULL DEFAULT 2 CHECK(concurrent_children BETWEEN 1 AND 16),
 descendants integer NOT NULL DEFAULT 16 CHECK(descendants BETWEEN 1 AND 64),depth integer NOT NULL DEFAULT 3 CHECK(depth BETWEEN 1 AND 4)
);
CREATE TABLE collab.subtask_proposals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,project_id uuid NOT NULL,parent_task_id uuid NOT NULL,parent_run_id uuid NOT NULL,
 author_id text NOT NULL REFERENCES public."user"(id),source_kind text NOT NULL DEFAULT 'human' CHECK(source_kind IN ('human','agent')),
 task_version integer NOT NULL,task_input jsonb NOT NULL,request_key uuid NOT NULL,request jsonb NOT NULL,
 status text NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','accepted','rejected')),version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),decided_by text,decision_note text,
 UNIQUE(parent_run_id,author_id,request_key),UNIQUE(organization_id,project_id,id),
 FOREIGN KEY(organization_id,project_id,parent_task_id) REFERENCES collab.tasks(organization_id,project_id,id),
 FOREIGN KEY(organization_id,project_id,parent_run_id) REFERENCES collab.runs(organization_id,project_id,id)
);
CREATE TABLE collab.subtasks (
 task_id uuid PRIMARY KEY,parent_task_id uuid NOT NULL,root_task_id uuid NOT NULL,organization_id uuid NOT NULL,project_id uuid NOT NULL,
 parent_run_id uuid NOT NULL,initial_run_id uuid NOT NULL,proposal_id uuid NOT NULL UNIQUE,depth integer NOT NULL CHECK(depth BETWEEN 1 AND 4),
 accepted_by text NOT NULL REFERENCES public."user"(id),accepted_at timestamptz NOT NULL DEFAULT now(),
 adopted_result_id uuid REFERENCES collab.task_results(id),adopted_at timestamptz,
 FOREIGN KEY(organization_id,project_id,task_id) REFERENCES collab.tasks(organization_id,project_id,id),
 FOREIGN KEY(organization_id,project_id,parent_task_id) REFERENCES collab.tasks(organization_id,project_id,id),
 FOREIGN KEY(organization_id,project_id,root_task_id) REFERENCES collab.tasks(organization_id,project_id,id),
 FOREIGN KEY(organization_id,project_id,parent_run_id) REFERENCES collab.runs(organization_id,project_id,id),
 FOREIGN KEY(organization_id,project_id,initial_run_id) REFERENCES collab.runs(organization_id,project_id,id),
 FOREIGN KEY(organization_id,project_id,proposal_id) REFERENCES collab.subtask_proposals(organization_id,project_id,id)
);
CREATE INDEX subtask_roots ON collab.subtasks(root_task_id);
CREATE INDEX subtask_parents ON collab.subtasks(parent_task_id);
CREATE TABLE collab.subtask_operations(scope_id uuid NOT NULL,actor_id text NOT NULL,request_key uuid NOT NULL,request_input jsonb NOT NULL,result jsonb NOT NULL,PRIMARY KEY(scope_id,actor_id,request_key));
ALTER TABLE collab.subtask_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE collab.subtask_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE collab.subtasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY subtask_policy_read ON collab.subtask_policies FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
CREATE POLICY subtask_proposal_read ON collab.subtask_proposals FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
CREATE POLICY subtask_read ON collab.subtasks FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
GRANT SELECT ON collab.subtask_policies,collab.subtask_proposals,collab.subtasks TO pi_collab_app;
CREATE TRIGGER operations_admission BEFORE INSERT ON collab.subtask_proposals FOR EACH ROW EXECUTE FUNCTION collab_meta.guard_admission();
CREATE TRIGGER operations_admission BEFORE INSERT ON collab.subtasks FOR EACH ROW EXECUTE FUNCTION collab_meta.guard_admission();

CREATE FUNCTION collab_worker.subtask_capacity_available(task uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT NOT EXISTS(SELECT 1 FROM collab.subtasks s WHERE s.task_id=task AND
   (SELECT count(*) FROM collab.runs r JOIN collab.subtasks child ON child.task_id=r.task_id WHERE child.root_task_id=s.root_task_id AND r.status IN ('starting','running','waiting_input','stopping','reconciling'))
   >=coalesce((SELECT concurrent_children FROM collab.subtask_policies WHERE project_id=s.project_id),2))
$$;
-- Extend the actual atomic scheduler, including subsequent runs of child tasks.
DO $$ DECLARE previous text;updated text;BEGIN
 SELECT pg_get_functiondef('collab_worker.claim_with_resolutions(uuid,text,boolean,boolean,boolean,boolean)'::regprocedure) INTO previous;
 updated:=replace(previous,'AND collab_worker.capacity_available(candidate.project_id,candidate.requested_by)',
 'AND collab_worker.capacity_available(candidate.project_id,candidate.requested_by) AND collab_worker.subtask_capacity_available(candidate.task_id)');
 IF updated=previous THEN RAISE EXCEPTION 'Missing subtask scheduler boundary';END IF;EXECUTE updated;
END $$;

CREATE FUNCTION collab.propose_subtask(run uuid,input jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab.runs;t collab.tasks;old collab.subtask_proposals;proposal uuid:=gen_random_uuid();
BEGIN
 SELECT * INTO r FROM collab.runs WHERE id=run;
 IF r.id IS NULL OR collab.project_role(r.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(r.organization_id::text,811));
 SELECT * INTO t FROM collab.tasks WHERE id=r.task_id;
 IF coalesce(collab.project_role(r.project_id),'') NOT IN ('developer','maintainer') OR (r.requested_by<>collab.actor() AND collab.project_role(r.project_id)<>'maintainer') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001';END IF;
 IF collab.user_requires_mfa(collab.actor()) AND NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001';END IF;
 IF input IS NULL OR (input-ARRAY['title','description','acceptance','prompt','idempotencyKey'])<>'{}'::jsonb OR input->>'idempotencyKey' IS NULL
 OR coalesce(length(btrim(input->>'title')),0) NOT BETWEEN 1 AND 200 OR coalesce(length(input->>'description'),-1) NOT BETWEEN 0 AND 10000
 OR coalesce(length(btrim(input->>'acceptance')),0) NOT BETWEEN 1 AND 10000 OR coalesce(length(btrim(input->>'prompt')),0) NOT BETWEEN 1 AND 10000
 THEN RAISE EXCEPTION 'invalid_subtask' USING ERRCODE='P0001';END IF;
 SELECT * INTO old FROM collab.subtask_proposals WHERE parent_run_id=run AND author_id=collab.actor() AND request_key=(input->>'idempotencyKey')::uuid;
 IF FOUND THEN IF old.request<>input THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001';END IF;RETURN jsonb_build_object('id',old.id,'replayed',true);END IF;
 IF r.execution_kind<>'ai' OR r.status NOT IN ('queued','starting','running','waiting_input','completed') OR t.status IN ('done','cancelled') OR NOT collab_worker.authorized(r.id) THEN RAISE EXCEPTION 'subtask_source_unavailable' USING ERRCODE='P0001';END IF;
 IF (SELECT count(*) FROM collab.subtask_proposals WHERE parent_task_id=t.id AND status='proposed')>=20 THEN RAISE EXCEPTION 'subtask_limit' USING ERRCODE='P0001';END IF;
 INSERT INTO collab.subtask_proposals(id,organization_id,project_id,parent_task_id,parent_run_id,author_id,task_version,task_input,request_key,request)
 VALUES(proposal,r.organization_id,r.project_id,t.id,run,collab.actor(),t.version,jsonb_build_array(t.title,t.description,t.acceptance,t.owner_id,t.dependency_version),(input->>'idempotencyKey')::uuid,input);
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(r.organization_id,r.project_id,collab.actor(),'subtask.proposed',proposal::text,jsonb_build_object('parentTaskId',t.id,'parentRunId',run));
 RETURN jsonb_build_object('id',proposal,'replayed',false);
END $$;

CREATE FUNCTION collab.decide_subtask(proposal uuid,input jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab.subtask_proposals;r collab.runs;w collab.workspaces;t collab.tasks;prior collab.subtask_operations;child uuid:=gen_random_uuid();root uuid;level integer;result jsonb;policy collab.subtask_policies;
BEGIN
 SELECT * INTO p FROM collab.subtask_proposals WHERE id=proposal;
 IF p.id IS NULL OR collab.project_role(p.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p.organization_id::text,811));SELECT * INTO p FROM collab.subtask_proposals WHERE id=proposal FOR UPDATE;
 SELECT * INTO r FROM collab.runs WHERE id=p.parent_run_id;SELECT * INTO t FROM collab.tasks WHERE id=p.parent_task_id;
 IF coalesce(collab.project_role(p.project_id),'') NOT IN ('developer','maintainer') OR (r.requested_by<>collab.actor() AND collab.project_role(p.project_id)<>'maintainer') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001';END IF;
 IF collab.user_requires_mfa(collab.actor()) AND NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001';END IF;
 IF input->>'idempotencyKey' IS NULL OR input->>'decision' IS NULL OR input->>'decision' NOT IN ('accept','reject') OR coalesce(length(btrim(input->>'reason')),0) NOT BETWEEN 10 AND 2000 THEN RAISE EXCEPTION 'invalid_subtask' USING ERRCODE='P0001';END IF;
 SELECT * INTO prior FROM collab.subtask_operations WHERE scope_id=proposal AND actor_id=collab.actor() AND request_key=(input->>'idempotencyKey')::uuid;
 IF FOUND THEN IF prior.request_input<>input THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001';END IF;RETURN prior.result||jsonb_build_object('replayed',true);END IF;
 IF p.status<>'proposed' OR p.version IS DISTINCT FROM (input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'stale_subtask' USING ERRCODE='P0001';END IF;
 IF input->>'decision'='accept' THEN
  -- Charge and authorize the same principal as the parent. Maintainers can
  -- reject/stop, but never impersonate another member to launch paid work.
  IF r.requested_by<>collab.actor() OR NOT collab_worker.authorized(r.id) OR (SELECT controller_id FROM collab.run_controls WHERE run_id=r.id)<>collab.actor() THEN RAISE EXCEPTION 'subtask_principal_required' USING ERRCODE='P0001';END IF;
  IF input->'acknowledge' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'invalid_subtask' USING ERRCODE='P0001';END IF;
  IF jsonb_build_array(t.title,t.description,t.acceptance,t.owner_id,t.dependency_version)<>p.task_input OR t.status IN ('done','cancelled') OR r.status NOT IN ('queued','starting','running','waiting_input','completed')
   OR collab.run_dependency_state(r.id)<>'current' OR collab_worker.resolution_input(r.id) IS NOT NULL THEN RAISE EXCEPTION 'subtask_source_unavailable' USING ERRCODE='P0001';END IF;
  SELECT coalesce(s.root_task_id,t.id),coalesce(s.depth,0)+1 INTO root,level FROM (SELECT 1) seed LEFT JOIN collab.subtasks s ON s.task_id=t.id;
  SELECT * INTO policy FROM collab.subtask_policies WHERE project_id=p.project_id;
  IF level>coalesce(policy.depth,3) OR (SELECT count(*) FROM collab.subtasks WHERE root_task_id=root)>=coalesce(policy.descendants,16) THEN RAISE EXCEPTION 'subtask_limit' USING ERRCODE='P0001';END IF;
  SELECT * INTO STRICT w FROM collab.workspaces WHERE id=r.workspace_id;
  INSERT INTO collab.tasks(id,organization_id,project_id,title,description,acceptance,owner_id,created_by)
   VALUES(child,p.organization_id,p.project_id,p.request->>'title',p.request->>'description',p.request->>'acceptance',collab.actor(),collab.actor());
  INSERT INTO collab.task_dependencies(organization_id,project_id,task_id,depends_on,kind) SELECT p.organization_id,p.project_id,child,depends_on,kind FROM collab.run_dependencies WHERE run_id=r.id;
  INSERT INTO collab.task_contracts SELECT p.organization_id,p.project_id,child,contract_id FROM collab.run_contracts WHERE run_id=r.id;
  result:=collab.submit_work_run(child,w.repository_id,w.base_sha,p.request->>'prompt',w.runtime,(input->>'idempotencyKey')::uuid,1,r.model_profile_id,NULL,NULL,NULL,'ai');
  INSERT INTO collab.subtasks(task_id,parent_task_id,root_task_id,organization_id,project_id,parent_run_id,initial_run_id,proposal_id,depth,accepted_by)
   VALUES(child,t.id,root,p.organization_id,p.project_id,r.id,(result->>'runId')::uuid,proposal,level,collab.actor());
  result:=result||jsonb_build_object('taskId',child,'parentTaskId',t.id,'depth',level);
 ELSE result:=jsonb_build_object('rejected',true);END IF;
 UPDATE collab.subtask_proposals SET status=CASE input->>'decision' WHEN 'accept' THEN 'accepted' ELSE 'rejected' END,version=version+1,decided_by=collab.actor(),decision_note=input->>'reason' WHERE id=proposal;
 INSERT INTO collab.subtask_operations VALUES(proposal,collab.actor(),(input->>'idempotencyKey')::uuid,input,result);
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(p.organization_id,p.project_id,collab.actor(),'subtask.'||(input->>'decision'),proposal::text,result||jsonb_build_object('reason',input->>'reason'));
 RETURN result;
END $$;

CREATE FUNCTION collab.subtask_action(task uuid,input jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t collab.tasks;prior collab.subtask_operations;result jsonb;ids uuid[];r collab.runs;child collab.subtasks;v collab.task_results;
BEGIN
 SELECT * INTO t FROM collab.tasks WHERE id=task;
 IF t.id IS NULL OR collab.project_role(t.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(t.organization_id::text,811));SELECT * INTO t FROM collab.tasks WHERE id=task FOR UPDATE;
 IF coalesce(collab.project_role(t.project_id),'') NOT IN ('developer','maintainer') OR (t.owner_id<>collab.actor() AND collab.project_role(t.project_id)<>'maintainer') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001';END IF;
 IF collab.user_requires_mfa(collab.actor()) AND NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001';END IF;
 IF input->>'idempotencyKey' IS NULL OR input->>'action' IS NULL OR input->>'action' NOT IN ('adopt','stop') OR coalesce(length(btrim(input->>'reason')),0) NOT BETWEEN 10 AND 2000 THEN RAISE EXCEPTION 'invalid_subtask' USING ERRCODE='P0001';END IF;
 SELECT * INTO prior FROM collab.subtask_operations WHERE scope_id=task AND actor_id=collab.actor() AND request_key=(input->>'idempotencyKey')::uuid;
 IF FOUND THEN IF prior.request_input<>input THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001';END IF;RETURN prior.result||jsonb_build_object('replayed',true);END IF;
 IF input->>'action'='adopt' THEN
  IF t.status IN ('done','cancelled') THEN RAISE EXCEPTION 'subtask_source_unavailable' USING ERRCODE='P0001';END IF;
  IF t.version IS DISTINCT FROM (input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'stale_revision' USING ERRCODE='P0001';END IF;
  IF EXISTS(SELECT 1 FROM collab.runs WHERE task_id=task AND status IN ('queued','starting','running','waiting_input','stopping','reconciling')) THEN RAISE EXCEPTION 'task_busy' USING ERRCODE='P0001';END IF;
  SELECT * INTO child FROM collab.subtasks WHERE task_id=(input->>'childTaskId')::uuid AND parent_task_id=task;
  SELECT * INTO v FROM collab.task_results WHERE id=(input->>'resultId')::uuid AND task_id=child.task_id;
  IF v.id IS NULL OR NOT EXISTS(SELECT 1 FROM collab.tasks WHERE id=v.task_id AND current_result_id=v.id) OR EXISTS(SELECT 1 FROM collab.result_withdrawals WHERE result_id=v.id) OR collab.run_dependency_state(v.source_run_id)<>'current' THEN RAISE EXCEPTION 'stale_subtask' USING ERRCODE='P0001';END IF;
  IF EXISTS(SELECT 1 FROM collab.task_dependencies WHERE task_id=task AND depends_on=child.task_id AND kind<>'strict') THEN RAISE EXCEPTION 'invalid_subtask' USING ERRCODE='P0001';END IF;
  IF NOT EXISTS(SELECT 1 FROM collab.task_dependencies WHERE task_id=task AND depends_on=child.task_id) THEN PERFORM collab.add_task_dependency(task,child.task_id,'strict');END IF;
  UPDATE collab.subtasks SET adopted_result_id=v.id,adopted_at=now() WHERE task_id=child.task_id;
  result:=jsonb_build_object('resultId',v.id,'next','Start a new parent run to receive the fixed dependency; no live files were changed.');
 ELSE
  WITH RECURSIVE tree AS (SELECT task_id FROM collab.subtasks WHERE parent_task_id=task UNION SELECT s.task_id FROM collab.subtasks s JOIN tree p ON s.parent_task_id=p.task_id) SELECT coalesce(array_agg(task_id),'{}') INTO ids FROM tree;
  IF collab.project_role(t.project_id)<>'maintainer' AND EXISTS(SELECT 1 FROM collab.runs WHERE task_id=ANY(ids) AND status IN ('queued','starting','running','waiting_input','stopping','reconciling') AND requested_by<>collab.actor()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001';END IF;
  FOR r IN SELECT * FROM collab.runs WHERE task_id=ANY(ids) AND status IN ('queued','starting','running','waiting_input','stopping','reconciling') ORDER BY id LOOP PERFORM collab_worker.request_stop(r.id,'subtask_group_stop');END LOOP;
  UPDATE collab.subtask_proposals SET status='rejected',version=version+1,decided_by=collab.actor(),decision_note=input->>'reason' WHERE (parent_task_id=task OR parent_task_id=ANY(ids)) AND status='proposed';
  result:=jsonb_build_object('stopRequested',true,'taskCount',cardinality(ids));
 END IF;
 INSERT INTO collab.subtask_operations VALUES(task,collab.actor(),(input->>'idempotencyKey')::uuid,input,result);
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(t.organization_id,t.project_id,collab.actor(),'subtask.'||(input->>'action'),task::text,input-'idempotencyKey');
 RETURN result;
END $$;

CREATE FUNCTION collab.configure_subtasks(project uuid,input jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE org uuid;v integer;prior collab.subtask_operations;result jsonb;
BEGIN
 SELECT organization_id INTO org FROM collab.projects WHERE id=project;
 IF org IS NULL OR collab.project_role(project) IS DISTINCT FROM 'maintainer' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(org::text,811));
 IF collab.project_role(project) IS DISTINCT FROM 'maintainer' OR NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001';END IF;
 IF input->>'idempotencyKey' IS NULL OR coalesce(length(btrim(input->>'reason')),0) NOT BETWEEN 10 AND 2000 THEN RAISE EXCEPTION 'invalid_subtask' USING ERRCODE='P0001';END IF;
 SELECT * INTO prior FROM collab.subtask_operations WHERE scope_id=project AND actor_id=collab.actor() AND request_key=(input->>'idempotencyKey')::uuid;
 IF FOUND THEN IF prior.request_input<>input THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001';END IF;RETURN prior.result;END IF;
 SELECT version INTO v FROM collab.subtask_policies WHERE project_id=project;
 IF coalesce(v,0) IS DISTINCT FROM (input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'stale_revision' USING ERRCODE='P0001';END IF;
 INSERT INTO collab.subtask_policies(project_id,concurrent_children,descendants,depth) VALUES(project,(input->>'concurrentChildren')::integer,(input->>'descendants')::integer,(input->>'depth')::integer)
 ON CONFLICT(project_id) DO UPDATE SET version=subtask_policies.version+1,concurrent_children=excluded.concurrent_children,descendants=excluded.descendants,depth=excluded.depth RETURNING version INTO v;
 result:=jsonb_build_object('version',v);INSERT INTO collab.subtask_operations VALUES(project,collab.actor(),(input->>'idempotencyKey')::uuid,input,result);
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(org,project,collab.actor(),'subtask.policy',project::text,input-'idempotencyKey');RETURN result;
END $$;

CREATE FUNCTION collab.subtask_context(task uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t collab.tasks;root uuid;
BEGIN
 SELECT * INTO t FROM collab.tasks WHERE id=task;
 IF t.id IS NULL OR collab.project_role(t.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 SELECT coalesce((SELECT root_task_id FROM collab.subtasks WHERE task_id=task),task) INTO root;
 RETURN jsonb_build_object('taskVersion',t.version,'rootTaskId',root,'canManage',collab.project_role(t.project_id)='maintainer','canAct',collab.project_role(t.project_id)='maintainer' OR (collab.project_role(t.project_id)='developer' AND t.owner_id=collab.actor()),
 'parent',(SELECT jsonb_build_object('taskId',s.parent_task_id,'title',p.title,'runId',s.parent_run_id,'depth',s.depth) FROM collab.subtasks s JOIN collab.tasks p ON p.id=s.parent_task_id WHERE s.task_id=task),
 'policy',(SELECT jsonb_build_object('version',coalesce(p.version,0),'concurrentChildren',coalesce(p.concurrent_children,2),'descendants',coalesce(p.descendants,16),'depth',coalesce(p.depth,3)) FROM (SELECT 1) seed LEFT JOIN collab.subtask_policies p ON p.project_id=t.project_id),
 'proposals',coalesce((SELECT jsonb_agg(jsonb_build_object('id',p.id,'parentRunId',p.parent_run_id,'authorId',p.author_id,'sourceKind',p.source_kind,'version',p.version,'status',p.status,'request',p.request,'note',p.decision_note,'canAccept',r.requested_by=collab.actor() AND c.controller_id=collab.actor() AND collab_worker.authorized(r.id),'modelId',r.model_profile_id,'modelName',(SELECT name FROM collab.model_profiles WHERE id=r.model_profile_id),'runtime',w.runtime,'baseSha',w.base_sha) ORDER BY p.created_at DESC,p.id) FROM (SELECT * FROM collab.subtask_proposals WHERE parent_task_id=task ORDER BY (status='proposed') DESC,created_at DESC,id LIMIT 40) p JOIN collab.runs r ON r.id=p.parent_run_id JOIN collab.run_controls c ON c.run_id=r.id JOIN collab.workspaces w ON w.id=r.workspace_id WHERE p.parent_task_id=task),'[]'::jsonb),
 'historyTruncated',(SELECT count(*)>40 FROM collab.subtask_proposals WHERE parent_task_id=task),
 'children',coalesce((SELECT jsonb_agg(jsonb_build_object('taskId',s.task_id,'title',c.title,'parentRunId',s.parent_run_id,'depth',s.depth,'ownerId',c.owner_id,'status',c.status,'adoptedResultId',s.adopted_result_id,
 'run',(SELECT jsonb_build_object('id',r.id,'status',r.status,'workspaceId',r.workspace_id,'runtime',w.runtime,'quotaAvailable',collab_worker.subtask_capacity_available(c.id)) FROM collab.runs r JOIN collab.workspaces w ON w.id=r.workspace_id WHERE r.task_id=c.id ORDER BY r.created_at DESC,r.id DESC LIMIT 1),
 'result',(SELECT jsonb_build_object('id',v.id,'version',v.version,'worktreeCommit',v.worktree_commit,'snapshotId',v.snapshot_id,'validationId',v.validation_id,'manifestHash',v.manifest_hash,'note',v.payload->>'note','valid',NOT EXISTS(SELECT 1 FROM collab.result_withdrawals WHERE result_id=v.id) AND collab.run_dependency_state(v.source_run_id)='current') FROM collab.task_results v WHERE v.id=c.current_result_id)) ORDER BY s.accepted_at,s.task_id) FROM collab.subtasks s JOIN collab.tasks c ON c.id=s.task_id WHERE s.parent_task_id=task),'[]'::jsonb));
END $$;

ALTER FUNCTION collab_worker.coordinate(uuid,uuid,bigint,text,jsonb) RENAME TO coordinate_pre_subtasks;
REVOKE ALL ON FUNCTION collab_worker.coordinate_pre_subtasks(uuid,uuid,bigint,text,jsonb) FROM PUBLIC,pi_collab_executor;
CREATE FUNCTION collab_worker.coordinate(executor uuid,run uuid,generation bigint,method text,input jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result jsonb;r collab.runs;previous text;prior collab_worker.coordination_operations;answer jsonb;
BEGIN
 result:=collab_worker.coordinate_pre_subtasks(executor,run,generation,CASE WHEN method='propose_subtask' THEN 'get_context' ELSE method END,CASE WHEN method='propose_subtask' THEN '{}'::jsonb ELSE input END);
 IF method NOT IN ('get_context','propose_subtask') THEN RETURN result;END IF;
 SELECT * INTO STRICT r FROM collab.runs WHERE id=run;
 previous:=current_setting('collab.user_id',true);PERFORM set_config('collab.user_id',r.requested_by,true);
 IF method='propose_subtask' THEN
  SELECT * INTO prior FROM collab_worker.coordination_operations WHERE run_id=run AND idempotency_key=(input->>'idempotencyKey')::uuid;
  IF FOUND THEN IF prior.method<>method OR prior.payload<>input THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001';END IF;answer:=prior.result||jsonb_build_object('replayed',true);
  ELSE
   IF (SELECT count(*) FROM collab_worker.coordination_operations WHERE run_id=run)>=200 THEN RAISE EXCEPTION 'coordination_limit' USING ERRCODE='P0001';END IF;
   answer:=collab.propose_subtask(run,input);UPDATE collab.subtask_proposals SET source_kind='agent' WHERE id=(answer->>'id')::uuid;
   INSERT INTO collab_worker.coordination_operations VALUES(run,(input->>'idempotencyKey')::uuid,method,input,answer,now());
  END IF;
 ELSE answer:=result||jsonb_build_object('supportedTools',(result->'supportedTools')||'["collab_propose_subtask"]'::jsonb,'subtasks',collab.subtask_context(r.task_id));END IF;
 PERFORM set_config('collab.user_id',coalesce(previous,''),true);RETURN answer;
END $$;
REVOKE ALL ON FUNCTION collab_worker.subtask_capacity_available(uuid),collab.propose_subtask(uuid,jsonb),collab.decide_subtask(uuid,jsonb),collab.subtask_action(uuid,jsonb),collab.configure_subtasks(uuid,jsonb),collab.subtask_context(uuid),collab_worker.coordinate(uuid,uuid,bigint,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.propose_subtask(uuid,jsonb),collab.decide_subtask(uuid,jsonb),collab.subtask_action(uuid,jsonb),collab.configure_subtasks(uuid,jsonb),collab.subtask_context(uuid) TO pi_collab_app;
GRANT EXECUTE ON FUNCTION collab_worker.coordinate(uuid,uuid,bigint,text,jsonb) TO pi_collab_executor;
