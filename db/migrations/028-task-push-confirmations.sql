-- A human disclosure attestation and destination reservation, NOT a send job.
-- Future dispatch must require a separate explicit request and durable gate.
CREATE TABLE collab_git.push_confirmations (
 id uuid PRIMARY KEY, preview_id uuid NOT NULL REFERENCES collab_git.push_previews(id),
 organization_id uuid NOT NULL, project_id uuid NOT NULL, task_id uuid NOT NULL,
 actor_id text NOT NULL REFERENCES public."user"(id), organization_version bigint NOT NULL, project_version bigint NOT NULL,
 request_key uuid NOT NULL, request jsonb NOT NULL, manifest_hash text NOT NULL,
 github_repository_id text NOT NULL, ref text NOT NULL,
 status text NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','withdrawn')),
 created_at timestamptz NOT NULL DEFAULT now(), withdrawn_at timestamptz,
 UNIQUE(preview_id,actor_id,request_key),
 FOREIGN KEY(organization_id,project_id,task_id) REFERENCES collab.tasks(organization_id,project_id,id)
);
-- Stable remote identity, deliberately not installation, local repo or tenant.
CREATE UNIQUE INDEX task_push_destination_owner ON collab_git.push_confirmations(github_repository_id,ref) WHERE status='reserved';
CREATE TABLE collab_git.push_confirmation_actions (
 confirmation_id uuid NOT NULL REFERENCES collab_git.push_confirmations(id), actor_id text NOT NULL REFERENCES public."user"(id),
 request_key uuid NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(confirmation_id,actor_id,request_key)
);

CREATE FUNCTION collab_git.push_confirmation_scope(preview uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('manifestHash',p.manifest_hash,'observationHash',p.observation_hash,
 'destination',jsonb_build_object('repository',p.admission->'binding','ref',p.observation->'target'->>'ref',
 'expectedOld',p.observation->'target'->'observedOld','newSha',p.admission->>'head','baseline',p.observation->'target'->>'defaultSha'),
 'commits',(SELECT jsonb_agg(jsonb_build_object('oid',c->>'oid','hash',o->>'hash','changedPaths',c->'changedPaths') ORDER BY c->>'oid')
 FROM jsonb_array_elements(p.manifest->'commits') c JOIN jsonb_array_elements(p.manifest->'objects') o ON o->>'oid'=c->>'oid' AND o->>'type'='commit'))
 FROM collab_git.push_previews p WHERE p.id=preview AND p.status='ready'
$$;
CREATE FUNCTION collab_git.push_confirmation_source_valid(preview uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT COALESCE((SELECT p.status='ready' AND NOT p.stop_requested AND p.manifest_hash IS NOT NULL
 AND t.version=p.task_version AND r.revision=p.run_revision AND r.status IN ('completed','failed','cancelled') AND w.status='stopped' AND w.runtime='native'
 AND b.version=p.binding_version AND b.connection_id=p.connection_id AND b.installation_version=p.installation_version AND c.enabled AND c.version=p.installation_version
 AND p.admission->'binding'=collab_git.task_push_binding(p.repository_id)
 FROM collab_git.push_previews p JOIN collab.tasks t ON t.id=p.task_id JOIN collab.runs r ON r.id=p.run_id JOIN collab.workspaces w ON w.id=p.workspace_id
 JOIN collab.github_bindings b ON b.repository_id=p.repository_id JOIN collab.github_installations c ON c.id=p.connection_id WHERE p.id=preview),false)
$$;
CREATE FUNCTION collab_git.push_confirmation_result(confirmation uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',id,'previewId',preview_id,'actorId',actor_id,'status',status,'manifestHash',manifest_hash,'createdAt',created_at,'withdrawnAt',withdrawn_at,
 'valid',status='reserved' AND collab_git.push_confirmation_source_valid(preview_id) AND collab_git.workspace_authority(task_id,actor_id,organization_version,project_version),
 'destination',request->'destination','commitCount',jsonb_array_length(request->'commits')) FROM collab_git.push_confirmations WHERE id=confirmation
$$;
CREATE FUNCTION collab.task_push_confirmation_context(preview uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab_git.push_previews; scope jsonb;
BEGIN
 SELECT * INTO p FROM collab_git.push_previews WHERE id=preview;
 IF p.id IS NULL OR collab.project_role(p.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 scope:=collab_git.push_confirmation_scope(preview);
 RETURN jsonb_build_object('scope',scope,'canConfirm',collab_git.workspace_authority(p.task_id,collab.actor()) AND collab_git.push_confirmation_source_valid(preview),
 'canWithdraw',collab_git.workspace_authority(p.task_id,collab.actor()),
 'occupied',EXISTS(SELECT 1 FROM collab_git.push_confirmations WHERE github_repository_id=p.admission->'binding'->>'githubRepositoryId' AND ref=p.observation->'target'->>'ref' AND status='reserved'),
 'confirmations',(SELECT COALESCE(jsonb_agg(collab_git.push_confirmation_result(id) ORDER BY created_at DESC,id),'[]'::jsonb)
 FROM (SELECT id,created_at FROM collab_git.push_confirmations WHERE preview_id=preview ORDER BY created_at DESC,id LIMIT 50) records));
END $$;

-- Idempotency precedes artifact work and credentials. Historical replies do not
-- renew a reservation or revive the authority versions on the original record.
CREATE FUNCTION collab.lookup_task_push_confirmation(preview uuid, request_key uuid, payload jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab_git.push_previews; prior collab_git.push_confirmations;
BEGIN
 SELECT * INTO p FROM collab_git.push_previews WHERE id=preview;
 IF p.id IS NULL OR collab.project_role(p.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 IF NOT collab_git.workspace_authority(p.task_id,collab.actor()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF request_key IS NULL OR payload IS NULL OR jsonb_typeof(payload)<>'object' OR octet_length(payload::text)>262144
 OR (payload-ARRAY['manifestHash','observationHash','destination','commits','acknowledgeHistory','acknowledgeDestination','acknowledgeDisclosure'])<>'{}'::jsonb
 OR payload->'acknowledgeHistory' IS DISTINCT FROM 'true'::jsonb OR payload->'acknowledgeDestination' IS DISTINCT FROM 'true'::jsonb
 OR payload->'acknowledgeDisclosure' IS DISTINCT FROM 'true'::jsonb
 THEN RAISE EXCEPTION 'invalid_task_push_confirmation' USING ERRCODE='P0001'; END IF;
 SELECT * INTO prior FROM collab_git.push_confirmations WHERE preview_id=preview AND actor_id=collab.actor() AND push_confirmations.request_key=lookup_task_push_confirmation.request_key;
 IF FOUND THEN
  IF prior.request<>payload THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
  RETURN collab_git.push_confirmation_result(prior.id)||jsonb_build_object('replayed',true);
 END IF;
 RETURN NULL;
END $$;

CREATE FUNCTION collab.confirm_task_push(preview uuid, request_key uuid, payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab_git.push_previews; prior jsonb; scope jsonb; confirmation uuid:=gen_random_uuid(); ov bigint; pv bigint;
BEGIN
 SELECT * INTO p FROM collab_git.push_previews WHERE id=preview;
 IF p.id IS NULL OR collab.project_role(p.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p.organization_id::text,811));
 PERFORM 1 FROM public."user" WHERE id=collab.actor() FOR SHARE;
 PERFORM 1 FROM collab.tasks WHERE id=p.task_id FOR SHARE; PERFORM 1 FROM collab.runs WHERE id=p.run_id FOR SHARE;
 PERFORM 1 FROM collab.workspaces WHERE id=p.workspace_id FOR SHARE; PERFORM 1 FROM collab.github_bindings WHERE repository_id=p.repository_id FOR SHARE;
 PERFORM 1 FROM collab.github_installations WHERE id=p.connection_id FOR SHARE;
 prior:=collab.lookup_task_push_confirmation(preview,request_key,payload); IF prior IS NOT NULL THEN RETURN prior; END IF;
 IF collab_git.push_confirmation_source_valid(preview) IS DISTINCT FROM true THEN RAISE EXCEPTION 'stale_task_push_confirmation' USING ERRCODE='P0001'; END IF;
 scope:=collab_git.push_confirmation_scope(preview);
 IF (payload-ARRAY['acknowledgeHistory','acknowledgeDestination','acknowledgeDisclosure']) IS DISTINCT FROM scope
 THEN RAISE EXCEPTION 'invalid_task_push_confirmation' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('github.com/'||(scope->'destination'->'repository'->>'githubRepositoryId')||'/'||(scope->'destination'->>'ref'),92816421));
 IF EXISTS(SELECT 1 FROM collab_git.push_confirmations WHERE github_repository_id=scope->'destination'->'repository'->>'githubRepositoryId' AND ref=scope->'destination'->>'ref' AND status='reserved')
 THEN RAISE EXCEPTION 'task_push_destination_busy' USING ERRCODE='P0001'; END IF;
 IF (SELECT count(*) FROM collab_git.push_confirmations WHERE project_id=p.project_id AND status='reserved')>=20 THEN RAISE EXCEPTION 'task_push_confirmation_limit' USING ERRCODE='P0001'; END IF;
 SELECT authorization_version INTO ov FROM collab.memberships WHERE organization_id=p.organization_id AND user_id=collab.actor();
 SELECT authorization_version INTO pv FROM collab.project_memberships WHERE project_id=p.project_id AND user_id=collab.actor();
 INSERT INTO collab_git.push_confirmations(id,preview_id,organization_id,project_id,task_id,actor_id,organization_version,project_version,request_key,request,manifest_hash,github_repository_id,ref)
 VALUES(confirmation,preview,p.organization_id,p.project_id,p.task_id,collab.actor(),ov,pv,request_key,payload,p.manifest_hash,scope->'destination'->'repository'->>'githubRepositoryId',scope->'destination'->>'ref');
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(p.organization_id,p.project_id,collab.actor(),'task_push.confirmed',confirmation::text,
 jsonb_build_object('previewId',preview,'manifestHash',p.manifest_hash,'ref',scope->'destination'->>'ref','commitCount',jsonb_array_length(scope->'commits')));
 RETURN collab_git.push_confirmation_result(confirmation)||jsonb_build_object('replayed',false);
END $$;

CREATE FUNCTION collab.withdraw_task_push_confirmation(confirmation uuid, request_key uuid, reason text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s collab_git.push_confirmations; prior collab_git.push_confirmation_actions;
BEGIN
 SELECT * INTO s FROM collab_git.push_confirmations WHERE id=confirmation;
 IF s.id IS NULL OR collab.project_role(s.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(s.organization_id::text,811)); PERFORM 1 FROM public."user" WHERE id=collab.actor() FOR SHARE;
 PERFORM 1 FROM collab.tasks WHERE id=s.task_id FOR SHARE;
 IF NOT collab_git.workspace_authority(s.task_id,collab.actor()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF request_key IS NULL OR reason IS NULL OR length(btrim(reason)) NOT BETWEEN 10 AND 2000 THEN RAISE EXCEPTION 'invalid_task_push_confirmation' USING ERRCODE='P0001'; END IF;
 SELECT * INTO prior FROM collab_git.push_confirmation_actions WHERE confirmation_id=confirmation AND actor_id=collab.actor() AND push_confirmation_actions.request_key=withdraw_task_push_confirmation.request_key;
 IF FOUND THEN
  IF prior.reason<>btrim(reason) THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
  RETURN collab_git.push_confirmation_result(confirmation)||jsonb_build_object('replayed',true);
 END IF;
 -- No receive capability exists in this increment. Future dispatch MUST replace
 -- this transition before introducing a possible remote effect; unknown sends
 -- can never use reservation withdrawal to release their destination.
 UPDATE collab_git.push_confirmations SET status='withdrawn',withdrawn_at=now() WHERE id=confirmation AND status='reserved';
 INSERT INTO collab_git.push_confirmation_actions VALUES(confirmation,collab.actor(),request_key,btrim(reason),now());
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(s.organization_id,s.project_id,collab.actor(),'task_push.confirmation_withdrawn',confirmation::text,jsonb_build_object('reason',btrim(reason)));
 RETURN collab_git.push_confirmation_result(confirmation)||jsonb_build_object('replayed',false);
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA collab_git FROM PUBLIC;
REVOKE ALL ON FUNCTION collab.task_push_confirmation_context(uuid),collab.lookup_task_push_confirmation(uuid,uuid,jsonb),collab.confirm_task_push(uuid,uuid,jsonb),collab.withdraw_task_push_confirmation(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.task_push_confirmation_context(uuid),collab.lookup_task_push_confirmation(uuid,uuid,jsonb),collab.confirm_task_push(uuid,uuid,jsonb),collab.withdraw_task_push_confirmation(uuid,uuid,text) TO pi_collab_app;
