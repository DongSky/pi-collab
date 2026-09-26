-- Provider credentials and metering are not readable by the web or executor role.
CREATE SCHEMA collab_gateway;
REVOKE ALL ON SCHEMA collab_gateway FROM PUBLIC;
GRANT USAGE ON SCHEMA collab_gateway TO pi_collab_gateway;
CREATE TABLE collab.model_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, project_id uuid NOT NULL,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120), model_id text NOT NULL CHECK(length(model_id) BETWEEN 1 AND 200),
  api text NOT NULL CHECK(api='openai-responses'), reasoning boolean NOT NULL DEFAULT false,
  context_window integer NOT NULL CHECK(context_window BETWEEN 1024 AND 1000000),
  max_output_tokens integer NOT NULL CHECK(max_output_tokens BETWEEN 16 AND 32768),
  run_token_limit integer NOT NULL CHECK(run_token_limit BETWEEN 1024 AND 10000000),
  run_request_limit integer NOT NULL CHECK(run_request_limit BETWEEN 1 AND 100),
  enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,project_id,id), FOREIGN KEY(organization_id,project_id) REFERENCES collab.projects(organization_id,id)
);
ALTER TABLE collab.model_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY model_profiles_read ON collab.model_profiles FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
GRANT SELECT ON collab.model_profiles TO pi_collab_app;
CREATE TABLE collab_gateway.credentials (
  profile_id uuid PRIMARY KEY REFERENCES collab.model_profiles(id), sealed jsonb NOT NULL
);
CREATE TABLE collab_gateway.project_budgets (
  project_id uuid PRIMARY KEY REFERENCES collab.projects(id), daily_token_limit bigint NOT NULL CHECK(daily_token_limit BETWEEN 1024 AND 1000000000)
);
CREATE TABLE collab_gateway.daily_usage (
  project_id uuid NOT NULL REFERENCES collab.projects(id), day date NOT NULL, tokens bigint NOT NULL DEFAULT 0 CHECK(tokens>=0),
  PRIMARY KEY(project_id,day)
);
ALTER TABLE collab.runs ADD COLUMN model_profile_id uuid;
ALTER TABLE collab.runs ADD CONSTRAINT runs_model_scope FOREIGN KEY(organization_id,project_id,model_profile_id) REFERENCES collab.model_profiles(organization_id,project_id,id);
CREATE TABLE collab_gateway.capabilities (
  token_hash text PRIMARY KEY CHECK(token_hash ~ '^[a-f0-9]{64}$'), run_id uuid NOT NULL REFERENCES collab.runs(id),
  executor_id uuid NOT NULL, epoch bigint NOT NULL, expires_at timestamptz NOT NULL, revoked boolean NOT NULL DEFAULT false
);
CREATE TABLE collab_gateway.requests (
  id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES collab.runs(id), project_id uuid NOT NULL REFERENCES collab.projects(id),
  token_hash text NOT NULL REFERENCES collab_gateway.capabilities(token_hash), day date NOT NULL,
  reserved_tokens integer NOT NULL CHECK(reserved_tokens>0), charged_tokens integer NOT NULL CHECK(charged_tokens>=0),
  status text NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','completed','unknown')),
  input_tokens integer, output_tokens integer, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE UNIQUE INDEX gateway_one_inflight ON collab_gateway.requests(run_id) WHERE status='reserved';
CREATE INDEX gateway_run_usage ON collab_gateway.requests(run_id);

-- Keep the old transaction's authorization and idempotency rules, then bind one
-- immutable model selection before that same transaction commits.
CREATE FUNCTION collab.submit_run(task uuid, repository uuid, base text, message text, runtime_mode text, request_key uuid, expected_version integer, model_profile uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE accepted jsonb; run uuid; previous_profile uuid;
BEGIN
  accepted := collab.submit_run(task,repository,base,message,runtime_mode,request_key,expected_version);
  run := (accepted->>'runId')::uuid;
  IF (accepted->>'replayed')::boolean THEN
    SELECT model_profile_id INTO previous_profile FROM collab.runs WHERE id=run;
    IF previous_profile IS DISTINCT FROM model_profile THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
  ELSE
    IF model_profile IS NOT NULL AND NOT EXISTS(SELECT 1 FROM collab.model_profiles p JOIN collab.runs r ON r.project_id=p.project_id WHERE r.id=run AND p.id=model_profile AND p.enabled)
      THEN RAISE EXCEPTION 'model_unavailable' USING ERRCODE='P0001'; END IF;
    UPDATE collab.runs SET model_profile_id=model_profile WHERE id=run;
  END IF;
  RETURN accepted;
END
$$;
REVOKE EXECUTE ON FUNCTION collab.submit_run(uuid,uuid,text,text,text,uuid,integer) FROM pi_collab_app;
REVOKE EXECUTE ON FUNCTION collab.submit_run(uuid,uuid,text,text,text,uuid,integer,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.submit_run(uuid,uuid,text,text,text,uuid,integer,uuid) TO pi_collab_app;

CREATE FUNCTION collab_worker.issue_model_capability(executor uuid, run uuid, generation bigint, digest text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab.runs; profile collab.model_profiles;
BEGIN
  r := collab_worker.assert_lease(executor,run,generation);
  IF NOT collab_worker.authorized(run) OR r.status NOT IN ('starting','running') THEN RAISE EXCEPTION 'run_not_executable' USING ERRCODE='P0001'; END IF;
  SELECT * INTO profile FROM collab.model_profiles WHERE id=r.model_profile_id AND enabled;
  IF NOT FOUND THEN RAISE EXCEPTION 'model_unavailable' USING ERRCODE='P0001'; END IF;
  INSERT INTO collab_gateway.capabilities(token_hash,run_id,executor_id,epoch,expires_at) VALUES(digest,run,executor,generation,clock_timestamp()+interval '30 minutes');
  RETURN to_jsonb(profile);
END
$$;
REVOKE EXECUTE ON FUNCTION collab_worker.issue_model_capability(uuid,uuid,bigint,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab_worker.issue_model_capability(uuid,uuid,bigint,text) TO pi_collab_executor;

-- A read checks current authority; it deliberately NEVER renews a runner lease.
CREATE FUNCTION collab_gateway.valid(digest text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS(SELECT 1 FROM collab_gateway.capabilities c JOIN collab.runs r ON r.id=c.run_id
    JOIN collab.workspaces w ON w.id=r.workspace_id JOIN collab.model_profiles p ON p.id=r.model_profile_id
    WHERE c.token_hash=digest AND NOT c.revoked AND c.expires_at>clock_timestamp()
      AND c.epoch=r.epoch AND c.epoch=w.epoch AND c.executor_id=r.executor_id AND c.executor_id=w.lease_owner
      AND w.lease_expires_at>clock_timestamp() AND r.status IN ('running','waiting_input') AND p.enabled AND collab_worker.authorized(r.id))
$$;
CREATE FUNCTION collab_gateway.profile(digest text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NOT collab_gateway.valid(digest) THEN RAISE EXCEPTION 'model_access_denied' USING ERRCODE='P0001'; END IF;
  RETURN (SELECT to_jsonb(p) FROM collab_gateway.capabilities c JOIN collab.runs r ON r.id=c.run_id JOIN collab.model_profiles p ON p.id=r.model_profile_id WHERE c.token_hash=digest);
END
$$;
CREATE FUNCTION collab_gateway.admit(digest text, request_id uuid, input_bound integer, output_bound integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab.runs; p collab.model_profiles; budget bigint; used bigint; count_requests bigint; today date := (clock_timestamp() AT TIME ZONE 'UTC')::date; reservation integer;
BEGIN
  SELECT run.* INTO r FROM collab.runs run JOIN collab_gateway.capabilities c ON c.run_id=run.id WHERE c.token_hash=digest;
  IF r.id IS NULL THEN RAISE EXCEPTION 'model_access_denied' USING ERRCODE='P0001'; END IF;
  -- Lock order matches submit/stop/revoke. Budget admissions from all gateway
  -- processes serialize per project, not in an in-memory counter.
  PERFORM pg_advisory_xact_lock(hashtextextended(r.organization_id::text,811));
  PERFORM 1 FROM collab.runs WHERE id=r.id FOR UPDATE;
  SELECT daily_token_limit INTO budget FROM collab_gateway.project_budgets WHERE project_id=r.project_id FOR UPDATE;
  IF budget IS NULL OR NOT collab_gateway.valid(digest) THEN RAISE EXCEPTION 'model_access_denied' USING ERRCODE='P0001'; END IF;
  SELECT * INTO STRICT p FROM collab.model_profiles WHERE id=r.model_profile_id;
  IF input_bound IS NULL OR input_bound<1 OR input_bound>p.context_window OR output_bound IS NULL OR output_bound<16 OR output_bound>p.max_output_tokens
    THEN RAISE EXCEPTION 'model_request_limit' USING ERRCODE='P0001'; END IF;
  reservation := input_bound+output_bound;
  SELECT coalesce(sum(charged_tokens),0),count(*) INTO used,count_requests FROM collab_gateway.requests WHERE run_id=r.id;
  IF used+reservation>p.run_token_limit OR count_requests>=p.run_request_limit THEN RAISE EXCEPTION 'model_budget_exhausted' USING ERRCODE='P0001'; END IF;
  IF EXISTS(SELECT 1 FROM collab_gateway.requests WHERE run_id=r.id AND status='reserved') THEN RAISE EXCEPTION 'model_request_inflight' USING ERRCODE='P0001'; END IF;
  INSERT INTO collab_gateway.daily_usage(project_id,day) VALUES(r.project_id,today) ON CONFLICT DO NOTHING;
  UPDATE collab_gateway.daily_usage SET tokens=tokens+reservation WHERE project_id=r.project_id AND day=today AND tokens+reservation<=budget;
  IF NOT FOUND THEN RAISE EXCEPTION 'model_budget_exhausted' USING ERRCODE='P0001'; END IF;
  INSERT INTO collab_gateway.requests(id,run_id,project_id,token_hash,day,reserved_tokens,charged_tokens) VALUES(request_id,r.id,r.project_id,digest,today,reservation,reservation);
  RETURN (SELECT jsonb_build_object('profile',to_jsonb(p),'sealed',sealed) FROM collab_gateway.credentials WHERE profile_id=p.id);
END
$$;
CREATE FUNCTION collab_gateway.settle(request_id uuid, outcome text, input_count integer, output_count integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE request collab_gateway.requests; charge integer;
BEGIN
  SELECT * INTO request FROM collab_gateway.requests WHERE id=request_id FOR UPDATE;
  IF request.id IS NULL OR request.status<>'reserved' THEN RETURN; END IF;
  IF outcome NOT IN ('completed','unknown') OR outcome IS NULL THEN RAISE EXCEPTION 'invalid_model_outcome'; END IF;
  charge := request.reserved_tokens;
  IF outcome='completed' AND input_count>=0 AND output_count>=0 AND input_count::bigint+output_count<=request.reserved_tokens THEN charge := input_count+output_count;
  ELSE outcome := 'unknown'; END IF;
  -- Unknown responses keep the full reservation. Neither a disconnect nor a
  -- process restart restores spent capacity, and no upstream request is replayed.
  UPDATE collab_gateway.requests SET status=outcome,charged_tokens=charge,input_tokens=input_count,output_tokens=output_count,finished_at=clock_timestamp() WHERE id=request_id;
  UPDATE collab_gateway.daily_usage SET tokens=tokens-request.reserved_tokens+charge WHERE project_id=request.project_id AND day=request.day;
END
$$;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA collab_gateway FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA collab_gateway TO pi_collab_gateway;
