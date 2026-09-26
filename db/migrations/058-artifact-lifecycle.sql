CREATE TABLE collab_worker.artifact_policies (
 project_id uuid PRIMARY KEY REFERENCES collab.projects(id), version integer NOT NULL,
 byte_limit bigint NOT NULL CHECK(byte_limit BETWEEN 536870912 AND 10995116277760),
 candidate_days integer NOT NULL CHECK(candidate_days BETWEEN 1 AND 3650),
 workspace_days integer NOT NULL CHECK(workspace_days BETWEEN 1 AND 3650),
 audit_days integer NOT NULL CHECK(audit_days BETWEEN 180 AND 3650)
);
CREATE TABLE collab_worker.artifacts (
 kind text NOT NULL CHECK(kind IN ('workspace','snapshot','validation','integration','repository')), id uuid NOT NULL,
 organization_id uuid NOT NULL, project_id uuid NOT NULL REFERENCES collab.projects(id), owner_id text,
 reserved_bytes bigint NOT NULL, bytes bigint CHECK(bytes>=0), measurement_error text, measured_at timestamptz,
 state text NOT NULL DEFAULT 'retained' CHECK(state IN ('retained','deleting','deleted')),
 retain_until timestamptz NOT NULL, born_at timestamptz NOT NULL, PRIMARY KEY(kind,id)
);
CREATE TABLE collab_worker.artifact_operations (
 project_id uuid NOT NULL, actor_id text NOT NULL, request_key uuid NOT NULL, payload jsonb NOT NULL, result jsonb NOT NULL,
 PRIMARY KEY(project_id,actor_id,request_key)
);
CREATE TABLE collab_worker.artifact_cleanup (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind text NOT NULL, artifact_id uuid NOT NULL, project_id uuid NOT NULL,
 actor_id text NOT NULL, organization_version bigint NOT NULL, project_version bigint NOT NULL, reason text NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','deleting','deleted','cancelled','attention')),
 lease_until timestamptz, worker uuid, error_code text, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 FOREIGN KEY(kind,artifact_id) REFERENCES collab_worker.artifacts(kind,id), UNIQUE(kind,artifact_id)
);
CREATE FUNCTION collab_worker.artifact_policy(project uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('version',coalesce(p.version,0),'byteLimit',coalesce(p.byte_limit,107374182400),'candidateDays',coalesce(p.candidate_days,90),'workspaceDays',coalesce(p.workspace_days,7),'auditDays',coalesce(p.audit_days,180))
 FROM (SELECT 1) seed LEFT JOIN collab_worker.artifact_policies p ON p.project_id=project
$$;
CREATE VIEW collab_worker.artifact_inventory AS
 SELECT 'workspace'::text AS kind,w.id,w.organization_id,w.project_id,w.created_by AS owner_id,w.created_at AS born_at,t.title AS title,w.status,r.status AS run_status,w.runtime,
 jsonb_build_object('runId',r.id,'executorId',r.executor_id,'epoch',r.epoch::text,'archivedAt',w.archived_at,'workspaceRetainUntil',w.retain_until) AS details
 FROM collab.workspaces w JOIN collab.tasks t ON t.id=w.task_id JOIN collab.runs r ON r.workspace_id=w.id
 UNION ALL SELECT 'snapshot',s.id,s.organization_id,s.project_id,s.requested_by,s.created_at,t.title,s.status,NULL,w.runtime,'{}'::jsonb FROM collab.snapshots s JOIN collab.tasks t ON t.id=s.task_id JOIN collab.workspaces w ON w.id=s.workspace_id
 UNION ALL SELECT 'validation',v.id,v.organization_id,v.project_id,v.requested_by,v.created_at,p.name,v.status,NULL,w.runtime,'{}'::jsonb FROM collab.validations v JOIN collab.validation_profiles p ON p.id=v.profile_id JOIN collab.snapshots s ON s.id=v.snapshot_id JOIN collab.workspaces w ON w.id=s.workspace_id
 UNION ALL SELECT 'integration',i.id,i.organization_id,i.project_id,i.requested_by,i.created_at,r.name,i.status,NULL,i.runtime,jsonb_build_object('checkId',i.check_id) FROM collab.integrations i JOIN collab.repositories r ON r.id=i.repository_id
 UNION ALL SELECT 'repository',r.id,r.organization_id,r.project_id,NULL,r.created_at,r.name,'retained',NULL,NULL,'{}'::jsonb FROM collab.repositories r;
CREATE FUNCTION collab_worker.artifact_reserve(project uuid,kind text) RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT CASE kind WHEN 'workspace' THEN 0 WHEN 'snapshot' THEN 536870912 WHEN 'integration' THEN 536870912+2*(collab_worker.runtime_policy(project)->>'workspaceBytes')::bigint ELSE (collab_worker.runtime_policy(project)->>'workspaceBytes')::bigint END
$$;
CREATE FUNCTION collab_worker.artifact_charge(project uuid) RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT coalesce(sum(CASE WHEN a.state='deleted' THEN 0 ELSE greatest(coalesce(a.bytes,a.reserved_bytes),CASE WHEN i.status IN ('pending','queued','running','integrating','checking','unknown') OR a.measurement_error IS NOT NULL THEN a.reserved_bytes ELSE 0 END) END),0)
 FROM collab_worker.artifacts a JOIN collab_worker.artifact_inventory i ON i.kind=a.kind AND i.id=a.id WHERE a.project_id=project AND a.kind<>'workspace'
$$;
CREATE FUNCTION collab_worker.register_artifact() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE k text:=TG_ARGV[0]; i record; reserve bigint; policy jsonb;
BEGIN
 -- Workspace insertion precedes its run row; registration is completed by run insertion.
 SELECT * INTO i FROM collab_worker.artifact_inventory WHERE kind=k AND id=(to_jsonb(NEW)->>CASE WHEN TG_TABLE_NAME='runs' THEN 'workspace_id' ELSE 'id' END)::uuid;
 IF i.id IS NULL THEN RETURN NEW;END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(i.organization_id::text,811));
 policy:=collab_worker.artifact_policy(i.project_id);reserve:=collab_worker.artifact_reserve(i.project_id,k);
 IF k<>'workspace' AND (collab_worker.artifact_charge(i.project_id)+reserve>(policy->>'byteLimit')::bigint OR EXISTS(SELECT 1 FROM collab_worker.artifacts WHERE project_id=i.project_id AND kind<>'workspace' AND state<>'deleted' AND measurement_error IS NOT NULL)) THEN RAISE EXCEPTION 'artifact_budget_exhausted' USING ERRCODE='P0001';END IF;
 INSERT INTO collab_worker.artifacts(kind,id,organization_id,project_id,owner_id,reserved_bytes,retain_until,born_at) VALUES(k,i.id,i.organization_id,i.project_id,i.owner_id,reserve,i.born_at+make_interval(days=>(policy->>CASE WHEN k='workspace' THEN 'workspaceDays' ELSE 'candidateDays' END)::integer),i.born_at);
 RETURN NEW;
END $$;
CREATE TRIGGER register_workspace_artifact AFTER INSERT ON collab.runs FOR EACH ROW EXECUTE FUNCTION collab_worker.register_artifact('workspace');
CREATE TRIGGER register_snapshot_artifact AFTER INSERT ON collab.snapshots FOR EACH ROW EXECUTE FUNCTION collab_worker.register_artifact('snapshot');
CREATE TRIGGER register_validation_artifact AFTER INSERT ON collab.validations FOR EACH ROW EXECUTE FUNCTION collab_worker.register_artifact('validation');
CREATE TRIGGER register_integration_artifact AFTER INSERT ON collab.integrations FOR EACH ROW EXECUTE FUNCTION collab_worker.register_artifact('integration');
CREATE TRIGGER register_repository_artifact AFTER INSERT ON collab.repositories FOR EACH ROW EXECUTE FUNCTION collab_worker.register_artifact('repository');
INSERT INTO collab_worker.artifacts(kind,id,organization_id,project_id,owner_id,reserved_bytes,retain_until,born_at)
 SELECT kind,id,organization_id,project_id,owner_id,collab_worker.artifact_reserve(project_id,kind),born_at+CASE WHEN kind='workspace' THEN interval '7 days' ELSE interval '90 days' END,born_at FROM collab_worker.artifact_inventory;

-- Return an explainable protection reason; no blanket force-delete capability exists.
CREATE FUNCTION collab_worker.artifact_protection(k text,artifact uuid) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a collab_worker.artifacts; i record;
BEGIN
 SELECT * INTO a FROM collab_worker.artifacts WHERE kind=k AND id=artifact;IF a.id IS NULL THEN RETURN 'unregistered';END IF;
 IF a.state<>'retained' THEN RETURN a.state;END IF;
 SELECT * INTO i FROM collab_worker.artifact_inventory WHERE kind=k AND id=artifact;
 IF k='repository' THEN RETURN 'repository_baseline';END IF;
 IF k='workspace' THEN
  IF i.status<>'archived' OR i.run_status NOT IN ('completed','failed','cancelled') THEN RETURN 'workspace_not_archived';END IF;
  IF EXISTS(SELECT 1 FROM collab.snapshots WHERE workspace_id=artifact AND status IN ('pending','ready')) OR EXISTS(SELECT 1 FROM collab_git.workspace_operations WHERE workspace_id=artifact AND status NOT IN ('applied','aborted')) OR EXISTS(SELECT 1 FROM collab_git.push_previews WHERE workspace_id=artifact) THEN RETURN 'workspace_referenced';END IF;
  IF (SELECT retain_until FROM collab.workspaces WHERE id=artifact)>clock_timestamp() THEN RETURN 'retention';END IF;
 ELSIF k='snapshot' THEN
  IF i.status='pending' THEN RETURN 'active';END IF;
  IF EXISTS(SELECT 1 FROM collab.task_results WHERE snapshot_id=artifact) OR EXISTS(SELECT 1 FROM collab.validations WHERE snapshot_id=artifact) OR EXISTS(SELECT 1 FROM collab.workspaces WHERE source_snapshot_id=artifact) OR EXISTS(SELECT 1 FROM collab.editor_sessions WHERE snapshot_id=artifact) OR EXISTS(SELECT 1 FROM collab.discussion_threads WHERE anchor->>'snapshotId'=artifact::text) OR EXISTS(SELECT 1 FROM collab.checkpoint_previews WHERE snapshot_id=artifact) THEN RETURN 'snapshot_referenced';END IF;
 ELSIF k='validation' THEN
  IF i.status IN ('queued','running','unknown') THEN RETURN 'active_or_unknown';END IF;
  IF EXISTS(SELECT 1 FROM collab.task_results WHERE validation_id=artifact) OR EXISTS(SELECT 1 FROM collab.checkpoint_previews WHERE validation_id=artifact) THEN RETURN 'validation_referenced';END IF;
  IF NOT EXISTS(SELECT 1 FROM collab.validations WHERE id=artifact AND (started_at IS NULL OR (evidence IS NOT NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(evidence->'steps') step WHERE step->'cleanupConfirmed' IS DISTINCT FROM 'true'::jsonb)))) THEN RETURN 'exit_unconfirmed';END IF;
 ELSIF k='integration' THEN
  IF i.status IN ('queued','integrating','checking','unknown') THEN RETURN 'active_or_unknown';END IF;
  IF EXISTS(SELECT 1 FROM collab.resolution_tasks WHERE integration_id=artifact) OR EXISTS(SELECT 1 FROM collab.promotions WHERE integration_id=artifact) OR EXISTS(SELECT 1 FROM collab.integration_reviews WHERE integration_id=artifact) THEN RETURN 'integration_referenced';END IF;
  IF EXISTS(SELECT 1 FROM collab.integrations WHERE id=artifact AND evidence->'validation' IS NOT NULL AND evidence->'validation'<>'null'::jsonb AND EXISTS(SELECT 1 FROM jsonb_array_elements(evidence->'validation'->'steps') step WHERE step->'cleanupConfirmed' IS DISTINCT FROM 'true'::jsonb)) THEN RETURN 'exit_unconfirmed';END IF;
 END IF;
 IF greatest(a.retain_until,(i.details->>'workspaceRetainUntil')::timestamptz,coalesce((i.details->>'archivedAt')::timestamptz,a.born_at)+make_interval(days=>(collab_worker.artifact_policy(a.project_id)->>CASE WHEN k='workspace' THEN 'workspaceDays' ELSE 'candidateDays' END)::integer))>clock_timestamp() THEN RETURN 'retention';END IF;
 IF a.bytes IS NULL OR a.measurement_error IS NOT NULL THEN RETURN 'measurement_unknown';END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION collab.artifact_context(project uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF collab.project_role(project) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 RETURN collab_worker.artifact_policy(project)||jsonb_build_object('canManage',collab.project_role(project)='maintainer','chargedBytes',collab_worker.artifact_charge(project)::text,
 'artifacts',(SELECT coalesce(jsonb_agg(row ORDER BY row.born_at DESC),'[]'::jsonb) FROM (SELECT a.kind,a.id,i.title,a.bytes::text,a.reserved_bytes::text,a.measured_at,a.measurement_error,a.state,greatest(a.retain_until,(i.details->>'workspaceRetainUntil')::timestamptz,coalesce((i.details->>'archivedAt')::timestamptz,a.born_at)+make_interval(days=>(collab_worker.artifact_policy(project)->>CASE WHEN a.kind='workspace' THEN 'workspaceDays' ELSE 'candidateDays' END)::integer)) AS retain_until,a.born_at,collab_worker.artifact_protection(a.kind,a.id) AS protection,j.id AS cleanup_id,j.status AS cleanup_status,j.error_code FROM collab_worker.artifacts a JOIN collab_worker.artifact_inventory i ON i.kind=a.kind AND i.id=a.id LEFT JOIN collab_worker.artifact_cleanup j ON j.kind=a.kind AND j.artifact_id=a.id WHERE a.project_id=project ORDER BY a.born_at DESC,a.id LIMIT 200) row),
 'expiredAuditCount',(SELECT count(*) FROM collab.audit_events WHERE project_id=project AND created_at<clock_timestamp()-make_interval(days=>(collab_worker.artifact_policy(project)->>'auditDays')::integer)));
END $$;
CREATE FUNCTION collab.manage_artifacts(project uuid,input jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE org uuid; old collab_worker.artifact_operations; policy jsonb; result jsonb; candidate collab_worker.artifacts; protection text; job uuid; deleted_count integer; digest text;
BEGIN
 SELECT organization_id INTO org FROM collab.projects WHERE id=project;
 IF org IS NULL OR collab.project_role(project) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(org::text,811));
 IF collab.project_role(project) IS DISTINCT FROM 'maintainer' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001';END IF;
 IF NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001';END IF;
 IF length(btrim(input->>'reason')) NOT BETWEEN 10 AND 2000 OR input->>'reason' IS NULL THEN RAISE EXCEPTION 'invalid_artifact_operation' USING ERRCODE='P0001';END IF;
 SELECT * INTO old FROM collab_worker.artifact_operations WHERE project_id=project AND actor_id=collab.actor() AND request_key=(input->>'idempotencyKey')::uuid;
 IF FOUND THEN IF old.payload IS DISTINCT FROM input THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001';END IF;RETURN old.result;END IF;
 policy:=collab_worker.artifact_policy(project);
 IF input->>'action'='policy' THEN
  IF (input->>'expectedVersion')::integer IS DISTINCT FROM (policy->>'version')::integer THEN RAISE EXCEPTION 'stale_revision' USING ERRCODE='P0001';END IF;
  INSERT INTO collab_worker.artifact_policies VALUES(project,(policy->>'version')::integer+1,(input->>'byteLimit')::bigint,(input->>'candidateDays')::integer,(input->>'workspaceDays')::integer,(input->>'auditDays')::integer)
  ON CONFLICT(project_id) DO UPDATE SET version=excluded.version,byte_limit=excluded.byte_limit,candidate_days=excluded.candidate_days,workspace_days=excluded.workspace_days,audit_days=excluded.audit_days;
  result:=jsonb_build_object('version',(policy->>'version')::integer+1);
 ELSIF input->>'action'='cleanup' AND input->'acknowledge'='true'::jsonb THEN
  SELECT * INTO candidate FROM collab_worker.artifacts WHERE kind=input->>'kind' AND id=(input->>'artifactId')::uuid AND project_id=project;
  IF candidate.id IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
  -- A retired candidate can retry only its already fixed deletion paths.
  IF candidate.state='deleting' AND EXISTS(SELECT 1 FROM collab_worker.artifact_cleanup WHERE kind=candidate.kind AND artifact_id=candidate.id AND status='attention') THEN
   UPDATE collab_worker.artifact_cleanup SET status='deleting',lease_until=clock_timestamp()-interval '1 second',worker=NULL,error_code=NULL,finished_at=NULL WHERE kind=candidate.kind AND artifact_id=candidate.id RETURNING id INTO job;
   result:=jsonb_build_object('cleanupId',job,'status','deleting');
  ELSE
  protection:=collab_worker.artifact_protection(candidate.kind,candidate.id);
  IF protection IS NOT NULL THEN RAISE EXCEPTION 'artifact_protected' USING ERRCODE='P0001',DETAIL=protection;END IF;
  INSERT INTO collab_worker.artifact_cleanup(kind,artifact_id,project_id,actor_id,organization_version,project_version,reason) VALUES(candidate.kind,candidate.id,project,collab.actor(),(SELECT authorization_version FROM collab.memberships WHERE organization_id=org AND user_id=collab.actor()),(SELECT authorization_version FROM collab.project_memberships WHERE project_id=project AND user_id=collab.actor()),input->>'reason')
  ON CONFLICT(kind,artifact_id) DO UPDATE SET status='queued',actor_id=excluded.actor_id,organization_version=excluded.organization_version,project_version=excluded.project_version,reason=excluded.reason,error_code=NULL,finished_at=NULL
  WHERE collab_worker.artifact_cleanup.status='cancelled' RETURNING id INTO job;
  IF job IS NULL THEN RAISE EXCEPTION 'artifact_cleanup_pending' USING ERRCODE='P0001';END IF;
  result:=jsonb_build_object('cleanupId',job,'status','queued');
  END IF;
 ELSIF input->>'action'='audit' AND input->'acknowledge'='true'::jsonb THEN
  WITH chosen AS (SELECT id FROM collab.audit_events WHERE project_id=project AND created_at<clock_timestamp()-make_interval(days=>(policy->>'auditDays')::integer) ORDER BY id LIMIT 1000), removed AS (DELETE FROM collab.audit_events WHERE id IN (SELECT id FROM chosen) RETURNING *)
  SELECT count(*)::integer,encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(removed) ORDER BY id),'[]'::jsonb)::text,'UTF8')),'hex') INTO deleted_count,digest FROM removed;
  result:=jsonb_build_object('deletedCount',deleted_count,'batchHash',digest);
 ELSE RAISE EXCEPTION 'invalid_artifact_operation' USING ERRCODE='P0001';END IF;
 INSERT INTO collab_worker.artifact_operations VALUES(project,collab.actor(),(input->>'idempotencyKey')::uuid,input,result);
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(org,project,collab.actor(),'artifacts.'||(input->>'action'),project::text,jsonb_build_object('request',input-'idempotencyKey','result',result));
 RETURN result;
END $$;
CREATE FUNCTION collab_worker.artifact_scan_candidates() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT coalesce(jsonb_agg(row),'[]'::jsonb) FROM (SELECT a.kind,a.id,a.reserved_bytes::text AS limit_bytes,i.details FROM collab_worker.artifacts a JOIN collab_worker.artifact_inventory i ON i.kind=a.kind AND i.id=a.id WHERE a.state='retained' AND (a.measured_at IS NULL OR a.measured_at<clock_timestamp()-interval '10 minutes') AND i.status NOT IN ('pending','queued','running','starting','busy','integrating','checking','unknown') ORDER BY a.measured_at NULLS FIRST,a.born_at LIMIT 3) row
$$;
CREATE FUNCTION collab_worker.artifact_measurement(k text,artifact uuid,measured bigint,failure text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF measured<0 OR (measured IS NULL AND failure IS NULL) OR failure NOT IN ('scan_limit','unavailable') THEN RAISE EXCEPTION 'invalid_artifact_operation' USING ERRCODE='P0001';END IF;
 UPDATE collab_worker.artifacts SET bytes=CASE WHEN failure IS NULL THEN measured ELSE greatest(bytes,measured) END,measurement_error=failure,measured_at=clock_timestamp() WHERE kind=k AND id=artifact AND state='retained';
END $$;
CREATE FUNCTION collab_worker.artifact_limit(k text,artifact uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('kind',a.kind,'id',a.id,'limit_bytes',a.reserved_bytes::text,'details',i.details) FROM collab_worker.artifacts a JOIN collab_worker.artifact_inventory i ON i.kind=a.kind AND i.id=a.id WHERE a.kind=k AND a.id=artifact AND a.state='retained'
$$;
CREATE FUNCTION collab_worker.claim_artifact_cleanup(worker_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j collab_worker.artifact_cleanup; a collab_worker.artifacts; i record; protection text; authorized boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(82467158);
 SELECT * INTO j FROM collab_worker.artifact_cleanup WHERE status='queued' OR (status='deleting' AND lease_until<clock_timestamp()) ORDER BY created_at LIMIT 1 FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO STRICT a FROM collab_worker.artifacts WHERE kind=j.kind AND id=j.artifact_id;
 PERFORM pg_advisory_xact_lock(hashtextextended(a.organization_id::text,811));
 SELECT * INTO STRICT i FROM collab_worker.artifact_inventory WHERE kind=j.kind AND id=j.artifact_id;
 IF j.status='queued' THEN
  SELECT EXISTS(SELECT 1 FROM collab.memberships m JOIN collab.project_memberships p ON p.organization_id=m.organization_id AND p.user_id=m.user_id JOIN public."user" u ON u.id=m.user_id WHERE m.organization_id=a.organization_id AND m.user_id=j.actor_id AND m.active AND p.project_id=j.project_id AND p.active AND p.role='maintainer' AND m.authorization_version=j.organization_version AND p.authorization_version=j.project_version AND u."twoFactorEnabled") INTO authorized;
  protection:=collab_worker.artifact_protection(j.kind,j.artifact_id);
  IF NOT authorized OR protection IS NOT NULL THEN UPDATE collab_worker.artifact_cleanup SET status='cancelled',error_code=CASE WHEN NOT authorized THEN 'authorization_changed' ELSE protection END,finished_at=now() WHERE id=j.id;RETURN NULL;END IF;
  UPDATE collab_worker.artifacts SET state='deleting' WHERE kind=j.kind AND id=j.artifact_id;
  IF j.kind='snapshot' THEN UPDATE collab.snapshots SET status='revoked',error_code='storage_expired' WHERE id=j.artifact_id;
  ELSIF j.kind='integration' THEN UPDATE collab.integrations SET status='revoked',error_code='storage_expired' WHERE id=j.artifact_id;END IF;
 END IF;
 UPDATE collab_worker.artifact_cleanup SET status='deleting',worker=worker_id,lease_until=clock_timestamp()+interval '5 minutes' WHERE id=j.id;
 RETURN jsonb_build_object('jobId',j.id,'kind',j.kind,'id',j.artifact_id,'runtime',i.runtime,'details',i.details);
END $$;
CREATE FUNCTION collab_worker.finish_artifact_cleanup(worker_id uuid,job uuid,failure text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j collab_worker.artifact_cleanup; a collab_worker.artifacts;
BEGIN
 SELECT * INTO j FROM collab_worker.artifact_cleanup WHERE id=job FOR UPDATE;
 IF j.worker IS DISTINCT FROM worker_id OR j.status<>'deleting' THEN RETURN;END IF;
 SELECT * INTO a FROM collab_worker.artifacts WHERE kind=j.kind AND id=j.artifact_id;
 IF failure IS NULL THEN
  UPDATE collab_worker.artifacts SET state='deleted',bytes=0,measurement_error=NULL,measured_at=clock_timestamp() WHERE kind=j.kind AND id=j.artifact_id;
  IF j.kind='workspace' THEN UPDATE collab_worker.workspace_usage SET bytes=0,error_code=NULL,measured_at=clock_timestamp() WHERE workspace_id=j.artifact_id;END IF;
 END IF;
 UPDATE collab_worker.artifact_cleanup SET status=CASE WHEN failure IS NULL THEN 'deleted' ELSE 'attention' END,error_code=failure,finished_at=clock_timestamp() WHERE id=job;
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(a.organization_id,a.project_id,j.actor_id,'artifact.cleanup_finished',a.id::text,jsonb_build_object('kind',a.kind,'jobId',job,'failure',failure));
END $$;
CREATE FUNCTION collab_worker.guard_deleted_workspace() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM collab_worker.artifacts WHERE kind='workspace' AND id=NEW.workspace_id AND state<>'retained') THEN RAISE EXCEPTION 'artifact_expired' USING ERRCODE='P0001';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER snapshot_live_workspace BEFORE INSERT ON collab.snapshots FOR EACH ROW EXECUTE FUNCTION collab_worker.guard_deleted_workspace();
REVOKE ALL ON ALL TABLES IN SCHEMA collab_worker FROM PUBLIC;
REVOKE ALL ON FUNCTION collab_worker.artifact_policy(uuid),collab_worker.artifact_reserve(uuid,text),collab_worker.artifact_charge(uuid),collab_worker.register_artifact(),collab_worker.artifact_protection(text,uuid),collab.artifact_context(uuid),collab.manage_artifacts(uuid,jsonb),collab_worker.artifact_scan_candidates(),collab_worker.artifact_measurement(text,uuid,bigint,text),collab_worker.artifact_limit(text,uuid),collab_worker.claim_artifact_cleanup(uuid),collab_worker.finish_artifact_cleanup(uuid,uuid,text),collab_worker.guard_deleted_workspace() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.artifact_context(uuid),collab.manage_artifacts(uuid,jsonb) TO pi_collab_app;
GRANT EXECUTE ON FUNCTION collab_worker.artifact_scan_candidates(),collab_worker.artifact_measurement(text,uuid,bigint,text),collab_worker.artifact_limit(text,uuid),collab_worker.claim_artifact_cleanup(uuid),collab_worker.finish_artifact_cleanup(uuid,uuid,text) TO pi_collab_executor;

CREATE TRIGGER operations_admission BEFORE INSERT ON collab_worker.artifact_cleanup FOR EACH ROW EXECUTE FUNCTION collab_meta.guard_admission();
