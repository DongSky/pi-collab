-- Local team review binds to one immutable PR revision. Remote GitHub protection remains an additional gate.
CREATE TABLE collab_git.pull_reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sequence bigserial UNIQUE, revision_id uuid NOT NULL REFERENCES collab_git.pull_revision_jobs(id),
 actor_id text NOT NULL REFERENCES public."user"(id), organization_version bigint NOT NULL, project_version bigint NOT NULL,
 decision text NOT NULL CHECK(decision IN ('approve','changes_requested','comment')), body text NOT NULL CHECK(length(body) BETWEEN 10 AND 4000),
 request_key uuid NOT NULL, request jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(revision_id,actor_id,request_key)
);
CREATE TABLE collab_git.pull_releases (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), revision_id uuid NOT NULL REFERENCES collab_git.pull_revision_jobs(id), change_id uuid NOT NULL REFERENCES collab_git.pull_changes(id),
 organization_id uuid NOT NULL, project_id uuid NOT NULL, task_id uuid NOT NULL, actor_id text NOT NULL REFERENCES public."user"(id),
 organization_version bigint NOT NULL, project_version bigint NOT NULL, task_version integer NOT NULL,
 action text NOT NULL CHECK(action IN ('ready','merge')), admission jsonb NOT NULL, request_key uuid NOT NULL, request jsonb NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','ready','merged','rejected','not_sent','unknown','cancelled')),
 claim_id uuid, backend_pid integer, gate_at timestamptz, result jsonb, failure text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 UNIQUE(revision_id,actor_id,request_key), FOREIGN KEY(organization_id,project_id,task_id) REFERENCES collab.tasks(organization_id,project_id,id)
);
CREATE UNIQUE INDEX pull_release_occupied ON collab_git.pull_releases(change_id) WHERE status IN ('queued','running','unknown');
CREATE FUNCTION collab_git.pull_review_valid(review uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT coalesce((SELECT m.active AND pm.active AND m.authorization_version=v.organization_version AND pm.authorization_version=v.project_version
 AND pm.role IN ('maintainer','reviewer','developer') AND (m.role='member' OR u."twoFactorEnabled")
 AND v.actor_id<>t.owner_id AND v.actor_id<>d.actor_id
 FROM collab_git.pull_reviews v JOIN collab_git.pull_revision_jobs r ON r.id=v.revision_id JOIN collab.tasks t ON t.id=r.task_id
 JOIN collab_git.pull_deliveries d ON d.id=r.change_id
 JOIN collab.memberships m ON m.organization_id=r.organization_id AND m.user_id=v.actor_id
 JOIN collab.project_memberships pm ON pm.project_id=r.project_id AND pm.user_id=v.actor_id JOIN public."user" u ON u.id=v.actor_id WHERE v.id=review),false)
$$;
CREATE FUNCTION collab_git.pull_review_votes(revision uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',v.id,'actorId',v.actor_id,'actorName',u.name,'decision',v.decision,'body',v.body,'createdAt',v.created_at,'valid',collab_git.pull_review_valid(v.id)) ORDER BY v.sequence DESC),'[]')
 FROM (SELECT DISTINCT ON(actor_id) * FROM collab_git.pull_reviews WHERE revision_id=revision AND decision<>'comment' ORDER BY actor_id,sequence DESC) v
 JOIN public."user" u ON u.id=v.actor_id
$$;
CREATE FUNCTION collab_git.pull_release_source(revision uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT r.admission||jsonb_build_object('revisionId',r.id,'manifestHash',r.manifest_hash,'diffHash',r.manifest->>'diffHash','taskVersion',t.version,
 'votes',collab_git.pull_review_votes(r.id),'checksId',(SELECT j.id FROM collab_git.pull_checks_jobs j WHERE j.revision_id=r.id AND (collab_git.pull_checks_result(j.id)->>'eligible')::boolean LIMIT 1))
 FROM collab_git.pull_revision_jobs r JOIN collab.tasks t ON t.id=r.task_id WHERE r.id=revision AND r.status='ready'
 AND r.admission=collab_git.pull_revision_source(r.change_id) AND r.admission->'snapshot'->>'state'='open' AND r.admission->'snapshot'->>'merged'='false'
$$;
CREATE FUNCTION collab_git.pull_release_eligible(source jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(source IS NOT NULL AND source->>'checksId' IS NOT NULL
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(source->'votes') v WHERE v->>'valid'='true' AND v->>'decision'='approve')
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(source->'votes') v WHERE v->>'valid'='true' AND v->>'decision'='changes_requested'),false)
$$;
CREATE FUNCTION collab.review_pull_revision(revision uuid, key uuid, payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab_git.pull_revision_jobs; old collab_git.pull_reviews; t collab.tasks; ov bigint; pv bigint; review uuid:=gen_random_uuid();
BEGIN
 SELECT * INTO r FROM collab_git.pull_revision_jobs WHERE id=revision;
 IF r.id IS NULL OR collab.project_role(r.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(r.organization_id::text,811));
 SELECT * INTO t FROM collab.tasks WHERE id=r.task_id FOR SHARE;
 IF collab.project_role(r.project_id) IS NULL OR collab.project_role(r.project_id) NOT IN ('developer','reviewer','maintainer') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF collab.user_requires_mfa(collab.actor()) AND NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
 IF key IS NULL OR payload->>'decision' IS NULL OR payload->>'decision' NOT IN ('approve','changes_requested','comment')
 OR length(btrim(payload->>'body')) NOT BETWEEN 10 AND 4000 OR payload->>'body' IS NULL OR payload->>'diffHash' IS NULL
 THEN RAISE EXCEPTION 'invalid_pull_release' USING ERRCODE='P0001'; END IF;
 SELECT * INTO old FROM collab_git.pull_reviews WHERE revision_id=revision AND actor_id=collab.actor() AND request_key=key;
 IF FOUND THEN IF old.request<>payload THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF; RETURN jsonb_build_object('reviewId',old.id,'replayed',true); END IF;
 IF collab_git.pull_release_source(revision) IS NULL OR r.manifest->>'diffHash'<>payload->>'diffHash' THEN RAISE EXCEPTION 'stale_pull_release' USING ERRCODE='P0001'; END IF;
 IF payload->>'decision'<>'comment' AND (collab.actor()=t.owner_id OR collab.actor()=(SELECT actor_id FROM collab_git.pull_deliveries WHERE id=r.change_id)) THEN RAISE EXCEPTION 'independent_review_required' USING ERRCODE='P0001'; END IF;
 SELECT authorization_version INTO ov FROM collab.memberships WHERE organization_id=r.organization_id AND user_id=collab.actor();
 SELECT authorization_version INTO pv FROM collab.project_memberships WHERE project_id=r.project_id AND user_id=collab.actor();
 INSERT INTO collab_git.pull_reviews(id,revision_id,actor_id,organization_version,project_version,decision,body,request_key,request)
 VALUES(review,revision,collab.actor(),ov,pv,payload->>'decision',btrim(payload->>'body'),key,payload);
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(r.organization_id,r.project_id,collab.actor(),'pull.reviewed',review::text,jsonb_build_object('revisionId',revision,'decision',payload->>'decision'));
 RETURN jsonb_build_object('reviewId',review,'replayed',false);
END $$;
CREATE FUNCTION collab_git.pull_release_result(job uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('jobId',id,'revisionId',revision_id,'action',action,'status',status,'failure',failure,'result',result,'createdAt',created_at,'finishedAt',finished_at,
 'actorName',(SELECT name FROM public."user" WHERE id=j.actor_id),'headSha',admission->'snapshot'->>'headSha','baseSha',admission->'snapshot'->>'baseSha') FROM collab_git.pull_releases j WHERE id=job
$$;
CREATE FUNCTION collab.pull_release_context(revision uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab_git.pull_revision_jobs; t collab.tasks; source jsonb;
BEGIN
 SELECT * INTO r FROM collab_git.pull_revision_jobs WHERE id=revision;
 IF r.id IS NULL OR collab.project_role(r.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 SELECT * INTO STRICT t FROM collab.tasks WHERE id=r.task_id; source:=collab_git.pull_release_source(revision);
 RETURN jsonb_build_object('current',source IS NOT NULL,'taskVersion',t.version,'diffHash',r.manifest->>'diffHash','headSha',r.admission->'snapshot'->>'headSha','baseSha',r.admission->'snapshot'->>'baseSha',
 'draft',r.admission->'snapshot'->'draft','canReview',collab.project_role(r.project_id) IN ('maintainer','reviewer','developer'),
 'independent',collab.actor()<>t.owner_id AND collab.actor()<>(SELECT actor_id FROM collab_git.pull_deliveries WHERE id=r.change_id),
 'canRelease',collab.project_role(r.project_id)='maintainer' AND collab.actor_has_mfa(),
 'eligible',collab_git.pull_release_eligible(source),'votes',collab_git.pull_review_votes(revision),
 'reviews',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',v.id,'actorName',u.name,'decision',v.decision,'body',v.body,'createdAt',v.created_at) ORDER BY v.sequence DESC),'[]') FROM (SELECT * FROM collab_git.pull_reviews WHERE revision_id=revision ORDER BY sequence DESC LIMIT 50) v JOIN public."user" u ON u.id=v.actor_id),
 'jobs',(SELECT coalesce(jsonb_agg(collab_git.pull_release_result(id) ORDER BY created_at DESC),'[]') FROM (SELECT id,created_at FROM collab_git.pull_releases WHERE change_id=r.change_id ORDER BY created_at DESC LIMIT 20) j));
END $$;
CREATE FUNCTION collab.request_pull_release(revision uuid, key uuid, payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab_git.pull_revision_jobs; t collab.tasks; old collab_git.pull_releases; source jsonb; job uuid:=gen_random_uuid(); ov bigint; pv bigint;
BEGIN
 SELECT * INTO r FROM collab_git.pull_revision_jobs WHERE id=revision;
 IF r.id IS NULL OR collab.project_role(r.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(r.organization_id::text,811));
 SELECT * INTO STRICT t FROM collab.tasks WHERE id=r.task_id FOR SHARE;
 IF collab.project_role(r.project_id) IS NULL OR collab.project_role(r.project_id)<>'maintainer' OR NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF key IS NULL OR payload->>'action' IS NULL OR payload->>'action' NOT IN ('ready','merge') OR payload->'acknowledge' IS DISTINCT FROM 'true'::jsonb OR length(btrim(payload->>'reason')) NOT BETWEEN 10 AND 2000 OR payload->>'reason' IS NULL THEN RAISE EXCEPTION 'invalid_pull_release' USING ERRCODE='P0001'; END IF;
 SELECT * INTO old FROM collab_git.pull_releases WHERE revision_id=revision AND actor_id=collab.actor() AND request_key=key;
 IF FOUND THEN IF old.request<>payload THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF; RETURN collab_git.pull_release_result(old.id)||jsonb_build_object('replayed',true); END IF;
 source:=collab_git.pull_release_source(revision);
 IF source IS NULL OR t.version::text IS DISTINCT FROM payload->>'expectedTaskVersion' OR source->>'diffHash' IS DISTINCT FROM payload->>'diffHash' THEN RAISE EXCEPTION 'stale_pull_release' USING ERRCODE='P0001'; END IF;
 IF (payload->>'action'='ready')<>(source->'snapshot'->>'draft'='true') OR (payload->>'action'='merge' AND NOT collab_git.pull_release_eligible(source)) THEN RAISE EXCEPTION 'pull_release_not_ready' USING ERRCODE='P0001'; END IF;
 IF EXISTS(SELECT 1 FROM collab_git.pull_releases WHERE change_id=r.change_id AND status IN ('queued','running','unknown','merged')) THEN RAISE EXCEPTION 'pull_release_busy' USING ERRCODE='P0001'; END IF;
 SELECT authorization_version INTO ov FROM collab.memberships WHERE organization_id=r.organization_id AND user_id=collab.actor();
 SELECT authorization_version INTO pv FROM collab.project_memberships WHERE project_id=r.project_id AND user_id=collab.actor();
 INSERT INTO collab_git.pull_releases(id,revision_id,change_id,organization_id,project_id,task_id,actor_id,organization_version,project_version,task_version,action,admission,request_key,request)
 VALUES(job,revision,r.change_id,r.organization_id,r.project_id,r.task_id,collab.actor(),ov,pv,t.version,payload->>'action',source,key,payload);
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(r.organization_id,r.project_id,collab.actor(),'pull.release_requested',job::text,jsonb_build_object('revisionId',revision,'action',payload->>'action'));
 RETURN collab_git.pull_release_result(job)||jsonb_build_object('replayed',false);
END $$;
CREATE FUNCTION collab_git.pull_release_authorized(job uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT coalesce((SELECT j.admission=collab_git.pull_release_source(j.revision_id)
 AND m.active AND pm.active AND pm.role='maintainer' AND u."twoFactorEnabled" AND m.authorization_version=j.organization_version AND pm.authorization_version=j.project_version
 AND (j.action='ready' OR collab_git.pull_release_eligible(j.admission))
 FROM collab_git.pull_releases j JOIN collab.memberships m ON m.organization_id=j.organization_id AND m.user_id=j.actor_id
 JOIN collab.project_memberships pm ON pm.project_id=j.project_id AND pm.user_id=j.actor_id JOIN public."user" u ON u.id=j.actor_id WHERE j.id=job),false)
$$;
CREATE FUNCTION collab.cancel_pull_release(job uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j collab_git.pull_releases;
BEGIN
 SELECT * INTO j FROM collab_git.pull_releases WHERE id=job;
 IF j.id IS NULL OR collab.project_role(j.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(j.organization_id::text,811));
 IF collab.project_role(j.project_id) IS NULL OR collab.project_role(j.project_id)<>'maintainer' OR NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 SELECT * INTO STRICT j FROM collab_git.pull_releases WHERE id=job FOR UPDATE;
 IF j.status='cancelled' THEN RETURN collab_git.pull_release_result(job); END IF;
 IF j.status<>'queued' THEN RAISE EXCEPTION 'pull_release_busy' USING ERRCODE='P0001'; END IF;
 UPDATE collab_git.pull_releases SET status='cancelled',finished_at=now() WHERE id=job;
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id) VALUES(j.organization_id,j.project_id,collab.actor(),'pull.release_cancelled',job::text);
 RETURN collab_git.pull_release_result(job);
END $$;
CREATE FUNCTION collab_git.claim_pull_release() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j collab_git.pull_releases; nonce uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(98816423);
 FOR j IN SELECT * FROM collab_git.pull_releases WHERE status IN ('queued','running') ORDER BY created_at LIMIT 100 LOOP
  IF NOT pg_try_advisory_lock(hashtextextended(j.id::text,98816424)) THEN CONTINUE; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(j.organization_id::text,811));
  SELECT * INTO STRICT j FROM collab_git.pull_releases WHERE id=j.id FOR UPDATE;
  IF j.status='running' THEN
   UPDATE collab_git.pull_releases SET status=CASE WHEN gate_at IS NULL THEN 'not_sent' ELSE 'unknown' END,failure='pull_release_owner_lost',finished_at=now() WHERE id=j.id;
   PERFORM pg_advisory_unlock(hashtextextended(j.id::text,98816424)); RETURN collab_git.pull_release_result(j.id)||jsonb_build_object('recovered',true);
  END IF;
  IF j.status<>'queued' THEN PERFORM pg_advisory_unlock(hashtextextended(j.id::text,98816424)); CONTINUE; END IF;
  nonce:=gen_random_uuid();UPDATE collab_git.pull_releases SET status='running',claim_id=nonce,backend_pid=pg_backend_pid() WHERE id=j.id;
  RETURN jsonb_build_object('jobId',j.id,'claimId',nonce,'action',j.action,'admission',j.admission);
 END LOOP; RETURN NULL;
END $$;
CREATE FUNCTION collab_git.lock_pull_release(job uuid, nonce uuid) RETURNS collab_git.pull_releases LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j collab_git.pull_releases;
BEGIN
 SELECT * INTO j FROM collab_git.pull_releases WHERE id=job;
 IF j.id IS NULL THEN RAISE EXCEPTION 'pull_release_claim_lost' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(j.organization_id::text,811));
 SELECT * INTO STRICT j FROM collab_git.pull_releases WHERE id=job FOR UPDATE;
 IF j.status<>'running' OR j.claim_id IS DISTINCT FROM nonce OR j.backend_pid IS DISTINCT FROM pg_backend_pid() THEN RAISE EXCEPTION 'pull_release_claim_lost' USING ERRCODE='P0001'; END IF;
 RETURN j;
END $$;
CREATE FUNCTION collab_git.begin_pull_release(job uuid, nonce uuid, gate boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j collab_git.pull_releases;
BEGIN
 j:=collab_git.lock_pull_release(job,nonce);
 PERFORM 1 FROM public."user" WHERE id=j.actor_id FOR SHARE;
 PERFORM 1 FROM collab.tasks WHERE id=j.task_id FOR SHARE;
 PERFORM 1 FROM collab.github_bindings WHERE repository_id=(j.admission->>'repositoryId')::uuid FOR SHARE;
 PERFORM 1 FROM collab.github_installations WHERE id=(j.admission->>'connectionId')::uuid FOR SHARE;
 IF collab_git.pull_release_authorized(job) IS DISTINCT FROM true THEN RAISE EXCEPTION 'stale_pull_release' USING ERRCODE='P0001'; END IF;
 IF gate THEN
  IF j.gate_at IS NOT NULL THEN RAISE EXCEPTION 'pull_release_claim_lost' USING ERRCODE='P0001'; END IF;
  UPDATE collab_git.pull_releases SET gate_at=clock_timestamp() WHERE id=job;
 END IF;
 RETURN (SELECT jsonb_build_object('appId',c.app_id,'installationId',c.installation_id,'accountId',c.account_id,'sealed',s.sealed)
 FROM collab.github_installations c JOIN collab_git.credentials s ON s.connection_id=c.id WHERE c.id=(j.admission->>'connectionId')::uuid);
END $$;
CREATE FUNCTION collab_git.finish_pull_release(job uuid, nonce uuid, receipt jsonb, failure text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j collab_git.pull_releases; outcome text;
BEGIN
 j:=collab_git.lock_pull_release(job,nonce);
 outcome:=coalesce(receipt->>'status',CASE WHEN j.gate_at IS NULL THEN 'not_sent' ELSE 'unknown' END);
 IF outcome NOT IN ('ready','merged','rejected','not_sent','unknown') OR (outcome IN ('ready','merged') AND j.gate_at IS NULL)
 OR (outcome='merged' AND (j.action<>'merge' OR coalesce(receipt->>'sha','')!~'^[a-f0-9]{40}$')) OR (outcome='ready' AND j.action<>'ready') THEN RAISE EXCEPTION 'invalid_pull_release' USING ERRCODE='P0001'; END IF;
 UPDATE collab_git.pull_releases SET status=outcome,result=receipt,failure=left(finish_pull_release.failure,120),finished_at=now(),updated_at=now() WHERE id=job;
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(j.organization_id,j.project_id,j.actor_id,'pull.release_'||outcome,job::text,jsonb_build_object('revisionId',j.revision_id,'result',receipt));
 PERFORM collab.notify_task(j.task_id,j.actor_id,'pull.'||outcome,'release:'||job::text);
 RETURN collab_git.pull_release_result(job);
END $$;
REVOKE ALL ON FUNCTION collab_git.pull_review_valid(uuid),collab_git.pull_review_votes(uuid),collab_git.pull_release_source(uuid),collab_git.pull_release_eligible(jsonb),collab_git.pull_release_result(uuid),collab_git.pull_release_authorized(uuid),collab_git.claim_pull_release(),collab_git.lock_pull_release(uuid,uuid),collab_git.begin_pull_release(uuid,uuid,boolean),collab_git.finish_pull_release(uuid,uuid,jsonb,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION collab.review_pull_revision(uuid,uuid,jsonb),collab.pull_release_context(uuid),collab.request_pull_release(uuid,uuid,jsonb),collab.cancel_pull_release(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.review_pull_revision(uuid,uuid,jsonb),collab.pull_release_context(uuid),collab.request_pull_release(uuid,uuid,jsonb),collab.cancel_pull_release(uuid) TO pi_collab_app;
GRANT EXECUTE ON FUNCTION collab_git.claim_pull_release(),collab_git.begin_pull_release(uuid,uuid,boolean),collab_git.finish_pull_release(uuid,uuid,jsonb,text) TO pi_collab_git;
