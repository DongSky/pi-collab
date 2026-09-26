-- Durable native Git promotion. An expired lease NEVER releases the target.
CREATE SCHEMA collab_crypto;
REVOKE ALL ON SCHEMA collab_crypto FROM PUBLIC;
CREATE EXTENSION pgcrypto WITH SCHEMA collab_crypto;

CREATE TABLE collab.promotions (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, project_id uuid NOT NULL, repository_id uuid NOT NULL, integration_id uuid NOT NULL,
 target_branch text NOT NULL, input jsonb NOT NULL, promotion_sha text NOT NULL CHECK(promotion_sha~'^[a-f0-9]{40}$'),
 requested_by text NOT NULL REFERENCES public."user"(id), organization_version bigint NOT NULL, project_version bigint NOT NULL,
 idempotency_key uuid NOT NULL, request jsonb NOT NULL, requested_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','preparing','applying','unknown','reconcile_queued','reconciling','blocked','applied','aborted')),
 executor_id uuid, epoch bigint NOT NULL DEFAULT 0, lease_expires_at timestamptz, stop_requested boolean NOT NULL DEFAULT false,
 effect_grant jsonb, effect_admitted_at timestamptz, observation jsonb, error_code text, finished_at timestamptz,
 UNIQUE(organization_id,project_id,id), UNIQUE(repository_id,requested_by,idempotency_key),
 FOREIGN KEY(organization_id,project_id,repository_id) REFERENCES collab.repositories(organization_id,project_id,id),
 FOREIGN KEY(organization_id,project_id,integration_id) REFERENCES collab.integrations(organization_id,project_id,id)
);
CREATE UNIQUE INDEX promotion_target_occupied ON collab.promotions(repository_id,target_branch) WHERE status NOT IN ('applied','aborted');
CREATE TABLE collab.promotion_actions (
 promotion_id uuid NOT NULL REFERENCES collab.promotions(id), actor_id text NOT NULL REFERENCES public."user"(id), idempotency_key uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('cancel','reconcile')), reason text NOT NULL CHECK(length(reason) BETWEEN 10 AND 2000), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(promotion_id,actor_id,idempotency_key)
);
CREATE TABLE collab.repository_baselines (
 organization_id uuid NOT NULL, project_id uuid NOT NULL, repository_id uuid NOT NULL, promotion_id uuid NOT NULL UNIQUE,
 sequence bigint NOT NULL, target_branch text NOT NULL, old_sha text NOT NULL, new_sha text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(project_id,sequence),
 FOREIGN KEY(organization_id,project_id,repository_id) REFERENCES collab.repositories(organization_id,project_id,id),
 FOREIGN KEY(organization_id,project_id,promotion_id) REFERENCES collab.promotions(organization_id,project_id,id)
);
ALTER TABLE collab.promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE collab.repository_baselines ENABLE ROW LEVEL SECURITY;
CREATE POLICY project_read ON collab.promotions FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
CREATE POLICY project_read ON collab.repository_baselines FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
GRANT SELECT ON collab.promotions,collab.repository_baselines TO pi_collab_app;

-- Exact JSON.stringify order; SQL derives Git IDs rather than trusting an HTTP
-- or worker-proposed target SHA. Native PostgreSQL needs the pgcrypto module.
CREATE FUNCTION collab_worker.promotion_json(input jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT '{"version":1,'||string_agg(to_json(k)::text||':'||to_json(input->>k)::text,',' ORDER BY ordinal)||'}'
 FROM unnest(ARRAY['promotionId','integrationId','repositoryId','requestedAt','targetBranch','targetSha','candidateSha','candidateTree','inputHash','revisionHash','policyId','profileId','manifestHash','worktreeCommit']) WITH ORDINALITY f(k,ordinal)
$$;
CREATE FUNCTION collab_worker.promotion_oid(input jsonb, decision text DEFAULT NULL) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE bytes bytea; body text; person text; parent text;
BEGIN
 person:='pi-collab integration <integration@pi-collab.local> '||floor(extract(epoch FROM (input->>'requestedAt')::timestamptz))::bigint::text||' +0000';
 IF decision IS NULL THEN
  body:='tree '||(input->>'candidateTree')||E'\nparent '||(input->>'candidateSha')||E'\nauthor '||person||E'\ncommitter '||person||E'\n\npi-collab local promotion\n\n'||collab_worker.promotion_json(input)||E'\n';
 ELSE
  IF decision NOT IN ('prepared','applied','aborted') THEN RAISE EXCEPTION 'invalid_promotion' USING ERRCODE='P0001'; END IF;
  parent:=CASE WHEN decision='aborted' THEN '' ELSE 'parent '||collab_worker.promotion_oid(input)||E'\n' END;
  body:=E'tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n'||parent||'author '||person||E'\ncommitter '||person||E'\n\n{"version":1,"kind":"pi-collab-local-promotion","decision":'||to_json(decision)::text||',"input":'||collab_worker.promotion_json(input)||E'}\n';
 END IF;
 bytes:=convert_to(body,'UTF8');
 RETURN encode(collab_crypto.digest(convert_to('commit '||octet_length(bytes)::text,'UTF8')||decode('00','hex')||bytes,'sha1'),'hex');
END $$;

-- Actor-independent equivalent of the public review state. It returns exact
-- approval IDs, so changes between intent admission and the final gate fail.
CREATE FUNCTION collab_worker.promotion_reviews(candidate uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i collab.integrations; p collab.integration_policies; approvals jsonb; blockers integer;
BEGIN
 SELECT * INTO i FROM collab.integrations WHERE id=candidate;
 IF i.id IS NULL OR i.status<>'checked' OR i.policy_id IS NULL OR NOT collab_worker.integration_current(candidate) OR NOT collab_worker.integration_authorized(candidate) THEN RETURN NULL; END IF;
 SELECT * INTO STRICT p FROM collab.integration_policies WHERE id=i.policy_id;
 WITH latest AS (SELECT DISTINCT ON (reviewer_id) r.* FROM collab.integration_reviews r WHERE integration_id=candidate ORDER BY reviewer_id,version DESC),
 eligible AS (SELECT r.*,COALESCE(r.decision='approve' AND collab_worker.integration_review_authorized(r.id) AND NOT collab_worker.integration_contributor(candidate,r.reviewer_id)
 AND r.revision_hash=collab_worker.integration_revision_hash(candidate) AND (p.reviewer_approvals OR pm.role IN ('maintainer','developer')),false) AS counts
 FROM latest r LEFT JOIN collab.project_memberships pm ON pm.project_id=r.project_id AND pm.user_id=r.reviewer_id)
 SELECT COALESCE(jsonb_agg(id ORDER BY id) FILTER(WHERE counts),'[]'::jsonb),count(*) FILTER(WHERE decision='request_changes') INTO approvals,blockers FROM eligible;
 IF jsonb_array_length(approvals)<p.required_approvals OR blockers<>0 THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('policyId',p.id,'revisionHash',collab_worker.integration_revision_hash(candidate),'approvalIds',approvals);
END $$;
CREATE FUNCTION collab_worker.promotion_grant(operation uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab.promotions; reviews jsonb;
BEGIN
 SELECT * INTO p FROM collab.promotions WHERE id=operation;
 IF p.id IS NULL OR p.stop_requested OR NOT EXISTS(SELECT 1 FROM collab.memberships m JOIN collab.project_memberships pm ON pm.organization_id=m.organization_id AND pm.user_id=m.user_id JOIN public."user" u ON u.id=m.user_id
 WHERE m.organization_id=p.organization_id AND pm.project_id=p.project_id AND m.user_id=p.requested_by AND m.active AND pm.active AND pm.role='maintainer'
 AND m.authorization_version=p.organization_version AND pm.authorization_version=p.project_version AND u."twoFactorEnabled") THEN RETURN NULL; END IF;
 reviews:=collab_worker.promotion_reviews(p.integration_id);
 IF reviews IS NULL OR reviews->>'revisionHash' IS DISTINCT FROM p.input->>'revisionHash' THEN RETURN NULL; END IF;
 RETURN reviews||jsonb_build_object('requester',p.requested_by,'organizationVersion',p.organization_version::text,'projectVersion',p.project_version::text);
END $$;
CREATE FUNCTION collab.request_promotion(candidate uuid, revision text, acknowledge_excluded boolean, reason text, request_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i collab.integrations; prior collab.promotions; operation uuid:=gen_random_uuid(); requested timestamptz:=date_trunc('milliseconds',clock_timestamp()); payload jsonb; input jsonb; oid text;
BEGIN
 SELECT * INTO i FROM collab.integrations WHERE id=candidate;
 IF i.id IS NULL OR collab.project_role(i.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 -- The shared integration-dispatch lock precedes organization locks everywhere.
 PERFORM pg_advisory_xact_lock(82467116); PERFORM pg_advisory_xact_lock(hashtextextended(i.organization_id::text,811));
 SELECT * INTO STRICT i FROM collab.integrations WHERE id=candidate;
 IF collab.project_role(i.project_id) IS DISTINCT FROM 'maintainer' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
 IF revision IS NULL OR revision!~'^[a-f0-9]{64}$' OR acknowledge_excluded IS DISTINCT FROM true OR reason IS NULL OR length(btrim(reason)) NOT BETWEEN 10 AND 2000 OR request_key IS NULL THEN RAISE EXCEPTION 'invalid_promotion' USING ERRCODE='P0001'; END IF;
 payload:=jsonb_build_object('integrationId',candidate,'revisionHash',revision,'acknowledgeExcluded',true,'reason',btrim(reason));
 SELECT * INTO prior FROM collab.promotions WHERE repository_id=i.repository_id AND requested_by=collab.actor() AND idempotency_key=request_key;
 IF FOUND THEN
  IF prior.request<>payload THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
  RETURN jsonb_build_object('promotionId',prior.id,'promotionSha',prior.promotion_sha,'status',prior.status,'replayed',true);
 END IF;
 IF collab_worker.promotion_reviews(candidate) IS NULL OR revision IS DISTINCT FROM collab_worker.integration_revision_hash(candidate) THEN RAISE EXCEPTION 'promotion_not_ready' USING ERRCODE='P0001'; END IF;
 IF EXISTS(SELECT 1 FROM collab.promotions WHERE repository_id=i.repository_id AND target_branch=i.target_branch AND status NOT IN ('applied','aborted')) OR EXISTS(SELECT 1 FROM collab.integrations WHERE repository_id=i.repository_id AND target_branch=i.target_branch AND status IN ('integrating','checking','unknown')) THEN RAISE EXCEPTION 'promotion_target_busy' USING ERRCODE='P0001'; END IF;
 IF length(i.target_branch)>240 OR i.target_branch~'[[:cntrl:][:space:]]' OR COALESCE(i.evidence->'merges'->-1->>'tree','')!~'^[a-f0-9]{40}$' THEN RAISE EXCEPTION 'invalid_promotion' USING ERRCODE='P0001'; END IF;
 input:=jsonb_build_object('version',1,'promotionId',operation,'integrationId',candidate,'repositoryId',i.repository_id,'requestedAt',to_char(requested AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'targetBranch',i.target_branch,'targetSha',i.target_sha,'candidateSha',i.evidence->>'candidateCommit','candidateTree',i.evidence->'merges'->-1->>'tree','inputHash',i.input_hash,'revisionHash',revision,
 'policyId',i.policy_id,'profileId',i.profile_id,'manifestHash',i.evidence->'snapshot'->>'manifestHash','worktreeCommit',i.evidence->'snapshot'->>'worktreeCommit');
 oid:=collab_worker.promotion_oid(input);
 INSERT INTO collab.promotions(id,organization_id,project_id,repository_id,integration_id,target_branch,input,promotion_sha,requested_by,organization_version,project_version,idempotency_key,request,requested_at)
 VALUES(operation,i.organization_id,i.project_id,i.repository_id,candidate,i.target_branch,input,oid,collab.actor(),
 (SELECT authorization_version FROM collab.memberships WHERE organization_id=i.organization_id AND user_id=collab.actor()),(SELECT authorization_version FROM collab.project_memberships WHERE project_id=i.project_id AND user_id=collab.actor()),request_key,payload,requested);
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(i.organization_id,i.project_id,collab.actor(),'promotion.queued',operation::text,payload||jsonb_build_object('promotionSha',oid,'targetSha',i.target_sha));
 RETURN jsonb_build_object('promotionId',operation,'promotionSha',oid,'status','queued','replayed',false);
END $$;
CREATE FUNCTION collab.promotion_action(operation uuid, action text, reason text, request_key uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab.promotions; prior collab.promotion_actions;
BEGIN
 SELECT * INTO p FROM collab.promotions WHERE id=operation;
 IF p.id IS NULL OR collab.project_role(p.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p.organization_id::text,811)); SELECT * INTO STRICT p FROM collab.promotions WHERE id=operation FOR UPDATE;
 IF collab.project_role(p.project_id) IS DISTINCT FROM 'maintainer' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
 IF action IS NULL OR action NOT IN ('cancel','reconcile') OR reason IS NULL OR length(btrim(reason)) NOT BETWEEN 10 AND 2000 OR request_key IS NULL THEN RAISE EXCEPTION 'invalid_promotion' USING ERRCODE='P0001'; END IF;
 SELECT * INTO prior FROM collab.promotion_actions WHERE promotion_id=operation AND actor_id=collab.actor() AND idempotency_key=request_key;
 IF FOUND THEN
  IF prior.kind<>action OR prior.reason<>btrim(reason) THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
 ELSE
  IF action='reconcile' AND p.status NOT IN ('unknown','blocked') THEN RAISE EXCEPTION 'promotion_not_reconciling' USING ERRCODE='P0001'; END IF;
  INSERT INTO collab.promotion_actions VALUES(operation,collab.actor(),request_key,action,btrim(reason),now());
  IF p.status NOT IN ('applied','aborted') THEN
   UPDATE collab.promotions SET stop_requested=true,status=CASE WHEN action='reconcile' THEN 'reconcile_queued' ELSE status END WHERE id=operation;
  END IF;
  INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(p.organization_id,p.project_id,collab.actor(),'promotion.'||action||'_requested',operation::text,jsonb_build_object('reason',btrim(reason),'previousStatus',p.status));
 END IF;
 RETURN jsonb_build_object('promotionId',operation,'status',(SELECT status FROM collab.promotions WHERE id=operation),'replayed',prior.promotion_id IS NOT NULL);
END $$;

CREATE FUNCTION collab_worker.claim_promotion(executor uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab.promotions;
BEGIN
 IF executor IS NULL THEN RAISE EXCEPTION 'invalid_promotion' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(82467116);
 FOR p IN SELECT * FROM collab.promotions WHERE status IN ('preparing','applying','reconciling') AND lease_expires_at<=clock_timestamp() ORDER BY organization_id,id LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended(p.organization_id::text,811));
  UPDATE collab.promotions SET status='unknown',error_code='promotion_lease_expired' WHERE id=p.id AND status IN ('preparing','applying','reconciling') AND lease_expires_at<=clock_timestamp();
  IF FOUND THEN INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(p.organization_id,p.project_id,p.requested_by,'promotion.unknown',p.id::text,jsonb_build_object('epoch',p.epoch::text,'failure','promotion_lease_expired')); END IF;
 END LOOP;
 SELECT * INTO p FROM collab.promotions WHERE status IN ('queued','reconcile_queued') ORDER BY requested_at,id LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p.organization_id::text,811)); SELECT * INTO STRICT p FROM collab.promotions WHERE id=p.id FOR UPDATE;
 UPDATE collab.promotions SET status=CASE WHEN status='queued' THEN 'preparing' ELSE 'reconciling' END,executor_id=executor,epoch=epoch+1,lease_expires_at=clock_timestamp()+interval '30 seconds' WHERE id=p.id RETURNING * INTO p;
 RETURN jsonb_build_object('id',p.id,'executorId',executor,'epoch',p.epoch::text,'input',p.input,'promotionSha',p.promotion_sha,'mode',CASE WHEN p.status='reconciling' THEN 'reconcile' ELSE 'prepare' END);
END $$;
CREATE FUNCTION collab_worker.lock_promotion(executor uuid, operation uuid, generation bigint) RETURNS collab.promotions LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab.promotions;
BEGIN
 SELECT * INTO p FROM collab.promotions WHERE id=operation;
 IF p.id IS NULL THEN RAISE EXCEPTION 'promotion_lease_lost' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p.organization_id::text,811)); SELECT * INTO STRICT p FROM collab.promotions WHERE id=operation FOR UPDATE;
 IF p.executor_id IS DISTINCT FROM executor OR p.epoch IS DISTINCT FROM generation OR generation IS NULL OR p.status NOT IN ('preparing','applying','reconciling') OR p.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'promotion_lease_lost' USING ERRCODE='P0001'; END IF;
 RETURN p;
END $$;
CREATE FUNCTION collab_worker.heartbeat_promotion(executor uuid, operation uuid, generation bigint) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab.promotions;
BEGIN
 p:=collab_worker.lock_promotion(executor,operation,generation);
 UPDATE collab.promotions SET lease_expires_at=clock_timestamp()+interval '30 seconds' WHERE id=operation;
 RETURN p.status='reconciling' OR collab_worker.promotion_grant(operation) IS NOT NULL;
END $$;
CREATE FUNCTION collab_worker.admit_promotion(executor uuid, operation uuid, generation bigint) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab.promotions; grant_value jsonb;
BEGIN
 p:=collab_worker.lock_promotion(executor,operation,generation);
 IF p.status<>'preparing' THEN RAISE EXCEPTION 'promotion_lease_lost' USING ERRCODE='P0001'; END IF;
 grant_value:=collab_worker.promotion_grant(operation); IF grant_value IS NULL THEN RETURN false; END IF;
 UPDATE collab.promotions SET status='applying',effect_grant=grant_value,effect_admitted_at=clock_timestamp() WHERE id=operation;
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(p.organization_id,p.project_id,p.requested_by,'promotion.effect_admitted',operation::text,jsonb_build_object('epoch',generation::text,'grant',grant_value));
 RETURN true;
END $$;
CREATE FUNCTION collab_worker.gate_promotion(executor uuid, operation uuid, generation bigint) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab.promotions; grant_value jsonb;
BEGIN
 p:=collab_worker.lock_promotion(executor,operation,generation);
 IF p.status<>'applying' OR p.effect_grant IS NULL THEN RAISE EXCEPTION 'promotion_lease_lost' USING ERRCODE='P0001'; END IF;
 -- Keep MFA enrollment stable across Git CAS. Membership/policy/review APIs
 -- share the organization lock already held until the caller commits.
 PERFORM 1 FROM public."user" WHERE id=p.requested_by FOR SHARE;
 grant_value:=collab_worker.promotion_grant(operation);
 IF grant_value IS NULL OR grant_value<>p.effect_grant THEN RETURN false; END IF;
 UPDATE collab.promotions SET lease_expires_at=clock_timestamp()+interval '150 seconds' WHERE id=operation;
 RETURN true;
END $$;

CREATE FUNCTION collab_worker.finish_promotion(executor uuid, operation uuid, generation bigint, result jsonb, failure text DEFAULT NULL) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab.promotions; repo collab.repositories; outcome text; seq bigint;
BEGIN
 SELECT * INTO p FROM collab.promotions WHERE id=operation;
 IF p.id IS NULL THEN RAISE EXCEPTION 'promotion_lease_lost' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p.organization_id::text,811)); SELECT * INTO STRICT p FROM collab.promotions WHERE id=operation FOR UPDATE;
 IF p.executor_id IS DISTINCT FROM executor OR p.epoch IS DISTINCT FROM generation OR generation IS NULL THEN RAISE EXCEPTION 'promotion_lease_lost' USING ERRCODE='P0001'; END IF;
 IF p.status IN ('applied','aborted') THEN RETURN p.status; END IF;
 p:=collab_worker.lock_promotion(executor,operation,generation);
 IF length(failure)>120 OR pg_column_size(result)>4096 THEN RAISE EXCEPTION 'invalid_promotion' USING ERRCODE='P0001'; END IF;
 outcome:='unknown';
 IF result IS NOT NULL THEN
  IF jsonb_typeof(result)<>'object' OR (result-ARRAY['decision','receiptRef','receiptOid','promotionSha','applicationEvidence','targetSha','targetMatchesExpected','appliedTargetCurrent'])<>'{}'::jsonb
   OR result->>'decision' IS NULL OR result->>'decision' NOT IN ('absent','prepared','applied','aborted') OR result->>'receiptRef' IS DISTINCT FROM 'refs/pi-collab/promotions/'||p.id::text OR result->>'promotionSha' IS DISTINCT FROM p.promotion_sha
   OR (result->>'targetSha' IS NOT NULL AND result->>'targetSha'!~'^[a-f0-9]{40}$')
   OR result->'targetMatchesExpected' IS DISTINCT FROM to_jsonb(COALESCE(result->>'targetSha'=p.input->>'targetSha',false))
   OR result->'appliedTargetCurrent' IS DISTINCT FROM to_jsonb(result->>'decision'='applied' AND COALESCE(result->>'targetSha'=p.promotion_sha,false))
  THEN RAISE EXCEPTION 'invalid_promotion' USING ERRCODE='P0001'; END IF;
  IF result->>'decision' IN ('applied','aborted') THEN
   IF result->>'receiptOid' IS DISTINCT FROM collab_worker.promotion_oid(p.input,result->>'decision') OR (result->>'decision'='applied' AND (result->>'applicationEvidence' IS DISTINCT FROM 'receipt' OR p.effect_grant IS NULL)) OR (result->>'decision'='aborted' AND result->'applicationEvidence' IS DISTINCT FROM 'null'::jsonb) THEN RAISE EXCEPTION 'invalid_promotion' USING ERRCODE='P0001'; END IF;
   SELECT * INTO STRICT repo FROM collab.repositories WHERE id=p.repository_id FOR UPDATE;
   outcome:='blocked';
   IF repo.base_sha=p.input->>'targetSha' AND repo.default_branch=p.target_branch THEN
    IF result->>'decision'='applied' AND result->>'targetSha'=p.promotion_sha THEN
     outcome:='applied';
     UPDATE collab.repositories SET base_sha=p.promotion_sha WHERE id=p.repository_id;
     UPDATE collab.projects SET event_sequence=event_sequence+1 WHERE id=p.project_id RETURNING event_sequence INTO seq;
     INSERT INTO collab.repository_baselines(organization_id,project_id,repository_id,promotion_id,sequence,target_branch,old_sha,new_sha)
     VALUES(p.organization_id,p.project_id,p.repository_id,p.id,seq,p.target_branch,repo.base_sha,p.promotion_sha);
    ELSIF result->>'decision'='aborted' AND result->>'targetSha'=repo.base_sha THEN outcome:='aborted'; END IF;
   END IF;
  END IF;
 END IF;
 UPDATE collab.promotions SET status=outcome,observation=result,error_code=CASE WHEN outcome='blocked' THEN 'promotion_target_diverged' ELSE failure END,finished_at=CASE WHEN outcome IN ('applied','aborted') THEN clock_timestamp() ELSE NULL END WHERE id=operation;
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(p.organization_id,p.project_id,p.requested_by,'promotion.'||outcome,operation::text,jsonb_build_object('epoch',generation::text,'observation',result,'failure',failure));
 RETURN outcome;
END $$;

-- All legacy and new integration adapters use this same kernel. Promotions
-- already hold occupancy while queued, during uncertainty and reconciliation.
CREATE OR REPLACE FUNCTION collab_worker.claim_integration_compatible(executor uuid, resolutions_supported boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
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
 SELECT * INTO i FROM collab.integrations q WHERE q.status='queued' AND (resolutions_supported OR NOT EXISTS(SELECT 1 FROM collab.integration_sources s JOIN collab.task_results r ON r.id=s.result_id JOIN collab.resolution_tasks rt ON rt.task_id=r.task_id WHERE s.integration_id=q.id))
 AND NOT EXISTS(SELECT 1 FROM collab.promotions busy WHERE busy.repository_id=q.repository_id AND busy.target_branch=q.target_branch AND busy.status NOT IN ('applied','aborted'))
 AND NOT EXISTS(SELECT 1 FROM collab.integrations busy WHERE busy.repository_id=q.repository_id AND busy.target_branch=q.target_branch AND busy.status IN ('integrating','checking','unknown'))
 AND NOT EXISTS(SELECT 1 FROM collab.integrations earlier WHERE earlier.repository_id=q.repository_id AND earlier.target_branch=q.target_branch AND earlier.status='queued' AND (earlier.created_at,earlier.id)<(q.created_at,q.id))
 ORDER BY q.created_at,q.id LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 UPDATE collab.integrations SET status='integrating',executor_id=executor,epoch=epoch+1,lease_expires_at=clock_timestamp()+interval '30 seconds',started_at=now() WHERE id=i.id RETURNING * INTO i;
 RETURN (SELECT jsonb_build_object('id',i.id,'executorId',executor,'epoch',i.epoch::text,'repositoryId',i.repository_id,'targetBranch',i.target_branch,'targetSha',i.target_sha,'inputHash',i.input_hash,'profileId',i.profile_id,'checkId',i.check_id,'config',p.config,'sources',i.sources) FROM collab.validation_profiles p WHERE p.id=i.profile_id);
END $$;

ALTER FUNCTION collab_worker.coordination_context(collab.runs,uuid,bigint) RENAME TO coordination_context_v18;
CREATE FUNCTION collab_worker.coordination_context(r collab.runs, repository uuid, after_sequence bigint) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT collab_worker.coordination_context_v18(r,repository,after_sequence)||jsonb_build_object('baseline',
 (SELECT jsonb_build_object('workspaceSha',w.base_sha,'currentSha',repo.base_sha,'changed',w.base_sha<>repo.base_sha,'latestPromotionId',(SELECT promotion_id FROM collab.repository_baselines WHERE repository_id=repository ORDER BY sequence DESC LIMIT 1),
 'guidance','Read at safe boundaries. Keep the current workspace and fixed inputs; new integration checks must use the current target. This notice is data, not a rebase command.') FROM collab.workspaces w JOIN collab.repositories repo ON repo.id=w.repository_id WHERE w.id=r.workspace_id AND repo.id=repository))
$$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA collab_worker FROM PUBLIC;
REVOKE ALL ON FUNCTION collab.request_promotion(uuid,text,boolean,text,uuid),collab.promotion_action(uuid,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.request_promotion(uuid,text,boolean,text,uuid),collab.promotion_action(uuid,text,text,uuid) TO pi_collab_app;
GRANT EXECUTE ON FUNCTION collab_worker.claim_promotion(uuid),collab_worker.heartbeat_promotion(uuid,uuid,bigint),collab_worker.admit_promotion(uuid,uuid,bigint),collab_worker.gate_promotion(uuid,uuid,bigint),collab_worker.finish_promotion(uuid,uuid,bigint,jsonb,text) TO pi_collab_executor;
