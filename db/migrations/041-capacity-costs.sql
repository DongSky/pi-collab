-- Project controls and immutable request-time prices. Money is estimated USD,
-- not a provider invoice. Unpriced/uncertain usage is never reported as free.
CREATE TABLE collab_gateway.capacity_settings (
 project_id uuid PRIMARY KEY REFERENCES collab.projects(id), version integer NOT NULL DEFAULT 1,
 project_runs integer NOT NULL DEFAULT 8 CHECK(project_runs BETWEEN 1 AND 32),
 member_runs integer NOT NULL DEFAULT 2 CHECK(member_runs BETWEEN 1 AND 16),
 daily_usd numeric(20,8) CHECK(daily_usd>0 AND daily_usd<=1000000)
);
CREATE TABLE collab_gateway.model_prices (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES collab.model_profiles(id),
 input_usd_per_million numeric(20,8) NOT NULL CHECK(input_usd_per_million BETWEEN 0 AND 100000),
 output_usd_per_million numeric(20,8) NOT NULL CHECK(output_usd_per_million BETWEEN 0 AND 100000),
 source text NOT NULL CHECK(length(source) BETWEEN 3 AND 500), actor_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE collab_gateway.cost_entries (
 request_id uuid PRIMARY KEY REFERENCES collab_gateway.requests(id), price_id uuid REFERENCES collab_gateway.model_prices(id),
 input_bound integer NOT NULL, output_bound integer NOT NULL,
 reserved_usd numeric(20,8), charged_usd numeric(20,8),
 CHECK((price_id IS NULL AND reserved_usd IS NULL AND charged_usd IS NULL) OR (price_id IS NOT NULL AND reserved_usd>=0 AND charged_usd>=0))
);
CREATE TABLE collab_gateway.capacity_operations (
 project_id uuid NOT NULL REFERENCES collab.projects(id), actor_id text NOT NULL, request_key uuid NOT NULL, input jsonb NOT NULL, result jsonb NOT NULL,
 PRIMARY KEY(project_id,actor_id,request_key)
);
CREATE FUNCTION collab.configure_capacity(project uuid, payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE org uuid; old collab_gateway.capacity_operations; v integer; response jsonb; price jsonb;
BEGIN
 SELECT organization_id INTO org FROM collab.projects WHERE id=project;
 IF org IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(org::text,811));
 IF collab.project_role(project) IS DISTINCT FROM 'maintainer' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
 SELECT * INTO old FROM collab_gateway.capacity_operations WHERE project_id=project AND actor_id=collab.actor() AND request_key=(payload->>'idempotencyKey')::uuid;
 IF FOUND THEN
  IF old.input IS DISTINCT FROM payload THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
  RETURN old.result;
 END IF;
 SELECT version INTO v FROM collab_gateway.capacity_settings WHERE project_id=project FOR UPDATE;
 IF coalesce(v,0) IS DISTINCT FROM (payload->>'expectedVersion')::integer THEN RAISE EXCEPTION 'stale_revision' USING ERRCODE='P0001'; END IF;
 IF length(btrim(payload->>'reason')) NOT BETWEEN 10 AND 2000 OR (payload->>'dailyTokens')::bigint NOT BETWEEN 1024 AND 1000000000
   OR jsonb_typeof(payload->'prices') IS DISTINCT FROM 'array' OR jsonb_array_length(payload->'prices')>100 THEN RAISE EXCEPTION 'invalid_capacity' USING ERRCODE='P0001'; END IF;
 INSERT INTO collab_gateway.capacity_settings(project_id,project_runs,member_runs,daily_usd) VALUES(project,(payload->>'projectRuns')::integer,(payload->>'memberRuns')::integer,(payload->>'dailyUsd')::numeric)
 ON CONFLICT(project_id) DO UPDATE SET version=capacity_settings.version+1,project_runs=excluded.project_runs,member_runs=excluded.member_runs,daily_usd=excluded.daily_usd RETURNING version INTO v;
 INSERT INTO collab_gateway.project_budgets(project_id,daily_token_limit) VALUES(project,(payload->>'dailyTokens')::bigint)
 ON CONFLICT(project_id) DO UPDATE SET daily_token_limit=excluded.daily_token_limit;
 FOR price IN SELECT value FROM jsonb_array_elements(payload->'prices') LOOP
  IF NOT EXISTS(SELECT 1 FROM collab.model_profiles WHERE id=(price->>'profileId')::uuid AND project_id=project) THEN RAISE EXCEPTION 'model_unavailable' USING ERRCODE='P0001'; END IF;
  INSERT INTO collab_gateway.model_prices(profile_id,input_usd_per_million,output_usd_per_million,source,actor_id)
   VALUES((price->>'profileId')::uuid,(price->>'inputUsdPerMillion')::numeric,(price->>'outputUsdPerMillion')::numeric,price->>'source',collab.actor());
 END LOOP;
 response := jsonb_build_object('version',v);
 INSERT INTO collab_gateway.capacity_operations VALUES(project,collab.actor(),(payload->>'idempotencyKey')::uuid,payload,response);
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(org,project,collab.actor(),'capacity.configured',project,payload-'idempotencyKey');
 RETURN response;
END $$;

CREATE FUNCTION collab_worker.capacity_available(project uuid, person text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT (SELECT count(*) FROM collab.runs WHERE project_id=project AND status IN ('starting','running','waiting_input','stopping','reconciling')) < coalesce((SELECT project_runs FROM collab_gateway.capacity_settings WHERE project_id=project),8)
 AND (SELECT count(*) FROM collab.runs WHERE project_id=project AND requested_by=person AND status IN ('starting','running','waiting_input','stopping','reconciling')) < coalesce((SELECT member_runs FROM collab_gateway.capacity_settings WHERE project_id=project),2)
$$;

-- Keep the token admission protocol, adding a monetary reservation atomically.
ALTER FUNCTION collab_gateway.admit(text,uuid,integer,integer) RENAME TO admit_tokens;
REVOKE EXECUTE ON FUNCTION collab_gateway.admit_tokens(text,uuid,integer,integer) FROM pi_collab_gateway;
CREATE FUNCTION collab_gateway.admit(digest text, request_id uuid, input_bound integer, output_bound integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result jsonb; r collab_gateway.requests; price collab_gateway.model_prices; cap numeric; amount numeric;
BEGIN
 result := collab_gateway.admit_tokens(digest,request_id,input_bound,output_bound);
 SELECT * INTO STRICT r FROM collab_gateway.requests WHERE id=request_id;
 SELECT * INTO price FROM collab_gateway.model_prices WHERE profile_id=(result->'profile'->>'id')::uuid ORDER BY created_at DESC,id DESC LIMIT 1;
 SELECT daily_usd INTO cap FROM collab_gateway.capacity_settings WHERE project_id=r.project_id;
 IF price.id IS NOT NULL THEN amount := ceil((input_bound::numeric*price.input_usd_per_million+output_bound::numeric*price.output_usd_per_million)*100)/100000000; END IF;
 IF cap IS NOT NULL THEN
  IF price.id IS NULL OR EXISTS(SELECT 1 FROM collab_gateway.requests q LEFT JOIN collab_gateway.cost_entries c ON c.request_id=q.id WHERE q.project_id=r.project_id AND q.day=r.day AND q.id<>admit.request_id AND c.price_id IS NULL)
    THEN RAISE EXCEPTION 'model_price_unknown' USING ERRCODE='P0001'; END IF;
  IF amount+coalesce((SELECT sum(c.charged_usd) FROM collab_gateway.requests q JOIN collab_gateway.cost_entries c ON c.request_id=q.id WHERE q.project_id=r.project_id AND q.day=r.day),0)>cap
    THEN RAISE EXCEPTION 'model_money_exhausted' USING ERRCODE='P0001'; END IF;
 END IF;
 INSERT INTO collab_gateway.cost_entries VALUES(request_id,price.id,input_bound,output_bound,amount,amount);
 RETURN result;
END $$;
ALTER FUNCTION collab_gateway.settle(uuid,text,integer,integer) RENAME TO settle_tokens;
REVOKE EXECUTE ON FUNCTION collab_gateway.settle_tokens(uuid,text,integer,integer) FROM pi_collab_gateway;
CREATE FUNCTION collab_gateway.settle(request_id uuid, outcome text, input_count integer, output_count integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab_gateway.requests; c collab_gateway.cost_entries; p collab_gateway.model_prices; amount numeric;
BEGIN
 SELECT * INTO r FROM collab_gateway.requests WHERE id=request_id FOR UPDATE;
 IF r.id IS NULL OR r.status<>'reserved' THEN RETURN; END IF;
 SELECT * INTO c FROM collab_gateway.cost_entries WHERE cost_entries.request_id=settle.request_id;
 IF c.request_id IS NOT NULL AND (input_count IS NULL OR output_count IS NULL OR input_count<0 OR output_count<0 OR input_count>c.input_bound OR output_count>c.output_bound) THEN outcome:='unknown'; END IF;
 PERFORM collab_gateway.settle_tokens(request_id,outcome,input_count,output_count);
 IF c.price_id IS NOT NULL AND (SELECT status FROM collab_gateway.requests WHERE id=request_id)='completed' THEN
  SELECT * INTO STRICT p FROM collab_gateway.model_prices WHERE id=c.price_id;
  amount:=ceil((input_count::numeric*p.input_usd_per_million+output_count::numeric*p.output_usd_per_million)*100)/100000000;
  UPDATE collab_gateway.cost_entries SET charged_usd=amount WHERE cost_entries.request_id=settle.request_id;
 END IF;
END $$;
CREATE FUNCTION collab.capacity_context(project uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result jsonb; today date:=(clock_timestamp() AT TIME ZONE 'UTC')::date;
BEGIN
 IF collab.project_role(project) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 SELECT jsonb_build_object('version',coalesce(s.version,0),'projectRuns',coalesce(s.project_runs,8),'memberRuns',coalesce(s.member_runs,2),'dailyUsd',s.daily_usd::text,'dailyTokens',coalesce(b.daily_token_limit,10000000)::text,'canManage',collab.project_role(project)='maintainer','day',today,'currency','USD') INTO result FROM (SELECT project AS id) p LEFT JOIN collab_gateway.capacity_settings s ON s.project_id=p.id LEFT JOIN collab_gateway.project_budgets b ON b.project_id=p.id;
 RETURN result||jsonb_build_object(
 'models',(SELECT coalesce(jsonb_agg(to_jsonb(m)||jsonb_build_object('price',price.data)),'[]'::jsonb) FROM (SELECT id,name,model_id FROM collab.model_profiles WHERE project_id=project) m LEFT JOIN LATERAL (SELECT jsonb_build_object('id',id,'inputUsdPerMillion',input_usd_per_million::text,'outputUsdPerMillion',output_usd_per_million::text,'source',source,'createdAt',created_at) data FROM collab_gateway.model_prices WHERE profile_id=m.id ORDER BY created_at DESC,id DESC LIMIT 1) price ON true),
 'usage',(SELECT jsonb_build_object('settledUsd',coalesce(sum(c.charged_usd) FILTER(WHERE q.status='completed'),0)::text,'reservedUsd',coalesce(sum(c.charged_usd) FILTER(WHERE q.status='reserved'),0)::text,'uncertainUsd',coalesce(sum(c.charged_usd) FILTER(WHERE q.status='unknown'),0)::text,'unpricedRequests',count(*) FILTER(WHERE c.price_id IS NULL),'tokens',coalesce(sum(q.charged_tokens),0)::text,'requests',count(*)) FROM collab_gateway.requests q LEFT JOIN collab_gateway.cost_entries c ON c.request_id=q.id WHERE q.project_id=project AND q.day=today),
 'members',(SELECT coalesce(jsonb_agg(x),'[]'::jsonb) FROM (SELECT u.name,pm.user_id,count(r.id) FILTER(WHERE r.status IN ('starting','running','waiting_input','stopping','reconciling'))::integer AS active,count(r.id) FILTER(WHERE r.status='queued')::integer AS queued FROM collab.project_memberships pm JOIN collab.memberships om ON om.organization_id=pm.organization_id AND om.user_id=pm.user_id JOIN public."user" u ON u.id=pm.user_id LEFT JOIN collab.runs r ON r.project_id=pm.project_id AND r.requested_by=pm.user_id WHERE pm.project_id=project AND pm.active AND om.active GROUP BY u.name,pm.user_id) x),
 'recent',(SELECT coalesce(jsonb_agg(x),'[]'::jsonb) FROM (SELECT q.id,q.run_id,t.title,q.status,q.created_at,q.charged_tokens,c.reserved_usd::text,c.charged_usd::text,c.price_id FROM collab_gateway.requests q JOIN collab.runs r ON r.id=q.run_id JOIN collab.tasks t ON t.id=r.task_id LEFT JOIN collab_gateway.cost_entries c ON c.request_id=q.id WHERE q.project_id=project ORDER BY q.created_at DESC LIMIT 50) x));
END $$;
REVOKE EXECUTE ON FUNCTION collab.configure_capacity(uuid,jsonb),collab.capacity_context(uuid),collab_worker.capacity_available(uuid,text),collab_gateway.admit(text,uuid,integer,integer),collab_gateway.settle(uuid,text,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.configure_capacity(uuid,jsonb),collab.capacity_context(uuid) TO pi_collab_app;
GRANT EXECUTE ON FUNCTION collab_gateway.admit(text,uuid,integer,integer),collab_gateway.settle(uuid,text,integer,integer) TO pi_collab_gateway;

CREATE OR REPLACE FUNCTION collab_worker.claim_with_resolutions(executor uuid, runtime_mode text, results_supported boolean, snapshots_supported boolean, contracts_supported boolean, resolutions_supported boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab.runs; w collab.workspaces; locked_orgs uuid[] := '{}';
BEGIN
  PERFORM pg_advisory_xact_lock(82467104);
  -- Organization lock precedes run locks; never invert membership/stop ordering.
  FOR r IN SELECT * FROM collab.runs WHERE status='queued' ORDER BY created_at,id LOOP
    IF NOT pg_try_advisory_xact_lock(hashtextextended(r.organization_id::text,811)) THEN CONTINUE; END IF;
    IF NOT r.organization_id=ANY(locked_orgs) THEN locked_orgs := array_append(locked_orgs,r.organization_id); END IF;
    SELECT * INTO STRICT r FROM collab.runs WHERE id=r.id FOR UPDATE;
    IF r.status<>'queued' THEN CONTINUE; END IF;
    IF NOT collab_worker.authorized(r.id) THEN PERFORM collab_worker.request_stop(r.id,'authorization_revoked'); END IF;
  END LOOP;
  SELECT candidate.* INTO r FROM collab.runs candidate JOIN collab.workspaces workspace ON workspace.id=candidate.workspace_id
  WHERE candidate.status='queued' AND workspace.runtime=runtime_mode AND (snapshots_supported OR workspace.source_snapshot_id IS NULL)
    AND (results_supported OR NOT candidate.dependency_protocol) AND collab_worker.authorized(candidate.id)
    AND (resolutions_supported OR NOT collab_worker.requires_resolution_protocol(candidate.id))
    AND (contracts_supported OR NOT EXISTS(SELECT 1 FROM collab.run_contracts WHERE run_id=candidate.id))
    AND (candidate.dependency_protocol OR NOT EXISTS(SELECT 1 FROM collab.task_dependencies WHERE task_id=candidate.task_id))
    AND NOT EXISTS(SELECT 1 FROM collab.run_dependencies d JOIN collab.tasks upstream ON upstream.id=d.depends_on
      WHERE d.run_id=candidate.id AND d.kind='strict' AND (EXISTS(SELECT 1 FROM collab.result_withdrawals WHERE result_id=d.result_id)
        OR (d.result_id IS NULL AND (upstream.current_result_id IS NULL OR EXISTS(SELECT 1 FROM collab.result_withdrawals WHERE result_id=upstream.current_result_id)
          OR NOT EXISTS(SELECT 1 FROM collab.task_results available WHERE available.id=upstream.current_result_id AND collab_worker.dependencies_current(available.source_run_id))))))
    AND collab_worker.capacity_available(candidate.project_id,candidate.requested_by)
    AND candidate.organization_id=ANY(locked_orgs)
  ORDER BY (SELECT count(*) FROM collab.runs a WHERE a.requested_by=candidate.requested_by AND a.status IN ('starting','running','waiting_input','stopping','reconciling')),candidate.created_at,candidate.id
  LIMIT 1 FOR UPDATE OF candidate SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE collab.run_dependencies d SET result_id=upstream.current_result_id FROM collab.tasks upstream WHERE d.run_id=r.id AND d.depends_on=upstream.id AND d.kind='strict' AND d.result_id IS NULL;
  UPDATE collab.workspaces SET epoch=epoch+1,lease_owner=executor,lease_expires_at=clock_timestamp()+interval '30 seconds',status='busy' WHERE id=r.workspace_id RETURNING * INTO w;
  UPDATE collab.runs SET status='starting',executor_id=executor,epoch=w.epoch,revision=revision+1,started_at=now() WHERE id=r.id RETURNING * INTO r;
  UPDATE collab.commands SET status='dispatched',updated_at=now() WHERE run_id=r.id AND kind='start';
  PERFORM collab_worker.emit(r.id,'run.starting',jsonb_build_object('epoch',w.epoch,'dependencies',collab_worker.dependency_pins(r.id)));
  RETURN jsonb_build_object('run',to_jsonb(r)||jsonb_build_object('epoch',r.epoch::text),'workspace',to_jsonb(w)||jsonb_build_object('epoch',w.epoch::text),'dependencies',collab_worker.dependency_pins(r.id),'contracts',collab_worker.contract_pins(r.id),'resolution',collab_worker.resolution_input(r.id));
END
$$;
