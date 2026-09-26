CREATE SCHEMA collab_worker;
REVOKE ALL ON SCHEMA collab_worker FROM PUBLIC;
GRANT USAGE ON SCHEMA collab_worker TO pi_collab_executor;

ALTER TABLE collab.projects ADD COLUMN event_sequence bigint NOT NULL DEFAULT 0;
ALTER TABLE collab.memberships ADD COLUMN authorization_version bigint NOT NULL DEFAULT 1;
CREATE FUNCTION collab_worker.bump_authorization() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN NEW.authorization_version := OLD.authorization_version+1; RETURN NEW; END
$$;
CREATE TRIGGER memberships_authorization_version BEFORE UPDATE OF role,active ON collab.memberships FOR EACH ROW EXECUTE FUNCTION collab_worker.bump_authorization();

-- A broker-owned repository ID is the only source accepted by web commands.
-- Local paths/credentials are never fields in the browser-facing schema.
CREATE TABLE collab.repositories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, project_id uuid NOT NULL,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120), provider text NOT NULL CHECK(provider IN ('local','github')),
  base_sha text NOT NULL CHECK(base_sha ~ '^[a-f0-9]{40}$'), default_branch text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,project_id,id),
  FOREIGN KEY(organization_id,project_id) REFERENCES collab.projects(organization_id,id)
);
CREATE TABLE collab.workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, project_id uuid NOT NULL, task_id uuid NOT NULL,
  repository_id uuid NOT NULL, created_by text NOT NULL REFERENCES public."user"(id), base_sha text NOT NULL CHECK(base_sha ~ '^[a-f0-9]{40}$'),
  runtime text NOT NULL CHECK(runtime IN ('native','docker')),
  status text NOT NULL DEFAULT 'provisioning' CHECK(status IN ('provisioning','busy','stopped','quarantined','archived')),
  epoch bigint NOT NULL DEFAULT 0, lease_owner uuid, lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,project_id,task_id,id),
  FOREIGN KEY(organization_id,project_id,task_id) REFERENCES collab.tasks(organization_id,project_id,id),
  FOREIGN KEY(organization_id,project_id,repository_id) REFERENCES collab.repositories(organization_id,project_id,id)
);
CREATE TABLE collab.runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, project_id uuid NOT NULL, task_id uuid NOT NULL,
  workspace_id uuid NOT NULL UNIQUE, requested_by text NOT NULL REFERENCES public."user"(id),
  prompt text NOT NULL CHECK(length(prompt) BETWEEN 1 AND 20000),
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','starting','running','waiting_input','stopping','completed','failed','cancelled','reconciling')),
  authorization_version bigint NOT NULL, epoch bigint NOT NULL DEFAULT 0, executor_id uuid,
  revision bigint NOT NULL DEFAULT 1, stop_reason text, summary jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz,
  UNIQUE(organization_id,project_id,id),
  FOREIGN KEY(organization_id,project_id,task_id,workspace_id) REFERENCES collab.workspaces(organization_id,project_id,task_id,id)
);
CREATE UNIQUE INDEX runs_one_active_task ON collab.runs(task_id) WHERE status IN ('queued','starting','running','waiting_input','stopping','reconciling');
CREATE INDEX runs_queue ON collab.runs(created_at,id) WHERE status='queued';
CREATE TABLE collab.commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES collab.organizations(id), project_id uuid NOT NULL,
  run_id uuid NOT NULL, requested_by text NOT NULL REFERENCES public."user"(id),
  scope_id uuid NOT NULL, idempotency_key uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('start','stop')), payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'accepted' CHECK(status IN ('accepted','dispatched','running','succeeded','failed','cancelled','unknown')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(requested_by,scope_id,idempotency_key),
  FOREIGN KEY(organization_id,project_id,run_id) REFERENCES collab.runs(organization_id,project_id,id),
  FOREIGN KEY(organization_id,project_id) REFERENCES collab.projects(organization_id,id)
);
CREATE UNIQUE INDEX commands_one_start ON collab.commands(run_id) WHERE kind='start';
CREATE TABLE collab.run_events (
  organization_id uuid NOT NULL, project_id uuid NOT NULL, sequence bigint NOT NULL,
  run_id uuid NOT NULL, kind text NOT NULL, payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(project_id,sequence),
  FOREIGN KEY(organization_id,project_id,run_id) REFERENCES collab.runs(organization_id,project_id,id),
  FOREIGN KEY(organization_id,project_id) REFERENCES collab.projects(organization_id,id)
);
CREATE UNIQUE INDEX output_batches ON collab.run_events(run_id,(payload->>'batchId')) WHERE kind='run.output';

ALTER TABLE collab.repositories ENABLE ROW LEVEL SECURITY;
ALTER TABLE collab.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE collab.runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE collab.commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE collab.run_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY repositories_read ON collab.repositories FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
CREATE POLICY workspaces_read ON collab.workspaces FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
CREATE POLICY runs_read ON collab.runs FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
CREATE POLICY commands_read ON collab.commands FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
CREATE POLICY events_read ON collab.run_events FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
GRANT SELECT ON collab.repositories,collab.workspaces,collab.runs,collab.commands,collab.run_events TO pi_collab_app;

CREATE FUNCTION collab_worker.emit(run uuid, event_kind text, data jsonb) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab.runs; seq bigint;
BEGIN
  SELECT * INTO STRICT r FROM collab.runs WHERE id=run;
  -- Per-project row serialization orders allocation AND commit. A global sequence
  -- alone could deliver n+1 before n commits, causing reconnect cursors to lose n.
  UPDATE collab.projects SET event_sequence=event_sequence+1 WHERE id=r.project_id RETURNING event_sequence INTO seq;
  INSERT INTO collab.run_events(organization_id,project_id,sequence,run_id,kind,payload) VALUES(r.organization_id,r.project_id,seq,r.id,event_kind,data);
  PERFORM pg_notify('pi_collab_runs',json_build_object('projectId',r.project_id,'sequence',seq)::text);
  RETURN seq;
END
$$;
CREATE FUNCTION collab_worker.authorized(run uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS(
    SELECT 1 FROM collab.runs r JOIN collab.tasks t ON t.id=r.task_id
    JOIN collab.memberships m ON m.organization_id=r.organization_id AND m.user_id=r.requested_by
    JOIN collab.project_memberships pm ON pm.project_id=r.project_id AND pm.user_id=r.requested_by
    JOIN public."user" u ON u.id=r.requested_by
    WHERE r.id=run AND m.active AND m.authorization_version=r.authorization_version
      AND pm.role IN ('maintainer','developer') AND (t.owner_id=r.requested_by OR pm.role='maintainer')
      AND (m.role='member' OR u."twoFactorEnabled")
  )
$$;
CREATE FUNCTION collab.submit_run(task uuid, repository uuid, base text, message text, runtime_mode text, request_key uuid, expected_version integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t collab.tasks; role text; previous collab.commands; request jsonb; workspace uuid := gen_random_uuid(); run uuid := gen_random_uuid(); command uuid := gen_random_uuid(); auth_version bigint;
BEGIN
  SELECT * INTO t FROM collab.tasks WHERE id=task;
  role := collab.project_role(t.project_id);
  IF NOT FOUND OR role IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
  IF role NOT IN ('developer','maintainer') OR (role<>'maintainer' AND t.owner_id<>collab.actor()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
  -- Serialize against organization revocation and all starts for this task.
  PERFORM pg_advisory_xact_lock(hashtextextended(t.organization_id::text,811));
  PERFORM pg_advisory_xact_lock(hashtextextended(task::text,820));
  SELECT * INTO t FROM collab.tasks WHERE id=task FOR UPDATE;
  role := collab.project_role(t.project_id);
  IF role IS NULL OR role NOT IN ('developer','maintainer') OR (role<>'maintainer' AND t.owner_id<>collab.actor()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
  IF collab.user_requires_mfa(collab.actor()) AND NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
  request := jsonb_build_object('repositoryId',repository,'baseSha',base,'prompt',message,'runtime',runtime_mode,'expectedVersion',expected_version);
  SELECT * INTO previous FROM collab.commands WHERE requested_by=collab.actor() AND scope_id=task AND idempotency_key=request_key;
  IF FOUND THEN
    IF previous.kind<>'start' OR previous.payload<>request THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
    RETURN jsonb_build_object('commandId',previous.id,'runId',previous.run_id,'status',previous.status,'replayed',true);
  END IF;
  IF t.version<>expected_version THEN RAISE EXCEPTION 'stale_revision' USING ERRCODE='P0001'; END IF;
  IF t.status IN ('done','cancelled') THEN RAISE EXCEPTION 'task_closed' USING ERRCODE='P0001'; END IF;
  IF EXISTS(SELECT 1 FROM collab.runs WHERE task_id=task AND status IN ('queued','starting','running','waiting_input','stopping','reconciling')) THEN RAISE EXCEPTION 'task_busy' USING ERRCODE='P0001'; END IF;
  IF NOT EXISTS(SELECT 1 FROM collab.repositories WHERE id=repository AND project_id=t.project_id AND base_sha=base) THEN RAISE EXCEPTION 'repository_revision_unavailable' USING ERRCODE='P0001'; END IF;
  IF message IS NULL OR length(message) NOT BETWEEN 1 AND 20000 OR runtime_mode NOT IN ('native','docker') THEN RAISE EXCEPTION 'invalid_run' USING ERRCODE='P0001'; END IF;
  SELECT authorization_version INTO auth_version FROM collab.memberships WHERE organization_id=t.organization_id AND user_id=collab.actor();
  INSERT INTO collab.workspaces(id,organization_id,project_id,task_id,repository_id,created_by,base_sha,runtime) VALUES(workspace,t.organization_id,t.project_id,t.id,repository,collab.actor(),base,runtime_mode);
  INSERT INTO collab.runs(id,organization_id,project_id,task_id,workspace_id,requested_by,prompt,authorization_version) VALUES(run,t.organization_id,t.project_id,t.id,workspace,collab.actor(),message,auth_version);
  INSERT INTO collab.commands(id,organization_id,project_id,run_id,requested_by,scope_id,idempotency_key,kind,payload) VALUES(command,t.organization_id,t.project_id,run,collab.actor(),task,request_key,'start',request);
  UPDATE collab.tasks SET status='ready',version=version+1,updated_at=now() WHERE id=task;
  INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id) VALUES(t.organization_id,t.project_id,collab.actor(),'run.accepted',run::text);
  PERFORM collab_worker.emit(run,'run.queued',jsonb_build_object('runId',run,'taskId',task,'workspaceId',workspace,'requestedBy',collab.actor()));
  RETURN jsonb_build_object('commandId',command,'runId',run,'status','accepted','replayed',false);
END
$$;

CREATE FUNCTION collab_worker.request_stop(run uuid, reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab.runs;
BEGIN
  SELECT * INTO STRICT r FROM collab.runs WHERE id=run FOR UPDATE;
  IF r.status='queued' THEN
    UPDATE collab.runs SET status='cancelled',stop_reason=reason,revision=revision+1,finished_at=now() WHERE id=run;
    UPDATE collab.workspaces SET status='archived',epoch=epoch+1 WHERE id=r.workspace_id;
    UPDATE collab.commands SET status=CASE WHEN kind='start' THEN 'cancelled' ELSE 'succeeded' END,updated_at=now() WHERE run_id=run;
    UPDATE collab.tasks SET status='draft',version=version+1,updated_at=now() WHERE id=r.task_id;
    PERFORM collab_worker.emit(run,'run.cancelled',jsonb_build_object('reason',reason));
  ELSIF r.status IN ('starting','running','waiting_input') THEN
    UPDATE collab.runs SET status='stopping',stop_reason=reason,revision=revision+1 WHERE id=run;
    PERFORM collab_worker.emit(run,'run.stopping',jsonb_build_object('reason',reason));
  END IF;
END
$$;
CREATE FUNCTION collab.stop_run(run uuid, request_key uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab.runs; role text; previous collab.commands; command uuid := gen_random_uuid(); command_status text;
BEGIN
  SELECT * INTO r FROM collab.runs WHERE id=run;
  role := collab.project_role(r.project_id);
  IF role IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
  IF role NOT IN ('developer','maintainer') OR (r.requested_by<>collab.actor() AND role<>'maintainer') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(r.organization_id::text,811));
  SELECT * INTO r FROM collab.runs WHERE id=run FOR UPDATE;
  role := collab.project_role(r.project_id);
  IF role IS NULL OR role NOT IN ('developer','maintainer') OR (r.requested_by<>collab.actor() AND role<>'maintainer') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
  SELECT * INTO previous FROM collab.commands WHERE requested_by=collab.actor() AND scope_id=run AND idempotency_key=request_key;
  IF FOUND THEN
    IF previous.kind<>'stop' THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
    RETURN jsonb_build_object('commandId',previous.id,'runId',run,'status',previous.status,'replayed',true);
  END IF;
  command_status := CASE WHEN r.status IN ('completed','failed','cancelled') THEN 'succeeded' WHEN r.status='reconciling' THEN 'unknown' ELSE 'accepted' END;
  INSERT INTO collab.commands(id,organization_id,project_id,run_id,requested_by,scope_id,idempotency_key,kind,payload,status) VALUES(command,r.organization_id,r.project_id,run,collab.actor(),run,request_key,'stop','{}',command_status);
  PERFORM collab_worker.request_stop(run,'user_requested');
  INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id) VALUES(r.organization_id,r.project_id,collab.actor(),'run.stop_requested',run::text);
  RETURN jsonb_build_object('commandId',command,'runId',run,'status',(SELECT status FROM collab.commands WHERE id=command),'replayed',false);
END
$$;

CREATE FUNCTION collab_worker.membership_revoked() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab.runs;
BEGIN
  FOR r IN SELECT * FROM collab.runs WHERE organization_id=NEW.organization_id AND requested_by=NEW.user_id AND status IN ('queued','starting','running','waiting_input') ORDER BY id LOOP
    PERFORM collab_worker.request_stop(r.id,'authorization_revoked');
  END LOOP;
  RETURN NEW;
END
$$;
CREATE TRIGGER memberships_stop_runs AFTER UPDATE OF role,active ON collab.memberships FOR EACH ROW EXECUTE FUNCTION collab_worker.membership_revoked();

CREATE FUNCTION collab_worker.claim(executor uuid, runtime_mode text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab.runs; w collab.workspaces;
BEGIN
  -- A short admission lock protects shared quota counters, never agent execution.
  PERFORM pg_advisory_xact_lock(82467104);
  FOR r IN SELECT * FROM collab.runs WHERE status='queued' AND NOT collab_worker.authorized(id) ORDER BY id FOR UPDATE SKIP LOCKED LOOP
    PERFORM collab_worker.request_stop(r.id,'authorization_revoked');
  END LOOP;
  SELECT candidate.* INTO r FROM collab.runs candidate JOIN collab.workspaces workspace ON workspace.id=candidate.workspace_id
  WHERE candidate.status='queued' AND workspace.runtime=runtime_mode AND collab_worker.authorized(candidate.id)
    AND NOT EXISTS(SELECT 1 FROM collab.task_dependencies d JOIN collab.tasks upstream ON upstream.id=d.depends_on WHERE d.task_id=candidate.task_id AND d.kind='strict' AND upstream.status<>'done')
    AND (SELECT count(*) FROM collab.runs a WHERE a.project_id=candidate.project_id AND a.status IN ('starting','running','waiting_input','stopping','reconciling'))<8
    AND (SELECT count(*) FROM collab.runs a WHERE a.requested_by=candidate.requested_by AND a.status IN ('starting','running','waiting_input','stopping','reconciling'))<2
  ORDER BY (SELECT count(*) FROM collab.runs a WHERE a.requested_by=candidate.requested_by AND a.status IN ('starting','running','waiting_input','stopping','reconciling')),candidate.created_at,candidate.id
  LIMIT 1 FOR UPDATE OF candidate SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE collab.workspaces SET epoch=epoch+1,lease_owner=executor,lease_expires_at=clock_timestamp()+interval '30 seconds',status='busy' WHERE id=r.workspace_id RETURNING * INTO w;
  UPDATE collab.runs SET status='starting',executor_id=executor,epoch=w.epoch,revision=revision+1,started_at=now() WHERE id=r.id RETURNING * INTO r;
  UPDATE collab.commands SET status='dispatched',updated_at=now() WHERE run_id=r.id AND kind='start';
  PERFORM collab_worker.emit(r.id,'run.starting',jsonb_build_object('epoch',w.epoch));
  RETURN jsonb_build_object('run',to_jsonb(r)||jsonb_build_object('epoch',r.epoch::text),'workspace',to_jsonb(w)||jsonb_build_object('epoch',w.epoch::text));
END
$$;

CREATE FUNCTION collab_worker.assert_lease(executor uuid, run uuid, generation bigint) RETURNS collab.runs LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab.runs; w collab.workspaces;
BEGIN
  SELECT * INTO r FROM collab.runs WHERE id=run FOR UPDATE;
  SELECT * INTO w FROM collab.workspaces WHERE id=r.workspace_id FOR UPDATE;
  IF r.id IS NULL OR r.executor_id IS DISTINCT FROM executor OR r.epoch<>generation OR w.epoch<>generation OR w.lease_owner IS DISTINCT FROM executor OR w.lease_expires_at IS NULL OR w.lease_expires_at<=clock_timestamp() OR r.status NOT IN ('starting','running','waiting_input','stopping')
    THEN RAISE EXCEPTION 'stale_lease' USING ERRCODE='P0001'; END IF;
  RETURN r;
END
$$;
CREATE FUNCTION collab_worker.heartbeat(executor uuid, run uuid, generation bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab.runs; can_execute boolean;
BEGIN
  r := collab_worker.assert_lease(executor,run,generation);
  can_execute := collab_worker.authorized(run) AND r.status<>'stopping';
  IF NOT can_execute AND r.status<>'stopping' THEN PERFORM collab_worker.request_stop(run,'authorization_revoked'); END IF;
  UPDATE collab.workspaces SET lease_expires_at=clock_timestamp()+interval '30 seconds' WHERE id=r.workspace_id;
  RETURN jsonb_build_object('canExecute',can_execute,'status',CASE WHEN can_execute THEN r.status ELSE 'stopping' END);
END
$$;
CREATE FUNCTION collab_worker.mark_running(executor uuid, run uuid, generation bigint) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab.runs;
BEGIN
  r := collab_worker.assert_lease(executor,run,generation);
  IF r.status<>'starting' OR NOT collab_worker.authorized(run) THEN RAISE EXCEPTION 'run_not_executable' USING ERRCODE='P0001'; END IF;
  UPDATE collab.runs SET status='running',revision=revision+1 WHERE id=run;
  UPDATE collab.commands SET status='running',updated_at=now() WHERE run_id=run AND kind='start';
  UPDATE collab.tasks SET status='in_progress',version=version+1,updated_at=now() WHERE id=r.task_id;
  PERFORM collab_worker.emit(run,'run.running',jsonb_build_object('epoch',generation));
END
$$;
CREATE FUNCTION collab_worker.append_output(executor uuid, run uuid, generation bigint, batch uuid, data jsonb) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab.runs; previous collab.run_events;
BEGIN
  r := collab_worker.assert_lease(executor,run,generation);
  IF r.status NOT IN ('running','waiting_input') OR NOT collab_worker.authorized(run) THEN RAISE EXCEPTION 'run_not_executable' USING ERRCODE='P0001'; END IF;
  IF pg_column_size(data)>1048576 THEN RAISE EXCEPTION 'output_too_large' USING ERRCODE='P0001'; END IF;
  SELECT * INTO previous FROM collab.run_events WHERE run_id=run AND kind='run.output' AND payload->>'batchId'=batch::text;
  IF FOUND THEN
    IF previous.payload->'events'<>data THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
    RETURN previous.sequence;
  END IF;
  RETURN collab_worker.emit(run,'run.output',jsonb_build_object('batchId',batch,'events',data));
END
$$;
CREATE FUNCTION collab_worker.finish(executor uuid, run uuid, generation bigint, outcome text, result jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab.runs;
BEGIN
  r := collab_worker.assert_lease(executor,run,generation);
  IF outcome NOT IN ('completed','failed','cancelled') OR outcome IS NULL THEN RAISE EXCEPTION 'invalid_run' USING ERRCODE='P0001'; END IF;
  IF outcome='completed' AND r.status NOT IN ('running','waiting_input') THEN RAISE EXCEPTION 'run_not_executable' USING ERRCODE='P0001'; END IF;
  IF (r.status='stopping' OR NOT collab_worker.authorized(run)) AND outcome<>'cancelled' THEN RAISE EXCEPTION 'run_not_executable' USING ERRCODE='P0001'; END IF;
  IF pg_column_size(result)>65536 THEN RAISE EXCEPTION 'output_too_large' USING ERRCODE='P0001'; END IF;
  UPDATE collab.runs SET status=outcome,summary=result,revision=revision+1,finished_at=now() WHERE id=run;
  UPDATE collab.workspaces SET status='stopped',epoch=epoch+1,lease_owner=NULL,lease_expires_at=NULL WHERE id=r.workspace_id;
  UPDATE collab.commands SET status=CASE WHEN kind='stop' OR outcome='completed' THEN 'succeeded' WHEN outcome='failed' THEN 'failed' ELSE 'cancelled' END,updated_at=now() WHERE run_id=run;
  UPDATE collab.tasks SET status=CASE WHEN outcome='completed' THEN 'in_review' WHEN outcome='failed' THEN 'blocked' ELSE 'draft' END,version=version+1,updated_at=now() WHERE id=r.task_id;
  PERFORM collab_worker.emit(run,'run.'||outcome,jsonb_build_object('summary',result));
END
$$;
CREATE FUNCTION collab_worker.reconcile_expired() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab.runs; changed integer := 0;
BEGIN
  FOR r IN SELECT candidate.* FROM collab.runs candidate JOIN collab.workspaces w ON w.id=candidate.workspace_id WHERE candidate.status IN ('starting','running','waiting_input','stopping') AND w.lease_expires_at<=clock_timestamp() ORDER BY candidate.id FOR UPDATE OF candidate SKIP LOCKED LOOP
    -- Recheck after the run lock: a concurrent heartbeat may have extended it.
    IF NOT EXISTS(SELECT 1 FROM collab.workspaces WHERE id=r.workspace_id AND lease_expires_at<=clock_timestamp()) THEN CONTINUE; END IF;
    UPDATE collab.runs SET status='reconciling',stop_reason='lease_expired',revision=revision+1 WHERE id=r.id;
    UPDATE collab.workspaces SET status='quarantined',epoch=epoch+1,lease_owner=NULL,lease_expires_at=NULL WHERE id=r.workspace_id;
    UPDATE collab.commands SET status='unknown',updated_at=now() WHERE run_id=r.id AND status IN ('accepted','dispatched','running');
    UPDATE collab.tasks SET status='blocked',version=version+1,updated_at=now() WHERE id=r.task_id;
    PERFORM collab_worker.emit(r.id,'run.reconciling',jsonb_build_object('reason','lease_expired','workspaceQuarantined',true));
    changed := changed+1;
  END LOOP;
  RETURN changed;
END
$$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA collab_worker FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION collab.submit_run(uuid,uuid,text,text,text,uuid,integer),collab.stop_run(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.submit_run(uuid,uuid,text,text,text,uuid,integer),collab.stop_run(uuid,uuid) TO pi_collab_app;
GRANT EXECUTE ON FUNCTION collab_worker.claim(uuid,text),collab_worker.heartbeat(uuid,uuid,bigint),collab_worker.mark_running(uuid,uuid,bigint),
  collab_worker.append_output(uuid,uuid,bigint,uuid,jsonb),collab_worker.finish(uuid,uuid,bigint,text,jsonb),collab_worker.reconcile_expired() TO pi_collab_executor;

CREATE FUNCTION collab_worker.quarantine(executor uuid, run uuid, generation bigint, reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab.runs;
BEGIN
  r := collab_worker.assert_lease(executor,run,generation);
  UPDATE collab.runs SET status='reconciling',stop_reason=left(reason,120),revision=revision+1 WHERE id=run;
  UPDATE collab.workspaces SET status='quarantined',epoch=epoch+1,lease_owner=NULL,lease_expires_at=NULL WHERE id=r.workspace_id;
  UPDATE collab.commands SET status='unknown',updated_at=now() WHERE run_id=run AND status IN ('accepted','dispatched','running');
  UPDATE collab.tasks SET status='blocked',version=version+1,updated_at=now() WHERE id=r.task_id;
  PERFORM collab_worker.emit(run,'run.reconciling',jsonb_build_object('reason',left(reason,120),'workspaceQuarantined',true));
END
$$;
REVOKE EXECUTE ON FUNCTION collab_worker.quarantine(uuid,uuid,bigint,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab_worker.quarantine(uuid,uuid,bigint,text) TO pi_collab_executor;

CREATE FUNCTION collab_worker.inspect(executor uuid, run uuid, generation bigint) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('status',status,'summary',summary) FROM collab.runs WHERE id=run AND executor_id=executor AND epoch=generation
$$;
REVOKE EXECUTE ON FUNCTION collab_worker.inspect(uuid,uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab_worker.inspect(uuid,uuid,bigint) TO pi_collab_executor;
