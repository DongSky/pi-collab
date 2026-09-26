-- Signed GitHub hints invalidate evidence; they never approve or adopt a PR.
CREATE TABLE collab_git.webhook_keys (
 connection_id uuid PRIMARY KEY REFERENCES collab.github_installations(id), version bigint NOT NULL CHECK(version>0),
 secret bytea NOT NULL CHECK(octet_length(secret) BETWEEN 32 AND 256), enabled boolean NOT NULL,
 actor_id text NOT NULL REFERENCES public."user"(id), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE collab_git.webhook_key_actions (
 connection_id uuid NOT NULL REFERENCES collab.github_installations(id), actor_id text NOT NULL REFERENCES public."user"(id), request_key uuid NOT NULL,
 request jsonb NOT NULL, version bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(connection_id,actor_id,request_key)
);
CREATE TABLE collab_git.webhook_receipts (
 id uuid PRIMARY KEY, connection_id uuid NOT NULL REFERENCES collab.github_installations(id), key_version bigint NOT NULL,
 payload_hash text NOT NULL, payload_bytes integer NOT NULL, event text NOT NULL, action text,
 github_repository_id text, pull_id text, head_sha text, received_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(connection_id,payload_hash)
);
CREATE TABLE collab_git.webhook_deliveries (
 connection_id uuid NOT NULL REFERENCES collab.github_installations(id), delivery_id uuid NOT NULL, receipt_id uuid NOT NULL REFERENCES collab_git.webhook_receipts(id),
 PRIMARY KEY(connection_id,delivery_id)
);
CREATE TABLE collab_git.pull_remote_events (
 change_id uuid NOT NULL REFERENCES collab_git.pull_changes(id), receipt_id uuid NOT NULL REFERENCES collab_git.webhook_receipts(id),
 PRIMARY KEY(change_id,receipt_id)
);
ALTER TABLE collab_git.pull_changes ADD COLUMN remote_code_version bigint NOT NULL DEFAULT 0;
ALTER TABLE collab_git.pull_changes ADD COLUMN remote_checks_version bigint NOT NULL DEFAULT 0;
ALTER TABLE collab_git.pull_observation_jobs ADD COLUMN remote_code_version bigint NOT NULL DEFAULT 0;
ALTER TABLE collab_git.pull_checks_jobs ADD COLUMN remote_checks_version bigint NOT NULL DEFAULT 0;
CREATE FUNCTION collab_git.capture_remote_version() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_TABLE_NAME='pull_observation_jobs' THEN
  SELECT remote_code_version INTO STRICT NEW.remote_code_version FROM collab_git.pull_changes WHERE id=NEW.change_id;
 ELSE
  SELECT c.remote_checks_version INTO STRICT NEW.remote_checks_version FROM collab_git.pull_changes c JOIN collab_git.pull_revision_jobs r ON r.change_id=c.id WHERE r.id=NEW.revision_id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pull_observation_remote_version BEFORE INSERT ON collab_git.pull_observation_jobs FOR EACH ROW EXECUTE FUNCTION collab_git.capture_remote_version();
CREATE TRIGGER pull_checks_remote_version BEFORE INSERT ON collab_git.pull_checks_jobs FOR EACH ROW EXECUTE FUNCTION collab_git.capture_remote_version();

-- Fixed-length comparison with no early exit. Keys never leave this database
-- function boundary; the Web role has no table access and no key export API.
CREATE FUNCTION collab_git.signature_equal(a bytea,b bytea) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE n integer; difference integer:=0;
BEGIN
 IF a IS NULL OR b IS NULL OR octet_length(a)<>32 OR octet_length(b)<>32 THEN RETURN false; END IF;
 FOR n IN 0..31 LOOP difference:=difference | (get_byte(a,n) # get_byte(b,n)); END LOOP;
 RETURN difference=0;
END $$;

-- Only the local operator's administrator connection may call configuration.
CREATE FUNCTION collab_git.configure_webhook(connection uuid, expected bigint, key uuid, payload jsonb, verification_secret bytea) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c collab.github_installations; previous collab_git.webhook_key_actions; current_version bigint; request jsonb;
BEGIN
 SELECT * INTO c FROM collab.github_installations WHERE id=connection;
 IF c.id IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(c.organization_id::text,811)); PERFORM 1 FROM public."user" WHERE id=collab.actor() FOR SHARE;
 IF COALESCE(collab.org_role(c.organization_id),'') NOT IN ('owner','admin') OR NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF NOT c.enabled OR expected IS NULL OR expected<0 OR key IS NULL OR jsonb_typeof(payload) IS DISTINCT FROM 'object'
 OR (payload-ARRAY['enabled','reason'])<>'{}'::jsonb OR jsonb_typeof(payload->'enabled') IS DISTINCT FROM 'boolean'
 OR jsonb_typeof(payload->'reason') IS DISTINCT FROM 'string' OR length(btrim(payload->>'reason')) NOT BETWEEN 10 AND 2000
 OR verification_secret IS NULL OR octet_length(verification_secret) NOT BETWEEN 32 AND 256
 THEN RAISE EXCEPTION 'invalid_webhook_configuration' USING ERRCODE='P0001'; END IF;
 request:=payload||jsonb_build_object('expectedVersion',expected::text,'fingerprint',encode(sha256(verification_secret),'hex'));
 SELECT * INTO previous FROM collab_git.webhook_key_actions WHERE connection_id=connection AND actor_id=collab.actor() AND request_key=key;
 IF FOUND THEN
  IF previous.request<>request THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
  RETURN jsonb_build_object('version',previous.version::text,'replayed',true);
 END IF;
 SELECT COALESCE((SELECT version FROM collab_git.webhook_keys WHERE connection_id=connection),0) INTO current_version;
 IF current_version<>expected THEN RAISE EXCEPTION 'stale_revision' USING ERRCODE='P0001'; END IF;
 INSERT INTO collab_git.webhook_keys VALUES(connection,current_version+1,verification_secret,(payload->>'enabled')::boolean,collab.actor(),now())
 ON CONFLICT(connection_id) DO UPDATE SET version=EXCLUDED.version,secret=EXCLUDED.secret,enabled=EXCLUDED.enabled,actor_id=EXCLUDED.actor_id,updated_at=now();
 INSERT INTO collab_git.webhook_key_actions VALUES(connection,collab.actor(),key,request,current_version+1,now());
 UPDATE collab_git.pull_changes p SET remote_code_version=remote_code_version+1,remote_checks_version=remote_checks_version+1
 FROM collab.github_bindings b WHERE b.connection_id=connection AND b.github_repository_id=p.github_repository_id;
 INSERT INTO collab.audit_events(organization_id,actor_id,action,resource_id,detail) VALUES(c.organization_id,collab.actor(),'github.webhook_configured',connection::text,jsonb_build_object('version',(current_version+1)::text,'enabled',payload->'enabled','reason',payload->>'reason'));
 RETURN jsonb_build_object('version',(current_version+1)::text,'replayed',false);
END $$;

CREATE FUNCTION collab.receive_github_webhook(app text, delivery uuid, event_type text, signature text, raw_body bytea) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE body jsonb; c collab.github_installations; k collab_git.webhook_keys; known collab_git.webhook_receipts; receipt uuid:=gen_random_uuid();
 digest text; repo text; pull text; head text; action text; affected integer:=0; code_changed boolean; valid boolean:=false;
BEGIN
 IF app IS NULL OR app!~'^[1-9][0-9]{0,15}$' OR delivery IS NULL OR signature IS NULL OR signature!~'^sha256=[a-f0-9]{64}$'
 OR raw_body IS NULL OR octet_length(raw_body) NOT BETWEEN 2 AND 2097152 OR COALESCE(event_type,'') NOT IN ('ping','push','pull_request','check_run','check_suite')
 THEN RAISE EXCEPTION 'invalid_webhook_request' USING ERRCODE='P0001'; END IF;
 BEGIN body:=convert_from(raw_body,'UTF8')::jsonb; EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'invalid_webhook_request' USING ERRCODE='P0001'; END;
 IF jsonb_typeof(body) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'invalid_webhook_request' USING ERRCODE='P0001'; END IF;
 IF event_type='ping' THEN
  IF body ?| ARRAY['pull_request','check_run','check_suite','ref'] OR NOT body ? 'zen' OR NOT body ? 'hook_id' THEN RAISE EXCEPTION 'invalid_webhook_request' USING ERRCODE='P0001'; END IF;
  FOR k IN SELECT w.* FROM collab_git.webhook_keys w JOIN collab.github_installations i ON i.id=w.connection_id WHERE i.app_id=app AND i.enabled AND w.enabled ORDER BY w.connection_id LIMIT 100 LOOP
   valid:=valid OR collab_git.signature_equal(collab_crypto.hmac(raw_body,k.secret,'sha256'),decode(substr(signature,8),'hex'));
  END LOOP;
  IF NOT valid THEN RAISE EXCEPTION 'webhook_signature_rejected' USING ERRCODE='P0001'; END IF;
  RETURN jsonb_build_object('accepted',true,'ping',true);
 END IF;
 SELECT * INTO c FROM collab.github_installations WHERE app_id=app AND installation_id=body->'installation'->>'id' AND enabled;
 IF c.id IS NULL THEN RAISE EXCEPTION 'webhook_signature_rejected' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(c.organization_id::text,811));
 SELECT * INTO k FROM collab_git.webhook_keys WHERE connection_id=c.id AND enabled FOR SHARE;
 IF k.connection_id IS NULL OR NOT EXISTS(SELECT 1 FROM collab.github_installations WHERE id=c.id AND enabled)
 OR NOT collab_git.signature_equal(collab_crypto.hmac(raw_body,k.secret,'sha256'),decode(substr(signature,8),'hex'))
 THEN RAISE EXCEPTION 'webhook_signature_rejected' USING ERRCODE='P0001'; END IF;
 repo:=body->'repository'->>'id'; action:=body->>'action';
 IF repo IS NULL OR repo!~'^[1-9][0-9]{0,15}$' OR body->'repository'->'owner'->>'id' IS DISTINCT FROM c.account_id
 THEN RAISE EXCEPTION 'invalid_webhook_scope' USING ERRCODE='P0001'; END IF;
 IF event_type='pull_request' THEN
  pull:=body->'pull_request'->>'id'; head:=body->'pull_request'->'head'->>'sha';
  IF pull IS NULL OR pull!~'^[1-9][0-9]{0,15}$' OR body ?| ARRAY['check_run','check_suite','ref']
  OR body->'pull_request'->'base'->'repo'->>'id' IS DISTINCT FROM repo
  OR COALESCE(action,'') NOT IN ('assigned','unassigned','labeled','unlabeled','opened','edited','closed','reopened','synchronize','converted_to_draft','ready_for_review','locked','unlocked','review_requested','review_request_removed','auto_merge_enabled','auto_merge_disabled','enqueued','dequeued')
  THEN RAISE EXCEPTION 'invalid_webhook_request' USING ERRCODE='P0001'; END IF;
 ELSIF event_type IN ('check_run','check_suite') THEN
  head:=body->event_type->>'head_sha';
  IF (body- event_type) ?| ARRAY['pull_request','check_run','check_suite','ref'] OR COALESCE(action,'') NOT IN ('created','completed','rerequested','requested','requested_action')
  OR COALESCE(body->event_type->>'id','')!~'^[1-9][0-9]{0,15}$'
  THEN RAISE EXCEPTION 'invalid_webhook_request' USING ERRCODE='P0001'; END IF;
 ELSE
  head:=body->>'after';
  IF body ?| ARRAY['pull_request','check_run','check_suite','action'] OR COALESCE(body->>'ref','')!~'^refs/(heads|tags)/.+'
  OR COALESCE(body->>'before','')!~'^[a-f0-9]{40}$' THEN RAISE EXCEPTION 'invalid_webhook_request' USING ERRCODE='P0001'; END IF;
 END IF;
 IF head IS NULL OR head!~'^[a-f0-9]{40}$' THEN RAISE EXCEPTION 'invalid_webhook_request' USING ERRCODE='P0001'; END IF;
 digest:=encode(sha256(raw_body),'hex');
 SELECT r.* INTO known FROM collab_git.webhook_deliveries d JOIN collab_git.webhook_receipts r ON r.id=d.receipt_id WHERE d.connection_id=c.id AND d.delivery_id=delivery;
 IF FOUND THEN
  IF known.payload_hash<>digest OR known.event<>event_type THEN RAISE EXCEPTION 'webhook_delivery_conflict' USING ERRCODE='P0001'; END IF;
  RETURN jsonb_build_object('accepted',true,'replayed',true);
 END IF;
 SELECT * INTO known FROM collab_git.webhook_receipts WHERE connection_id=c.id AND payload_hash=digest;
 IF FOUND THEN
  IF known.event<>event_type THEN RAISE EXCEPTION 'webhook_delivery_conflict' USING ERRCODE='P0001'; END IF;
  -- Delivery headers are not signed. Do not let replayed bytes create unbounded aliases.
  RETURN jsonb_build_object('accepted',true,'replayed',true);
 END IF;
 INSERT INTO collab_git.webhook_receipts VALUES(receipt,c.id,k.version,digest,octet_length(raw_body),event_type,action,repo,pull,head,now());
 INSERT INTO collab_git.webhook_deliveries VALUES(c.id,delivery,receipt);
 code_changed:=event_type IN ('push','pull_request');
 INSERT INTO collab_git.pull_remote_events
 SELECT p.id,receipt FROM collab_git.pull_changes p JOIN collab.github_bindings b ON b.github_repository_id=p.github_repository_id
 WHERE b.connection_id=c.id AND b.github_repository_id=repo AND (pull IS NULL OR p.pull_id=pull)
 AND (event_type<>'push' OR body->>'ref' IN (
  SELECT 'refs/heads/'||(snapshot->>side) FROM
   (SELECT COALESCE((SELECT observation->'snapshot' FROM collab_git.pull_observation_jobs WHERE id=p.latest_observation_id),
    (SELECT evidence FROM collab_git.pull_change_observations WHERE change_id=p.id ORDER BY sequence DESC LIMIT 1)) AS snapshot) current
   CROSS JOIN unnest(ARRAY['headRef','baseRef']) side))
 AND (code_changed OR EXISTS(SELECT 1 FROM collab_git.pull_observation_jobs o WHERE o.id=p.latest_observation_id AND o.status='observed' AND o.remote_code_version=p.remote_code_version AND o.observation->'snapshot'->>'headSha'=head));
 GET DIAGNOSTICS affected=ROW_COUNT;
 UPDATE collab_git.pull_changes SET remote_code_version=remote_code_version+CASE WHEN code_changed THEN 1 ELSE 0 END,remote_checks_version=remote_checks_version+1
 WHERE id IN (SELECT change_id FROM collab_git.pull_remote_events WHERE receipt_id=receipt);
 -- No actor is attributed to the unsigned sender.login field.
 RETURN jsonb_build_object('accepted',true,'replayed',false);
END $$;

CREATE FUNCTION collab.pull_remote_events(change uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c collab_git.pull_changes; d collab_git.pull_deliveries; connection uuid; latest_epoch bigint;
BEGIN
 SELECT * INTO c FROM collab_git.pull_changes WHERE id=change; SELECT * INTO d FROM collab_git.pull_deliveries WHERE id=change;
 IF c.id IS NULL OR collab.project_role(d.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 SELECT b.connection_id INTO connection FROM collab.github_bindings b WHERE b.github_repository_id=c.github_repository_id;
 SELECT remote_code_version INTO latest_epoch FROM collab_git.pull_observation_jobs WHERE id=c.latest_observation_id AND status='observed';
 RETURN jsonb_build_object('configured',EXISTS(SELECT 1 FROM collab_git.webhook_keys w JOIN collab.github_installations i ON i.id=w.connection_id WHERE w.connection_id=connection AND w.enabled AND i.enabled),
 'needsRefresh',COALESCE(latest_epoch,0)<>c.remote_code_version,'codeVersion',c.remote_code_version::text,'checksVersion',c.remote_checks_version::text,
 'events',(SELECT COALESCE(jsonb_agg(to_jsonb(row)-'received_at' ORDER BY received_at DESC,id),'[]'::jsonb) FROM
  (SELECT r.id,r.event,r.action,r.head_sha AS "headSha",r.received_at AS "receivedAt",r.received_at
   FROM collab_git.pull_remote_events e JOIN collab_git.webhook_receipts r ON r.id=e.receipt_id WHERE e.change_id=change ORDER BY r.received_at DESC,r.id LIMIT 20) row));
END $$;

CREATE OR REPLACE FUNCTION collab_git.pull_observation_grant(job uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT COALESCE((SELECT NOT j.stop_requested AND t.version=j.task_version AND c.observation_version=j.expected_version AND c.remote_code_version=j.remote_code_version
 AND collab_git.workspace_authority(j.task_id,j.actor_id,j.organization_version,j.project_version)
 AND j.admission=collab_git.pull_observation_source(j.change_id)
 FROM collab_git.pull_observation_jobs j JOIN collab.tasks t ON t.id=j.task_id JOIN collab_git.pull_changes c ON c.id=j.change_id WHERE j.id=job),false)
$$;

CREATE OR REPLACE FUNCTION collab_git.pull_revision_source(change uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT collab_git.pull_observation_source(change)||jsonb_build_object('observationId',o.id,'observationHash',o.observation_hash,'snapshot',o.observation->'snapshot')
 FROM collab_git.pull_changes c JOIN collab_git.pull_observation_jobs o ON o.id=c.latest_observation_id
 WHERE c.id=change AND o.status='observed' AND o.remote_code_version=c.remote_code_version AND collab_git.pull_observation_source(change) IS NOT NULL
$$;

CREATE OR REPLACE FUNCTION collab_git.pull_checks_grant(job uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT COALESCE((SELECT NOT j.stop_requested AND t.version=j.task_version
 AND collab_git.workspace_authority(j.task_id,j.actor_id,j.organization_version,j.project_version)
 AND j.admission=collab_git.pull_checks_source(j.revision_id) AND j.remote_checks_version=(SELECT c.remote_checks_version FROM collab_git.pull_changes c WHERE c.id=(j.admission->>'changeId')::uuid)
 FROM collab_git.pull_checks_jobs j JOIN collab.tasks t ON t.id=j.task_id WHERE j.id=job),false)
$$;

CREATE OR REPLACE FUNCTION collab_git.pull_checks_result(job uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('jobId',j.id,'revisionId',revision_id,'status',status,'actorName',(SELECT name FROM public."user" WHERE id=j.actor_id),
 'stopRequested',stop_requested,'failure',failure,'evidenceHash',evidence_hash,'completedAt',finished_at,'satisfied',satisfied,
 'policyId',admission->'policy'->>'id','rules',CASE WHEN evidence IS NULL THEN NULL ELSE collab_git.checks_verdict(admission->'policy'->'config',evidence->'checks') END,
 'eligible',COALESCE(status='observed' AND satisfied AND admission=collab_git.pull_checks_source(revision_id)
 AND j.remote_checks_version=(SELECT c.remote_checks_version FROM collab_git.pull_changes c WHERE c.id=(j.admission->>'changeId')::uuid)
 AND finished_at+make_interval(secs=>(admission->'policy'->'config'->>'maxAgeSeconds')::integer)>statement_timestamp()
 AND NOT EXISTS(SELECT 1 FROM collab_git.pull_checks_jobs newer WHERE newer.revision_id=j.revision_id AND newer.sequence>j.sequence),false))
 FROM collab_git.pull_checks_jobs j WHERE id=job
$$;

CREATE FUNCTION collab.github_webhook_state(connection uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c collab.github_installations;
BEGIN
 SELECT * INTO c FROM collab.github_installations WHERE id=connection;
 IF c.id IS NULL OR COALESCE(collab.org_role(c.organization_id),'') NOT IN ('owner','admin') THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('version',COALESCE((SELECT version::text FROM collab_git.webhook_keys WHERE connection_id=connection),'0'),
 'enabled',c.enabled AND EXISTS(SELECT 1 FROM collab_git.webhook_keys WHERE connection_id=connection AND enabled),
 'lastReceivedAt',(SELECT max(received_at) FROM collab_git.webhook_receipts WHERE connection_id=connection));
END $$;
REVOKE ALL ON FUNCTION collab.github_webhook_state(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.github_webhook_state(uuid) TO pi_collab_app;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA collab_git FROM PUBLIC;
REVOKE ALL ON FUNCTION collab.receive_github_webhook(text,uuid,text,text,bytea),collab.pull_remote_events(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.receive_github_webhook(text,uuid,text,text,bytea),collab.pull_remote_events(uuid) TO pi_collab_app;
