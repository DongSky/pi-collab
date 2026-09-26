-- Immutable local Git combinations. A checked preview is not merge authority.
CREATE TABLE collab.integrations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, project_id uuid NOT NULL, repository_id uuid NOT NULL,
 target_branch text NOT NULL, target_sha text NOT NULL CHECK(target_sha~'^[a-f0-9]{40}$'), profile_id uuid NOT NULL,
 root_result_ids uuid[] NOT NULL, sources jsonb NOT NULL, input_hash text NOT NULL CHECK(input_hash~'^[a-f0-9]{64}$'), check_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
 requested_by text NOT NULL REFERENCES public."user"(id), organization_version bigint NOT NULL, project_version bigint NOT NULL, idempotency_key uuid NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','integrating','checking','checked','conflicted','check_failed','stale','cancelled','revoked','unknown')),
 executor_id uuid, epoch bigint NOT NULL DEFAULT 0, lease_expires_at timestamptz, stop_requested boolean NOT NULL DEFAULT false,
 evidence jsonb, error_code text, created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz,
 UNIQUE(organization_id,project_id,id), UNIQUE(requested_by,repository_id,idempotency_key),
 FOREIGN KEY(organization_id,project_id,repository_id) REFERENCES collab.repositories(organization_id,project_id,id),
 FOREIGN KEY(organization_id,project_id,profile_id) REFERENCES collab.validation_profiles(organization_id,project_id,id)
);
CREATE TABLE collab.integration_sources (
 organization_id uuid NOT NULL, project_id uuid NOT NULL, integration_id uuid NOT NULL, task_id uuid NOT NULL, result_id uuid NOT NULL, ordinal integer NOT NULL,
 PRIMARY KEY(integration_id,result_id), UNIQUE(integration_id,task_id), UNIQUE(integration_id,ordinal),
 FOREIGN KEY(organization_id,project_id,integration_id) REFERENCES collab.integrations(organization_id,project_id,id),
 FOREIGN KEY(organization_id,project_id,task_id,result_id) REFERENCES collab.task_results(organization_id,project_id,task_id,id)
);
CREATE UNIQUE INDEX integration_target_writer ON collab.integrations(repository_id,target_branch) WHERE status IN ('integrating','checking','unknown');
ALTER TABLE collab.integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE collab.integration_sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY project_read ON collab.integrations FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
CREATE POLICY project_read ON collab.integration_sources FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
GRANT SELECT ON collab.integrations,collab.integration_sources TO pi_collab_app;

CREATE FUNCTION collab_worker.integration_authorized(candidate uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM collab.integrations i JOIN collab.memberships m ON m.organization_id=i.organization_id AND m.user_id=i.requested_by
 JOIN collab.project_memberships pm ON pm.project_id=i.project_id AND pm.user_id=i.requested_by JOIN public."user" u ON u.id=i.requested_by
 WHERE i.id=candidate AND m.active AND pm.active AND m.authorization_version=i.organization_version AND pm.authorization_version=i.project_version
 AND pm.role IN ('maintainer','developer') AND (m.role='member' OR u."twoFactorEnabled"))
$$;
CREATE FUNCTION collab_worker.integration_current(candidate uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM collab.integrations i JOIN collab.repositories repo ON repo.id=i.repository_id WHERE i.id=candidate AND i.target_sha=repo.base_sha AND i.target_branch=repo.default_branch)
 AND EXISTS(SELECT 1 FROM collab.integration_sources WHERE integration_id=candidate)
 AND NOT EXISTS(SELECT 1 FROM collab.integration_sources s JOIN collab.tasks t ON t.id=s.task_id JOIN collab.task_results r ON r.id=s.result_id
 WHERE s.integration_id=candidate AND (t.current_result_id IS DISTINCT FROM r.id OR EXISTS(SELECT 1 FROM collab.result_withdrawals WHERE result_id=r.id) OR NOT collab_worker.dependencies_current(r.source_run_id)))
$$;
CREATE FUNCTION collab.integration_state(candidate uuid) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i collab.integrations;
BEGIN
 SELECT * INTO i FROM collab.integrations WHERE id=candidate;
 IF i.id IS NULL OR collab.project_role(i.project_id) IS NULL THEN RETURN NULL; END IF;
 RETURN CASE WHEN NOT collab_worker.integration_authorized(candidate) THEN 'revoked' WHEN NOT collab_worker.integration_current(candidate) THEN 'stale' ELSE 'current' END;
END $$;

CREATE FUNCTION collab.request_integration(repository uuid, target text, results uuid[], profile uuid, request_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE repo collab.repositories; prior collab.integrations; roots uuid[]; remaining uuid[]; emitted uuid[]:='{}'; sources jsonb:='[]'; r collab.task_results; deps uuid[]; source jsonb; candidate uuid:=gen_random_uuid(); config jsonb; role text;
BEGIN
 SELECT * INTO repo FROM collab.repositories WHERE id=repository;
 IF repo.id IS NULL OR collab.project_role(repo.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(repo.organization_id::text,811)); SELECT * INTO STRICT repo FROM collab.repositories WHERE id=repository;
 role:=collab.project_role(repo.project_id);
 IF role IS NULL OR role NOT IN ('maintainer','developer') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF collab.user_requires_mfa(collab.actor()) AND NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
 IF results IS NULL OR cardinality(results) NOT BETWEEN 1 AND 32 OR request_key IS NULL OR target IS NULL OR profile IS NULL OR EXISTS(SELECT 1 FROM unnest(results) x WHERE x IS NULL) THEN RAISE EXCEPTION 'invalid_integration' USING ERRCODE='P0001'; END IF;
 SELECT array_agg(DISTINCT x ORDER BY x) INTO roots FROM unnest(results) x;
 IF cardinality(roots)<>cardinality(results) THEN RAISE EXCEPTION 'invalid_integration' USING ERRCODE='P0001'; END IF;
 SELECT * INTO prior FROM collab.integrations WHERE repository_id=repository AND requested_by=collab.actor() AND idempotency_key=request_key;
 IF FOUND THEN
  IF prior.root_result_ids<>roots OR prior.target_sha<>target OR prior.profile_id<>profile THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
  RETURN jsonb_build_object('integrationId',prior.id,'status',prior.status,'replayed',true);
 END IF;
 IF repo.base_sha<>target THEN RAISE EXCEPTION 'integration_stale' USING ERRCODE='P0001'; END IF;
 SELECT p.config INTO config FROM collab.validation_profiles p WHERE id=profile AND repository_id=repository AND project_id=repo.project_id;
 IF config IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 IF (SELECT count(*) FROM collab.integrations WHERE project_id=repo.project_id AND status IN ('queued','integrating','checking','unknown'))>=20 THEN RAISE EXCEPTION 'integration_limit' USING ERRCODE='P0001'; END IF;
 WITH RECURSIVE chosen(id) AS (SELECT unnest(roots) UNION SELECT d.result_id FROM chosen c JOIN collab.task_results rr ON rr.id=c.id JOIN collab.run_dependencies d ON d.run_id=rr.source_run_id WHERE d.result_id IS NOT NULL)
 SELECT array_agg(id ORDER BY id) INTO remaining FROM chosen;
 IF cardinality(remaining)>32 THEN RAISE EXCEPTION 'integration_limit' USING ERRCODE='P0001'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(remaining) chosen_id WHERE NOT EXISTS(SELECT 1 FROM collab.task_results tr JOIN collab.tasks t ON t.id=tr.task_id JOIN collab.snapshots s ON s.id=tr.snapshot_id JOIN collab.workspaces w ON w.id=s.workspace_id
   WHERE tr.id=chosen_id AND tr.project_id=repo.project_id AND t.current_result_id=tr.id AND w.repository_id=repository AND s.status='ready' AND s.manifest_hash=tr.manifest_hash AND w.runtime='native'
   AND NOT EXISTS(SELECT 1 FROM collab.result_withdrawals WHERE result_id=tr.id) AND collab_worker.dependencies_current(tr.source_run_id))) THEN RAISE EXCEPTION 'integration_source_unavailable' USING ERRCODE='P0001'; END IF;
 WHILE cardinality(remaining)>0 LOOP
  SELECT * INTO r FROM collab.task_results tr WHERE tr.id=ANY(remaining) AND NOT EXISTS(SELECT 1 FROM collab.run_dependencies d WHERE d.run_id=tr.source_run_id AND (d.result_id IS NULL OR NOT d.result_id=ANY(emitted))) ORDER BY tr.task_id,tr.id LIMIT 1;
  IF r.id IS NULL THEN RAISE EXCEPTION 'integration_source_unavailable' USING ERRCODE='P0001'; END IF;
  SELECT COALESCE(array_agg(result_id ORDER BY result_id),'{}'::uuid[]) INTO deps FROM collab.run_dependencies WHERE run_id=r.source_run_id;
  SELECT jsonb_build_object('resultId',r.id,'taskId',r.task_id,'snapshotId',r.snapshot_id,'manifestHash',r.manifest_hash,'worktreeCommit',r.worktree_commit,'baseSha',w.base_sha,'dependencyResultIds',to_jsonb(deps)) INTO source FROM collab.snapshots s JOIN collab.workspaces w ON w.id=s.workspace_id WHERE s.id=r.snapshot_id;
  sources:=sources||jsonb_build_array(source); emitted:=array_append(emitted,r.id); remaining:=array_remove(remaining,r.id);
 END LOOP;
 INSERT INTO collab.integrations(id,organization_id,project_id,repository_id,target_branch,target_sha,profile_id,root_result_ids,sources,input_hash,requested_by,organization_version,project_version,idempotency_key)
 VALUES(candidate,repo.organization_id,repo.project_id,repository,repo.default_branch,target,profile,roots,sources,
 encode(sha256(convert_to(jsonb_build_object('repositoryId',repository,'targetBranch',repo.default_branch,'targetSha',target,'profileId',profile,'config',config,'sources',sources)::text,'UTF8')),'hex'),
 collab.actor(),(SELECT authorization_version FROM collab.memberships WHERE organization_id=repo.organization_id AND user_id=collab.actor()),(SELECT authorization_version FROM collab.project_memberships WHERE project_id=repo.project_id AND user_id=collab.actor()),request_key);
 INSERT INTO collab.integration_sources SELECT repo.organization_id,repo.project_id,candidate,(value->>'taskId')::uuid,(value->>'resultId')::uuid,ordinality FROM jsonb_array_elements(sources) WITH ORDINALITY;
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(repo.organization_id,repo.project_id,collab.actor(),'integration.queued',candidate::text,jsonb_build_object('roots',roots,'targetSha',target,'profileId',profile));
 RETURN jsonb_build_object('integrationId',candidate,'status','queued','replayed',false);
END $$;

CREATE TABLE collab.integration_cancellations (
 integration_id uuid NOT NULL REFERENCES collab.integrations(id), actor_id text NOT NULL REFERENCES public."user"(id), idempotency_key uuid NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 10 AND 2000), created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(integration_id,actor_id,idempotency_key)
);
CREATE FUNCTION collab.cancel_integration(candidate uuid, reason text, request_key uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i collab.integrations; prior collab.integration_cancellations; role text;
BEGIN
 SELECT * INTO i FROM collab.integrations WHERE id=candidate;
 IF i.id IS NULL OR collab.project_role(i.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(i.organization_id::text,811)); SELECT * INTO STRICT i FROM collab.integrations WHERE id=candidate FOR UPDATE;
 role:=collab.project_role(i.project_id);
 IF role IS NULL OR role NOT IN ('maintainer','developer') OR (role<>'maintainer' AND i.requested_by<>collab.actor()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF collab.user_requires_mfa(collab.actor()) AND NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
 IF reason IS NULL OR length(btrim(reason)) NOT BETWEEN 10 AND 2000 OR request_key IS NULL THEN RAISE EXCEPTION 'invalid_integration' USING ERRCODE='P0001'; END IF;
 SELECT * INTO prior FROM collab.integration_cancellations WHERE integration_id=candidate AND actor_id=collab.actor() AND idempotency_key=request_key;
 IF FOUND AND prior.reason<>btrim(reason) THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
 IF NOT FOUND THEN
  INSERT INTO collab.integration_cancellations VALUES(candidate,collab.actor(),request_key,btrim(reason),now());
  UPDATE collab.integrations SET stop_requested=true,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,finished_at=CASE WHEN status='queued' THEN now() ELSE finished_at END WHERE id=candidate AND status IN ('queued','integrating','checking');
  INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(i.organization_id,i.project_id,collab.actor(),'integration.cancel_requested',candidate::text,jsonb_build_object('reason',btrim(reason)));
 END IF;
 RETURN jsonb_build_object('integrationId',candidate,'status',(SELECT status FROM collab.integrations WHERE id=candidate));
END $$;

CREATE FUNCTION collab_worker.claim_integration(executor uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i collab.integrations; outcome text;
BEGIN
 IF executor IS NULL THEN RAISE EXCEPTION 'invalid_integration' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(82467116);
 FOR i IN SELECT * FROM collab.integrations WHERE status IN ('queued','integrating','checking') ORDER BY created_at,id LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended(i.organization_id::text,811)); SELECT * INTO STRICT i FROM collab.integrations WHERE id=i.id FOR UPDATE;
  outcome:=NULL;
  IF i.status IN ('integrating','checking') AND i.lease_expires_at<=clock_timestamp() THEN outcome:='unknown';
  ELSIF i.status='queued' AND NOT collab_worker.integration_authorized(i.id) THEN outcome:='revoked';
  ELSIF i.status='queued' AND NOT collab_worker.integration_current(i.id) THEN outcome:='stale'; END IF;
  IF outcome IS NOT NULL THEN UPDATE collab.integrations SET status=outcome,error_code='integration_'||outcome,finished_at=now() WHERE id=i.id; END IF;
 END LOOP;
 SELECT * INTO i FROM collab.integrations q WHERE q.status='queued'
 AND NOT EXISTS(SELECT 1 FROM collab.integrations busy WHERE busy.repository_id=q.repository_id AND busy.target_branch=q.target_branch AND busy.status IN ('integrating','checking','unknown'))
 AND NOT EXISTS(SELECT 1 FROM collab.integrations earlier WHERE earlier.repository_id=q.repository_id AND earlier.target_branch=q.target_branch AND earlier.status='queued' AND (earlier.created_at,earlier.id)<(q.created_at,q.id))
 ORDER BY q.created_at,q.id LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 UPDATE collab.integrations SET status='integrating',executor_id=executor,epoch=epoch+1,lease_expires_at=clock_timestamp()+interval '30 seconds',started_at=now() WHERE id=i.id RETURNING * INTO i;
 RETURN (SELECT jsonb_build_object('id',i.id,'executorId',executor,'epoch',i.epoch::text,'repositoryId',i.repository_id,'targetBranch',i.target_branch,'targetSha',i.target_sha,'inputHash',i.input_hash,'profileId',i.profile_id,'checkId',i.check_id,'config',p.config,'sources',i.sources) FROM collab.validation_profiles p WHERE p.id=i.profile_id);
END $$;
CREATE FUNCTION collab_worker.heartbeat_integration(executor uuid, candidate uuid, generation bigint, checking boolean DEFAULT false) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i collab.integrations; valid boolean;
BEGIN
 SELECT * INTO i FROM collab.integrations WHERE id=candidate FOR UPDATE;
 IF i.id IS NULL OR i.executor_id IS DISTINCT FROM executor OR i.epoch IS DISTINCT FROM generation OR i.status NOT IN ('integrating','checking') OR i.lease_expires_at<=clock_timestamp() THEN RETURN false; END IF;
 valid:=NOT i.stop_requested AND collab_worker.integration_authorized(candidate) AND collab_worker.integration_current(candidate);
 UPDATE collab.integrations SET lease_expires_at=clock_timestamp()+interval '30 seconds',status=CASE WHEN checking AND valid THEN 'checking' ELSE status END WHERE id=candidate;
 RETURN valid;
END $$;
CREATE FUNCTION collab_worker.finish_integration(executor uuid, candidate uuid, generation bigint, requested_outcome text, result jsonb, failure text) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i collab.integrations; outcome text; configuration jsonb; checks jsonb;
BEGIN
 SELECT * INTO i FROM collab.integrations WHERE id=candidate; IF i.id IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(i.organization_id::text,811)); SELECT * INTO STRICT i FROM collab.integrations WHERE id=candidate FOR UPDATE;
 IF i.executor_id IS DISTINCT FROM executor OR i.epoch IS DISTINCT FROM generation THEN RAISE EXCEPTION 'integration_lease_lost' USING ERRCODE='P0001'; END IF;
 IF i.status NOT IN ('integrating','checking') THEN RETURN i.status; END IF;
 IF i.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'integration_lease_lost' USING ERRCODE='P0001'; END IF;
 IF requested_outcome IS NULL OR requested_outcome NOT IN ('checked','conflicted','check_failed','cancelled','unknown') OR pg_column_size(result)>262144 OR length(failure)>120 THEN RAISE EXCEPTION 'invalid_integration' USING ERRCODE='P0001'; END IF;
 IF result IS NOT NULL AND (jsonb_typeof(result)<>'object' OR result->>'integrationId' IS DISTINCT FROM i.id::text OR result->>'repositoryId' IS DISTINCT FROM i.repository_id::text OR result->>'inputHash' IS DISTINCT FROM i.input_hash OR result->>'targetSha' IS DISTINCT FROM i.target_sha OR result->>'targetBranch' IS DISTINCT FROM i.target_branch OR result->'sources' IS DISTINCT FROM i.sources OR result->>'outcome' IS DISTINCT FROM requested_outcome) THEN RAISE EXCEPTION 'invalid_integration' USING ERRCODE='P0001'; END IF;
 IF requested_outcome='conflicted' AND (result IS NULL OR jsonb_typeof(result->'conflict') IS DISTINCT FROM 'object' OR NOT EXISTS(SELECT 1 FROM collab.integration_sources WHERE integration_id=candidate AND result_id::text=result->'conflict'->>'resultId') OR jsonb_typeof(result->'conflict'->'files') IS DISTINCT FROM 'array' OR jsonb_array_length(result->'conflict'->'files') NOT BETWEEN 1 AND 256) THEN RAISE EXCEPTION 'invalid_integration' USING ERRCODE='P0001'; END IF;
 IF requested_outcome='checked' THEN
  SELECT config INTO STRICT configuration FROM collab.validation_profiles WHERE id=i.profile_id; checks:=result->'validation';
  IF i.status<>'checking' OR result IS NULL OR failure IS NOT NULL OR COALESCE(result->>'candidateCommit','')!~'^[a-f0-9]{40}$' OR result->'conflict' IS DISTINCT FROM 'null'::jsonb OR jsonb_typeof(result->'merges') IS DISTINCT FROM 'array' OR jsonb_array_length(result->'merges')<>jsonb_array_length(i.sources)
   OR checks->>'validationId' IS DISTINCT FROM i.check_id::text OR checks->>'snapshotId' IS DISTINCT FROM i.id::text OR checks->>'profileId' IS DISTINCT FROM i.profile_id::text OR checks->'config' IS DISTINCT FROM configuration OR checks->>'outcome' IS DISTINCT FROM 'passed'
   OR result->'snapshot'->>'id' IS DISTINCT FROM i.id::text OR COALESCE(result->'snapshot'->>'manifestHash','')!~'^[a-f0-9]{64}$' OR checks->>'manifestHash' IS DISTINCT FROM result->'snapshot'->>'manifestHash' OR COALESCE(checks->>'worktreeCommit','')!~'^[a-f0-9]{40}$' OR checks->>'worktreeCommit' IS DISTINCT FROM result->'snapshot'->>'worktreeCommit'
   OR result->'merges'->-1->>'mergedCommit' IS DISTINCT FROM result->>'candidateCommit' OR COALESCE(checks->>'configHash','')!~'^[a-f0-9]{64}$' OR COALESCE(checks->'environment'->>'nodeHash','')!~'^[a-f0-9]{64}$'
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(result->'merges') WITH ORDINALITY m(value,position) WHERE value->>'resultId' IS DISTINCT FROM i.sources->(position::integer-1)->>'resultId' OR COALESCE(value->>'sourceCommit','')!~'^[a-f0-9]{40}$' OR COALESCE(value->>'mergedCommit','')!~'^[a-f0-9]{40}$' OR COALESCE(value->>'tree','')!~'^[a-f0-9]{40}$')
   OR jsonb_typeof(checks->'steps') IS DISTINCT FROM 'array' OR jsonb_array_length(checks->'steps')<>jsonb_array_length(configuration->'steps')
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(checks->'steps') WITH ORDINALITY s(value,position) WHERE value->'exitCode' IS DISTINCT FROM '0'::jsonb OR value->'cleanupConfirmed' IS DISTINCT FROM 'true'::jsonb OR value->'sourceUnchanged' IS DISTINCT FROM 'true'::jsonb OR value->'error' IS DISTINCT FROM 'null'::jsonb OR jsonb_build_object('tool',value->'tool','args',value->'args','timeoutSeconds',value->'timeoutSeconds') IS DISTINCT FROM configuration->'steps'->(position::integer-1))
  THEN RAISE EXCEPTION 'invalid_integration' USING ERRCODE='P0001'; END IF;
 END IF;
 outcome:=CASE WHEN requested_outcome='unknown' THEN 'unknown' WHEN NOT collab_worker.integration_authorized(candidate) THEN 'revoked' WHEN NOT collab_worker.integration_current(candidate) THEN 'stale' WHEN i.stop_requested THEN 'cancelled' ELSE requested_outcome END;
 UPDATE collab.integrations SET status=outcome,evidence=result,error_code=failure,finished_at=now() WHERE id=candidate;
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(i.organization_id,i.project_id,i.requested_by,'integration.'||outcome,candidate::text,jsonb_build_object('targetSha',i.target_sha,'inputHash',i.input_hash));
 RETURN outcome;
END $$;
REVOKE ALL ON FUNCTION collab_worker.integration_authorized(uuid),collab_worker.integration_current(uuid),collab.integration_state(uuid),collab.request_integration(uuid,text,uuid[],uuid,uuid),collab.cancel_integration(uuid,text,uuid),collab_worker.claim_integration(uuid),collab_worker.heartbeat_integration(uuid,uuid,bigint,boolean),collab_worker.finish_integration(uuid,uuid,bigint,text,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.integration_state(uuid),collab.request_integration(uuid,text,uuid[],uuid,uuid),collab.cancel_integration(uuid,text,uuid) TO pi_collab_app;
GRANT EXECUTE ON FUNCTION collab_worker.claim_integration(uuid),collab_worker.heartbeat_integration(uuid,uuid,bigint,boolean),collab_worker.finish_integration(uuid,uuid,bigint,text,jsonb,text) TO pi_collab_executor;
