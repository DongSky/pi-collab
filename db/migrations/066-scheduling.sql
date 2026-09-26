-- Priority changes ordering only. Admission, leases, dependency pins, storage
-- limits and child-task quotas remain in the existing atomic claim function.
CREATE TABLE collab.project_scheduling (
 project_id uuid PRIMARY KEY REFERENCES collab.projects(id),
 version integer NOT NULL CHECK(version>0), priority integer NOT NULL CHECK(priority BETWEEN 0 AND 2)
);
ALTER TABLE collab.project_scheduling ENABLE ROW LEVEL SECURITY;
CREATE POLICY project_read ON collab.project_scheduling FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
CREATE TABLE collab_worker.scheduling_operations (
 project_id uuid NOT NULL REFERENCES collab.projects(id), actor_id text NOT NULL, request_key uuid NOT NULL,
 input jsonb NOT NULL, result jsonb NOT NULL, PRIMARY KEY(project_id,actor_id,request_key)
);
CREATE FUNCTION collab.configure_scheduling(project uuid,input jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE org uuid;old collab_worker.scheduling_operations;v integer;result jsonb;
BEGIN
 SELECT organization_id INTO org FROM collab.projects WHERE id=project;
 IF org IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(org::text,811));
 IF collab.project_role(project) IS DISTINCT FROM 'maintainer' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001';END IF;
 IF NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001';END IF;
 IF input IS NULL OR (input-ARRAY['expectedVersion','priority','reason','idempotencyKey'])<>'{}'::jsonb
 OR coalesce(input->>'expectedVersion','')!~'^[0-9]+$' OR coalesce(input->>'priority','')!~'^[012]$'
 OR input->>'idempotencyKey' IS NULL OR coalesce(length(btrim(input->>'reason')),0) NOT BETWEEN 10 AND 2000
 THEN RAISE EXCEPTION 'invalid_scheduling' USING ERRCODE='P0001';END IF;
 SELECT * INTO old FROM collab_worker.scheduling_operations WHERE project_id=project AND actor_id=collab.actor() AND request_key=(configure_scheduling.input->>'idempotencyKey')::uuid;
 IF FOUND THEN
  IF old.input IS DISTINCT FROM input THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001';END IF;
  RETURN old.result;
 END IF;
 SELECT version INTO v FROM collab.project_scheduling WHERE project_id=project FOR UPDATE;
 IF coalesce(v,0)<>(input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'stale_revision' USING ERRCODE='P0001';END IF;
 INSERT INTO collab.project_scheduling VALUES(project,1,(input->>'priority')::integer)
 ON CONFLICT(project_id) DO UPDATE SET version=project_scheduling.version+1,priority=excluded.priority RETURNING version INTO v;
 result:=jsonb_build_object('version',v,'priority',(input->>'priority')::integer);
 INSERT INTO collab_worker.scheduling_operations VALUES(project,collab.actor(),(input->>'idempotencyKey')::uuid,input,result);
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(org,project,collab.actor(),'scheduling.configured',project::text,input-'idempotencyKey');
 RETURN result;
END $$;

-- Lexicographic rank. After 30 minutes eligible jobs use oldest-first, so a
-- stream of newly eligible jobs cannot perpetually jump ahead. Otherwise use
-- the existing member fair share, then a bounded five-minute priority credit.
CREATE FUNCTION collab_worker.scheduling_rank(candidate collab.runs) RETURNS numeric[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT CASE WHEN candidate.created_at<=now()-interval '30 minutes'
 THEN ARRAY[0::numeric,0::numeric,extract(epoch FROM candidate.created_at)]
 ELSE ARRAY[1::numeric,
  (SELECT count(*)::numeric FROM collab.runs a WHERE a.requested_by=candidate.requested_by AND a.status IN ('starting','running','waiting_input','stopping','reconciling')),
  extract(epoch FROM candidate.created_at)-300*coalesce((SELECT priority FROM collab.project_scheduling WHERE project_id=candidate.project_id),1)] END
$$;
DO $$ DECLARE previous text;updated text;BEGIN
 SELECT pg_get_functiondef('collab_worker.claim_with_resolutions(uuid,text,boolean,boolean,boolean,boolean)'::regprocedure) INTO previous;
 updated:=replace(previous,'ORDER BY (SELECT count(*) FROM collab.runs a WHERE a.requested_by=candidate.requested_by AND a.status IN (''starting'',''running'',''waiting_input'',''stopping'',''reconciling'')),candidate.created_at,candidate.id',
 'ORDER BY collab_worker.scheduling_rank(candidate),candidate.created_at,candidate.id');
 IF updated=previous THEN RAISE EXCEPTION 'Missing scheduling order boundary';END IF;EXECUTE updated;
END $$;

CREATE FUNCTION collab.scheduling_context(project uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF collab.project_role(project) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 RETURN jsonb_build_object('version',coalesce((SELECT version FROM collab.project_scheduling WHERE project_id=project),0),
 'priority',coalesce((SELECT priority FROM collab.project_scheduling WHERE project_id=project),1),
 'canManage',collab.project_role(project)='maintainer','protectedAfterMinutes',30,'priorityCreditMinutes',5,
 'totalQueued',(SELECT count(*) FROM collab.runs WHERE project_id=project AND status='queued'),
 'queue',coalesce((SELECT jsonb_agg(row.data ORDER BY row.rank,row.created_at,row.id) FROM (
  SELECT r.id,r.created_at,collab_worker.scheduling_rank(r) rank,jsonb_build_object('runId',r.id,'taskId',r.task_id,'title',t.title,'ownerName',u.name,
   'runtime',w.runtime,'createdAt',r.created_at,'waitSeconds',greatest(0,floor(extract(epoch FROM now()-r.created_at))),
   'protected',r.created_at<=now()-interval '30 minutes','dependencyState',collab.run_dependency_state(r.id),
   'capacityAvailable',collab_worker.capacity_available(r.project_id,r.requested_by),'childCapacityAvailable',collab_worker.subtask_capacity_available(r.task_id)) data
  FROM collab.runs r JOIN collab.tasks t ON t.id=r.task_id JOIN public."user" u ON u.id=r.requested_by JOIN collab.workspaces w ON w.id=r.workspace_id
  WHERE r.project_id=project AND r.status='queued' ORDER BY rank,r.created_at,r.id LIMIT 100
 ) row),'[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION collab.configure_scheduling(uuid,jsonb),collab.scheduling_context(uuid),collab_worker.scheduling_rank(collab.runs) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.configure_scheduling(uuid,jsonb),collab.scheduling_context(uuid) TO pi_collab_app;
