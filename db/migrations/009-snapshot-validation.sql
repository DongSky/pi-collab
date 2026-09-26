-- Immutable maintainer configuration + actual supervised native checks.
-- Expired executions become unknown. Commands are never automatically retried.
CREATE TABLE collab.validation_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, project_id uuid NOT NULL, repository_id uuid NOT NULL,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120), config jsonb NOT NULL,
  created_by text NOT NULL REFERENCES public."user"(id), idempotency_key uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,project_id,id), UNIQUE(created_by,project_id,idempotency_key),
  FOREIGN KEY(organization_id,project_id,repository_id) REFERENCES collab.repositories(organization_id,project_id,id)
);
CREATE TABLE collab.validations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, project_id uuid NOT NULL, task_id uuid NOT NULL,
  snapshot_id uuid NOT NULL, profile_id uuid NOT NULL, manifest_hash text NOT NULL CHECK(manifest_hash ~ '^[a-f0-9]{64}$'),
  requested_by text NOT NULL REFERENCES public."user"(id), idempotency_key uuid NOT NULL,
  organization_version bigint NOT NULL, project_version bigint NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','passed','failed','cancelled','revoked','unknown')),
  executor_id uuid, epoch bigint NOT NULL DEFAULT 0, lease_expires_at timestamptz, stop_requested boolean NOT NULL DEFAULT false,
  evidence jsonb, error_code text, created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz,
  UNIQUE(organization_id,project_id,task_id,id), UNIQUE(requested_by,snapshot_id,idempotency_key),
  FOREIGN KEY(organization_id,project_id,task_id,snapshot_id) REFERENCES collab.snapshots(organization_id,project_id,task_id,id),
  FOREIGN KEY(organization_id,project_id,profile_id) REFERENCES collab.validation_profiles(organization_id,project_id,id)
);
CREATE UNIQUE INDEX validations_one_active_snapshot ON collab.validations(snapshot_id) WHERE status IN ('queued','running','unknown');
CREATE INDEX validations_queue ON collab.validations(created_at,id) WHERE status='queued';
ALTER TABLE collab.validation_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE collab.validations ENABLE ROW LEVEL SECURITY;
CREATE POLICY validation_profiles_read ON collab.validation_profiles FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
CREATE POLICY validations_read ON collab.validations FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
GRANT SELECT ON collab.validation_profiles,collab.validations TO pi_collab_app;

CREATE FUNCTION collab.valid_validation_config(config jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE step jsonb; argument jsonb;
BEGIN
  IF jsonb_typeof(config) IS DISTINCT FROM 'object' OR config->'version' IS DISTINCT FROM '1'::jsonb
    OR jsonb_typeof(config->'steps') IS DISTINCT FROM 'array' OR config - ARRAY['version','steps'] <> '{}'::jsonb THEN RETURN false; END IF;
  IF jsonb_array_length(config->'steps') NOT BETWEEN 1 AND 5 OR octet_length(config::text)>16384 THEN RETURN false; END IF;
  FOR step IN SELECT value FROM jsonb_array_elements(config->'steps') LOOP
    IF jsonb_typeof(step) IS DISTINCT FROM 'object' OR step->>'tool' IS NULL OR step->>'tool' NOT IN ('node','npm')
      OR jsonb_typeof(step->'args') IS DISTINCT FROM 'array' OR jsonb_typeof(step->'timeoutSeconds') IS DISTINCT FROM 'number'
      OR step - ARRAY['tool','args','timeoutSeconds'] <> '{}'::jsonb THEN RETURN false; END IF;
    IF jsonb_array_length(step->'args') NOT BETWEEN 1 AND 32 OR (step->>'timeoutSeconds') !~ '^[0-9]{1,3}$' THEN RETURN false; END IF;
    IF (step->>'timeoutSeconds')::integer NOT BETWEEN 1 AND 600 THEN RETURN false; END IF;
    FOR argument IN SELECT value FROM jsonb_array_elements(step->'args') LOOP
      IF jsonb_typeof(argument)<>'string' OR length(argument #>> '{}')>1000 OR (argument #>> '{}') ~ '[[:cntrl:]]' THEN RETURN false; END IF;
    END LOOP;
  END LOOP;
  RETURN true;
END
$$;
ALTER TABLE collab.validation_profiles ADD CONSTRAINT validation_config_valid CHECK(collab.valid_validation_config(config));

CREATE FUNCTION collab.create_validation_profile(project uuid, repository uuid, label text, configuration jsonb, request_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE org uuid; previous collab.validation_profiles; profile uuid := gen_random_uuid();
BEGIN
  SELECT organization_id INTO org FROM collab.projects WHERE id=project;
  IF org IS NULL OR collab.project_role(project) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(org::text,811));
  IF collab.project_role(project) IS DISTINCT FROM 'maintainer' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
  IF collab.user_requires_mfa(collab.actor()) AND NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
  IF request_key IS NULL OR label IS NULL OR length(btrim(label)) NOT BETWEEN 1 AND 120 OR NOT collab.valid_validation_config(configuration) THEN RAISE EXCEPTION 'invalid_validation' USING ERRCODE='P0001'; END IF;
  SELECT * INTO previous FROM collab.validation_profiles WHERE project_id=project AND created_by=collab.actor() AND idempotency_key=request_key;
  IF FOUND THEN
    IF previous.repository_id IS DISTINCT FROM repository OR previous.name<>btrim(label) OR previous.config<>configuration THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
    RETURN jsonb_build_object('profileId',previous.id,'replayed',true);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM collab.repositories WHERE id=repository AND project_id=project) THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
  INSERT INTO collab.validation_profiles(id,organization_id,project_id,repository_id,name,config,created_by,idempotency_key)
    VALUES(profile,org,project,repository,btrim(label),configuration,collab.actor(),request_key);
  INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id) VALUES(org,project,collab.actor(),'validation_profile.created',profile::text);
  RETURN jsonb_build_object('profileId',profile,'replayed',false);
END
$$;

CREATE FUNCTION collab.request_validation(snapshot uuid, profile uuid, request_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s collab.snapshots; t collab.tasks; role text; previous collab.validations; validation uuid := gen_random_uuid(); org_version bigint; member_version bigint;
BEGIN
  SELECT * INTO s FROM collab.snapshots WHERE id=snapshot;
  IF s.id IS NULL OR collab.project_role(s.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(s.organization_id::text,811));
  SELECT * INTO STRICT t FROM collab.tasks WHERE id=s.task_id;
  role := collab.project_role(s.project_id);
  IF role IS NULL OR role NOT IN ('maintainer','developer') OR (role<>'maintainer' AND t.owner_id<>collab.actor()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
  IF collab.user_requires_mfa(collab.actor()) AND NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
  IF request_key IS NULL OR profile IS NULL THEN RAISE EXCEPTION 'invalid_validation' USING ERRCODE='P0001'; END IF;
  SELECT * INTO previous FROM collab.validations WHERE snapshot_id=snapshot AND requested_by=collab.actor() AND idempotency_key=request_key;
  IF FOUND THEN
    IF previous.profile_id<>profile THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
    RETURN jsonb_build_object('validationId',previous.id,'status',previous.status,'replayed',true);
  END IF;
  IF s.status<>'ready' OR NOT EXISTS(SELECT 1 FROM collab.validation_profiles p JOIN collab.workspaces w ON w.repository_id=p.repository_id WHERE p.id=profile AND p.project_id=s.project_id AND w.id=s.workspace_id AND w.runtime='native') THEN RAISE EXCEPTION 'validation_source_unavailable' USING ERRCODE='P0001'; END IF;
  IF EXISTS(SELECT 1 FROM collab.validations WHERE snapshot_id=snapshot AND status IN ('queued','running','unknown')) THEN RAISE EXCEPTION 'validation_busy' USING ERRCODE='P0001'; END IF;
  SELECT authorization_version INTO org_version FROM collab.memberships WHERE organization_id=s.organization_id AND user_id=collab.actor();
  SELECT authorization_version INTO member_version FROM collab.project_memberships WHERE project_id=s.project_id AND user_id=collab.actor();
  INSERT INTO collab.validations(id,organization_id,project_id,task_id,snapshot_id,profile_id,manifest_hash,requested_by,idempotency_key,organization_version,project_version)
    VALUES(validation,s.organization_id,s.project_id,s.task_id,snapshot,profile,s.manifest_hash,collab.actor(),request_key,org_version,member_version);
  INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(s.organization_id,s.project_id,collab.actor(),'validation.requested',validation::text,jsonb_build_object('snapshotId',snapshot,'profileId',profile));
  RETURN jsonb_build_object('validationId',validation,'status','queued','replayed',false);
END
$$;

CREATE FUNCTION collab_worker.validation_authorized(validation uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS(SELECT 1 FROM collab.validations v JOIN collab.tasks t ON t.id=v.task_id
    JOIN collab.snapshots s ON s.id=v.snapshot_id AND s.status='ready' AND s.manifest_hash=v.manifest_hash
    JOIN collab.memberships m ON m.organization_id=v.organization_id AND m.user_id=v.requested_by
    JOIN collab.project_memberships pm ON pm.project_id=v.project_id AND pm.user_id=v.requested_by JOIN public."user" u ON u.id=v.requested_by
    WHERE v.id=validation AND m.active AND m.authorization_version=v.organization_version AND pm.active AND pm.authorization_version=v.project_version
      AND pm.role IN ('maintainer','developer') AND (pm.role='maintainer' OR t.owner_id=v.requested_by) AND (m.role='member' OR u."twoFactorEnabled"))
$$;

CREATE FUNCTION collab.cancel_validation(validation uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v collab.validations; role text;
BEGIN
  SELECT * INTO v FROM collab.validations WHERE id=validation;
  IF v.id IS NULL OR collab.project_role(v.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v.organization_id::text,811));
  SELECT * INTO STRICT v FROM collab.validations WHERE id=validation FOR UPDATE;
  role := collab.project_role(v.project_id);
  IF role IS NULL OR role NOT IN ('maintainer','developer') OR (role<>'maintainer' AND (v.requested_by<>collab.actor() OR NOT EXISTS(SELECT 1 FROM collab.tasks WHERE id=v.task_id AND owner_id=collab.actor()))) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
  IF collab.user_requires_mfa(collab.actor()) AND NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
  IF v.status IN ('queued','running') AND NOT v.stop_requested THEN
    UPDATE collab.validations SET stop_requested=true,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,finished_at=CASE WHEN status='queued' THEN now() END WHERE id=validation;
    INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id) VALUES(v.organization_id,v.project_id,collab.actor(),'validation.stop_requested',validation::text);
  END IF;
  RETURN jsonb_build_object('validationId',validation,'status',(SELECT status FROM collab.validations WHERE id=validation));
END
$$;

CREATE FUNCTION collab_worker.claim_validation(executor uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v collab.validations; outcome text;
BEGIN
  IF executor IS NULL THEN RAISE EXCEPTION 'invalid_validation' USING ERRCODE='P0001'; END IF;
  PERFORM pg_advisory_xact_lock(82467109);
  -- No expired job is reassigned. Its workspace and possible effects remain unknown.
  FOR v IN SELECT * FROM collab.validations WHERE (status='running' AND lease_expires_at<=clock_timestamp()) OR (status='queued' AND NOT collab_worker.validation_authorized(id)) ORDER BY organization_id,id LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(v.organization_id::text,811));
    SELECT * INTO STRICT v FROM collab.validations WHERE id=v.id FOR UPDATE;
    IF v.status='running' AND v.lease_expires_at<=clock_timestamp() THEN outcome := 'unknown';
    ELSIF v.status='queued' AND NOT collab_worker.validation_authorized(v.id) THEN outcome := 'revoked';
    ELSE CONTINUE; END IF;
    UPDATE collab.validations SET status=outcome,error_code=CASE WHEN outcome='unknown' THEN 'validation_lease_expired' ELSE 'authorization_changed' END,finished_at=now() WHERE id=v.id;
    INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id) VALUES(v.organization_id,v.project_id,v.requested_by,'validation.'||outcome,v.id::text);
  END LOOP;
  SELECT candidate.* INTO v FROM collab.validations candidate WHERE status='queued' AND collab_worker.validation_authorized(candidate.id)
    AND (SELECT count(*) FROM collab.validations a WHERE a.project_id=candidate.project_id AND a.status IN ('running','unknown'))<2
    AND NOT EXISTS(SELECT 1 FROM collab.validations a WHERE a.requested_by=candidate.requested_by AND a.status IN ('running','unknown'))
    ORDER BY candidate.created_at,candidate.id LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v.organization_id::text,811));
  SELECT * INTO STRICT v FROM collab.validations WHERE id=v.id FOR UPDATE;
  IF v.status<>'queued' OR NOT collab_worker.validation_authorized(v.id) THEN RETURN NULL; END IF;
  UPDATE collab.validations SET status='running',epoch=epoch+1,executor_id=executor,lease_expires_at=clock_timestamp()+interval '30 seconds',started_at=now() WHERE id=v.id RETURNING * INTO v;
  INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id) VALUES(v.organization_id,v.project_id,v.requested_by,'validation.running',v.id::text);
  RETURN (SELECT jsonb_build_object('id',v.id,'executorId',executor,'epoch',v.epoch::text,'snapshotId',v.snapshot_id,'manifestHash',v.manifest_hash,'profileId',v.profile_id,'repositoryId',p.repository_id,'config',p.config) FROM collab.validation_profiles p WHERE p.id=v.profile_id);
END
$$;

CREATE FUNCTION collab_worker.heartbeat_validation(executor uuid, validation uuid, generation bigint) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v collab.validations;
BEGIN
  SELECT * INTO v FROM collab.validations WHERE id=validation FOR UPDATE;
  IF v.id IS NULL OR v.status<>'running' OR v.executor_id IS DISTINCT FROM executor OR v.epoch IS DISTINCT FROM generation OR v.lease_expires_at<=clock_timestamp() THEN RETURN false; END IF;
  -- Continue the lease during cancellation so confirmed cleanup can be recorded.
  UPDATE collab.validations SET lease_expires_at=clock_timestamp()+interval '30 seconds' WHERE id=validation;
  RETURN NOT v.stop_requested AND collab_worker.validation_authorized(validation);
END
$$;

CREATE FUNCTION collab_worker.finish_validation(executor uuid, validation uuid, generation bigint, requested_outcome text, result jsonb, failure text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v collab.validations; outcome text; configuration jsonb;
BEGIN
  SELECT * INTO v FROM collab.validations WHERE id=validation;
  IF v.id IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v.organization_id::text,811));
  SELECT * INTO STRICT v FROM collab.validations WHERE id=validation FOR UPDATE;
  IF v.executor_id IS DISTINCT FROM executor OR v.epoch IS DISTINCT FROM generation THEN RAISE EXCEPTION 'validation_lease_lost' USING ERRCODE='P0001'; END IF;
  IF v.status<>'running' THEN RETURN v.status; END IF;
  IF v.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'validation_lease_lost' USING ERRCODE='P0001'; END IF;
  IF requested_outcome IS NULL OR requested_outcome NOT IN ('passed','failed','cancelled','unknown') OR pg_column_size(result)>131072 OR length(failure)>120 THEN RAISE EXCEPTION 'invalid_validation' USING ERRCODE='P0001'; END IF;
  SELECT config INTO STRICT configuration FROM collab.validation_profiles WHERE id=v.profile_id;
  IF result IS NOT NULL AND (jsonb_typeof(result) IS DISTINCT FROM 'object' OR result->>'validationId' IS DISTINCT FROM v.id::text OR result->>'snapshotId' IS DISTINCT FROM v.snapshot_id::text OR result->>'manifestHash' IS DISTINCT FROM v.manifest_hash OR result->>'profileId' IS DISTINCT FROM v.profile_id::text OR result->'config' IS DISTINCT FROM configuration) THEN RAISE EXCEPTION 'invalid_validation' USING ERRCODE='P0001'; END IF;
  IF requested_outcome='passed' THEN
    IF result IS NULL OR result->>'outcome' IS DISTINCT FROM 'passed' OR jsonb_typeof(result->'steps') IS DISTINCT FROM 'array' OR failure IS NOT NULL THEN RAISE EXCEPTION 'invalid_validation' USING ERRCODE='P0001'; END IF;
    IF jsonb_array_length(result->'steps')<>jsonb_array_length(configuration->'steps') OR EXISTS(SELECT 1 FROM jsonb_array_elements(result->'steps') step WHERE step->'exitCode' IS DISTINCT FROM '0'::jsonb OR step->'cleanupConfirmed' IS DISTINCT FROM 'true'::jsonb OR step->'sourceUnchanged' IS DISTINCT FROM 'true'::jsonb OR step->'error' IS DISTINCT FROM 'null'::jsonb) THEN RAISE EXCEPTION 'invalid_validation' USING ERRCODE='P0001'; END IF;
    IF COALESCE(result->>'worktreeCommit','') !~ '^[a-f0-9]{40}$' OR COALESCE(result->>'configHash','') !~ '^[a-f0-9]{64}$'
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(result->'steps') WITH ORDINALITY AS step(value,position)
        WHERE jsonb_build_object('tool',value->'tool','args',value->'args','timeoutSeconds',value->'timeoutSeconds') IS DISTINCT FROM configuration->'steps'->(position::integer-1)) THEN RAISE EXCEPTION 'invalid_validation' USING ERRCODE='P0001'; END IF;
  END IF;
  outcome := CASE WHEN requested_outcome='unknown' THEN 'unknown' WHEN NOT collab_worker.validation_authorized(validation) THEN 'revoked' WHEN v.stop_requested THEN 'cancelled' ELSE requested_outcome END;
  UPDATE collab.validations SET status=outcome,evidence=result,error_code=CASE WHEN outcome='revoked' THEN 'authorization_changed' ELSE failure END,finished_at=now() WHERE id=validation;
  INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(v.organization_id,v.project_id,v.requested_by,'validation.'||outcome,v.id::text,jsonb_build_object('snapshotId',v.snapshot_id,'manifestHash',v.manifest_hash));
  RETURN outcome;
END
$$;

REVOKE ALL ON FUNCTION collab.valid_validation_config(jsonb),collab.create_validation_profile(uuid,uuid,text,jsonb,uuid),collab.request_validation(uuid,uuid,uuid),collab.cancel_validation(uuid),collab_worker.validation_authorized(uuid),collab_worker.claim_validation(uuid),collab_worker.heartbeat_validation(uuid,uuid,bigint),collab_worker.finish_validation(uuid,uuid,bigint,text,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.create_validation_profile(uuid,uuid,text,jsonb,uuid),collab.request_validation(uuid,uuid,uuid),collab.cancel_validation(uuid) TO pi_collab_app;
GRANT EXECUTE ON FUNCTION collab_worker.claim_validation(uuid),collab_worker.heartbeat_validation(uuid,uuid,bigint),collab_worker.finish_validation(uuid,uuid,bigint,text,jsonb,text) TO pi_collab_executor;
