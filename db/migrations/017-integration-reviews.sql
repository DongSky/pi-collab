-- Required checks and reviews are immutable, version-bound evidence. This does
-- not authorize or perform a Git ref update.
CREATE TABLE collab.integration_policies (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, project_id uuid NOT NULL, repository_id uuid NOT NULL,
 target_branch text NOT NULL, version integer NOT NULL CHECK(version>0), profile_id uuid NOT NULL,
 required_approvals integer NOT NULL CHECK(required_approvals BETWEEN 1 AND 3), reviewer_approvals boolean NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 10 AND 2000), created_by text NOT NULL REFERENCES public."user"(id),
 idempotency_key uuid NOT NULL, request jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(repository_id,target_branch,version), UNIQUE(repository_id,created_by,idempotency_key),
 UNIQUE(organization_id,project_id,id),
 FOREIGN KEY(organization_id,project_id,repository_id) REFERENCES collab.repositories(organization_id,project_id,id),
 FOREIGN KEY(organization_id,project_id,profile_id) REFERENCES collab.validation_profiles(organization_id,project_id,id)
);
ALTER TABLE collab.integration_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY integration_policies_read ON collab.integration_policies FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
GRANT SELECT ON collab.integration_policies TO pi_collab_app;
ALTER TABLE collab.integrations ADD COLUMN policy_id uuid;
ALTER TABLE collab.integrations ADD CONSTRAINT integration_policy_scope FOREIGN KEY(organization_id,project_id,policy_id) REFERENCES collab.integration_policies(organization_id,project_id,id);

CREATE FUNCTION collab_worker.current_integration_policy(repository uuid, branch text) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT id FROM collab.integration_policies WHERE repository_id=repository AND target_branch=branch ORDER BY version DESC LIMIT 1
$$;
CREATE FUNCTION collab.publish_integration_policy(repository uuid, profile uuid, approvals integer, count_reviewers boolean, expected_version integer, reason text, request_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE repo collab.repositories; prior collab.integration_policies; current_version integer; payload jsonb; policy uuid:=gen_random_uuid();
BEGIN
 SELECT * INTO repo FROM collab.repositories WHERE id=repository;
 IF repo.id IS NULL OR collab.project_role(repo.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(repo.organization_id::text,811)); SELECT * INTO STRICT repo FROM collab.repositories WHERE id=repository;
 IF collab.project_role(repo.project_id) IS DISTINCT FROM 'maintainer' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF collab.user_requires_mfa(collab.actor()) AND NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
 IF profile IS NULL OR approvals IS NULL OR approvals NOT BETWEEN 1 AND 3 OR count_reviewers IS NULL OR expected_version IS NULL OR expected_version<0 OR request_key IS NULL OR reason IS NULL OR length(btrim(reason)) NOT BETWEEN 10 AND 2000 THEN RAISE EXCEPTION 'invalid_integration_policy' USING ERRCODE='P0001'; END IF;
 payload:=jsonb_build_object('profileId',profile,'requiredApprovals',approvals,'reviewerApprovals',count_reviewers,'expectedVersion',expected_version,'reason',btrim(reason));
 SELECT * INTO prior FROM collab.integration_policies WHERE repository_id=repository AND created_by=collab.actor() AND idempotency_key=request_key;
 IF FOUND THEN
  IF prior.request<>payload THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
  RETURN jsonb_build_object('policyId',prior.id,'version',prior.version,'replayed',true);
 END IF;
 SELECT COALESCE(max(version),0) INTO current_version FROM collab.integration_policies WHERE repository_id=repository AND target_branch=repo.default_branch;
 IF current_version<>expected_version THEN RAISE EXCEPTION 'stale_integration_policy' USING ERRCODE='P0001'; END IF;
 IF NOT EXISTS(SELECT 1 FROM collab.validation_profiles WHERE id=profile AND repository_id=repository AND project_id=repo.project_id) THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 INSERT INTO collab.integration_policies(id,organization_id,project_id,repository_id,target_branch,version,profile_id,required_approvals,reviewer_approvals,reason,created_by,idempotency_key,request)
 VALUES(policy,repo.organization_id,repo.project_id,repository,repo.default_branch,current_version+1,profile,approvals,count_reviewers,btrim(reason),collab.actor(),request_key,payload);
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(repo.organization_id,repo.project_id,collab.actor(),'integration_policy.published',policy::text,payload||jsonb_build_object('version',current_version+1,'targetBranch',repo.default_branch));
 RETURN jsonb_build_object('policyId',policy,'version',current_version+1,'replayed',false);
END $$;

-- A trigger pins policy before the old worker protocol computes/checks evidence.
-- One required immutable profile contains all mandatory steps; even a v16 worker
-- must execute every step because finish_integration already validates them.
CREATE FUNCTION collab_worker.pin_integration_policy() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 NEW.policy_id:=collab_worker.current_integration_policy(NEW.repository_id,NEW.target_branch);
 IF NEW.policy_id IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM collab.integration_policies WHERE id=NEW.policy_id AND profile_id=NEW.profile_id) THEN RAISE EXCEPTION 'required_integration_profile' USING ERRCODE='P0001'; END IF;
  NEW.input_hash:=encode(sha256(convert_to(jsonb_build_object('inputHash',NEW.input_hash,'policyId',NEW.policy_id)::text,'UTF8')),'hex');
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pin_integration_policy BEFORE INSERT ON collab.integrations FOR EACH ROW EXECUTE FUNCTION collab_worker.pin_integration_policy();
ALTER FUNCTION collab.request_integration(uuid,text,uuid[],uuid,uuid) RENAME TO request_integration_v16;
ALTER FUNCTION collab.request_integration_v16(uuid,text,uuid[],uuid,uuid) SET SCHEMA collab_worker;
REVOKE ALL ON FUNCTION collab_worker.request_integration_v16(uuid,text,uuid[],uuid,uuid) FROM PUBLIC,pi_collab_app,pi_collab_executor;
CREATE FUNCTION collab.request_integration(repository uuid, target text, results uuid[], profile uuid, request_key uuid, expected_policy uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE repo collab.repositories; prior collab.integrations;
BEGIN
 SELECT * INTO repo FROM collab.repositories WHERE id=repository;
 IF repo.id IS NULL OR collab.project_role(repo.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(repo.organization_id::text,811)); SELECT * INTO STRICT repo FROM collab.repositories WHERE id=repository;
 SELECT * INTO prior FROM collab.integrations WHERE repository_id=repository AND requested_by=collab.actor() AND idempotency_key=request_key;
 IF FOUND THEN
  IF prior.policy_id IS DISTINCT FROM expected_policy THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
 ELSIF collab_worker.current_integration_policy(repository,repo.default_branch) IS DISTINCT FROM expected_policy THEN RAISE EXCEPTION 'stale_integration_policy' USING ERRCODE='P0001';
 END IF;
 RETURN collab_worker.request_integration_v16(repository,target,results,profile,request_key);
END $$;
ALTER FUNCTION collab_worker.integration_current(uuid) RENAME TO integration_sources_current_v16;
CREATE FUNCTION collab_worker.integration_current(candidate uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT collab_worker.integration_sources_current_v16(candidate) AND EXISTS(SELECT 1 FROM collab.integrations i WHERE id=candidate AND policy_id IS NOT DISTINCT FROM collab_worker.current_integration_policy(repository_id,target_branch))
$$;

CREATE TABLE collab.integration_reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, project_id uuid NOT NULL, integration_id uuid NOT NULL,
 reviewer_id text NOT NULL REFERENCES public."user"(id), version integer NOT NULL CHECK(version>0),
 decision text NOT NULL CHECK(decision IN ('approve','request_changes','withdraw')), note text NOT NULL CHECK(length(note) BETWEEN 10 AND 4000),
 revision_hash text NOT NULL CHECK(revision_hash ~ '^[a-f0-9]{64}$'), organization_version bigint NOT NULL, project_version bigint NOT NULL,
 idempotency_key uuid NOT NULL, request jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(integration_id,reviewer_id,version), UNIQUE(integration_id,reviewer_id,idempotency_key),
 FOREIGN KEY(organization_id,project_id,integration_id) REFERENCES collab.integrations(organization_id,project_id,id)
);
ALTER TABLE collab.integration_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY integration_reviews_read ON collab.integration_reviews FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
GRANT SELECT ON collab.integration_reviews TO pi_collab_app;
CREATE FUNCTION collab_worker.integration_revision_hash(candidate uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object('inputHash',input_hash,'policyId',policy_id,'targetSha',target_sha,'candidateCommit',evidence->>'candidateCommit','manifestHash',evidence->'snapshot'->>'manifestHash','worktreeCommit',evidence->'snapshot'->>'worktreeCommit')::text,'UTF8')),'hex')
 FROM collab.integrations WHERE id=candidate AND status='checked' AND policy_id IS NOT NULL
$$;
CREATE FUNCTION collab_worker.integration_contributor(candidate uuid, person text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM collab.integrations WHERE id=candidate AND requested_by=person)
 OR EXISTS(SELECT 1 FROM collab.integration_sources s JOIN collab.task_results r ON r.id=s.result_id JOIN collab.runs run ON run.id=r.source_run_id WHERE s.integration_id=candidate AND (r.published_by=person OR run.requested_by=person))
$$;
CREATE FUNCTION collab_worker.integration_review_authorized(review uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM collab.integration_reviews r JOIN collab.memberships m ON m.organization_id=r.organization_id AND m.user_id=r.reviewer_id
 JOIN collab.project_memberships pm ON pm.project_id=r.project_id AND pm.user_id=r.reviewer_id JOIN public."user" u ON u.id=r.reviewer_id
 WHERE r.id=review AND m.active AND pm.active AND pm.role IN ('maintainer','developer','reviewer') AND m.authorization_version=r.organization_version AND pm.authorization_version=r.project_version AND (m.role='member' OR u."twoFactorEnabled"))
$$;
CREATE FUNCTION collab.submit_integration_review(candidate uuid, revision text, expected_version integer, decision text, note text, request_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i collab.integrations; prior collab.integration_reviews; ordinal integer; role text; payload jsonb; review uuid:=gen_random_uuid();
BEGIN
 SELECT * INTO i FROM collab.integrations WHERE id=candidate;
 IF i.id IS NULL OR collab.project_role(i.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(i.organization_id::text,811)); SELECT * INTO STRICT i FROM collab.integrations WHERE id=candidate;
 role:=collab.project_role(i.project_id);
 IF role IS NULL OR role NOT IN ('maintainer','developer','reviewer') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF collab.user_requires_mfa(collab.actor()) AND NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
 IF revision IS NULL OR revision!~'^[a-f0-9]{64}$' OR expected_version IS NULL OR expected_version<0 OR decision IS NULL OR decision NOT IN ('approve','request_changes','withdraw') OR note IS NULL OR length(btrim(note)) NOT BETWEEN 10 AND 4000 OR request_key IS NULL THEN RAISE EXCEPTION 'invalid_integration_review' USING ERRCODE='P0001'; END IF;
 payload:=jsonb_build_object('revisionHash',revision,'expectedVersion',expected_version,'decision',decision,'note',btrim(note));
 SELECT * INTO prior FROM collab.integration_reviews WHERE integration_id=candidate AND reviewer_id=collab.actor() AND idempotency_key=request_key;
 IF FOUND THEN
  IF prior.request<>payload THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
  RETURN jsonb_build_object('reviewId',prior.id,'version',prior.version,'replayed',true);
 END IF;
 IF i.status<>'checked' OR i.policy_id IS NULL OR NOT collab_worker.integration_current(candidate) OR NOT collab_worker.integration_authorized(candidate) OR revision IS DISTINCT FROM collab_worker.integration_revision_hash(candidate) THEN RAISE EXCEPTION 'integration_not_reviewable' USING ERRCODE='P0001'; END IF;
 IF decision='approve' AND collab_worker.integration_contributor(candidate,collab.actor()) THEN RAISE EXCEPTION 'integration_self_approval' USING ERRCODE='P0001'; END IF;
 SELECT COALESCE(max(version),0) INTO ordinal FROM collab.integration_reviews WHERE integration_id=candidate AND reviewer_id=collab.actor();
 IF ordinal<>expected_version THEN RAISE EXCEPTION 'stale_integration_review' USING ERRCODE='P0001'; END IF;
 INSERT INTO collab.integration_reviews(id,organization_id,project_id,integration_id,reviewer_id,version,decision,note,revision_hash,organization_version,project_version,idempotency_key,request)
 VALUES(review,i.organization_id,i.project_id,candidate,collab.actor(),ordinal+1,decision,btrim(note),revision,
 (SELECT authorization_version FROM collab.memberships WHERE organization_id=i.organization_id AND user_id=collab.actor()),
 (SELECT authorization_version FROM collab.project_memberships WHERE project_id=i.project_id AND user_id=collab.actor()),request_key,payload);
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(i.organization_id,i.project_id,collab.actor(),'integration.reviewed',candidate::text,jsonb_build_object('reviewId',review,'revisionHash',revision,'version',ordinal+1,'decision',decision));
 RETURN jsonb_build_object('reviewId',review,'version',ordinal+1,'replayed',false);
END $$;

CREATE FUNCTION collab.integration_review_state(candidate uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i collab.integrations; p collab.integration_policies; approvals integer; blockers integer; own_version integer; current_inputs boolean; reviews jsonb;
BEGIN
 SELECT * INTO i FROM collab.integrations WHERE id=candidate;
 IF i.id IS NULL OR collab.project_role(i.project_id) IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO p FROM collab.integration_policies WHERE id=i.policy_id;
 current_inputs:=collab_worker.integration_current(candidate) AND collab_worker.integration_authorized(candidate);
 WITH latest AS (SELECT DISTINCT ON (reviewer_id) r.* FROM collab.integration_reviews r WHERE integration_id=candidate ORDER BY reviewer_id,version DESC),
 eligible AS (SELECT r.*,u.name AS reviewer_name,collab_worker.integration_review_authorized(r.id) AS authorized,
  COALESCE(r.decision='approve' AND collab_worker.integration_review_authorized(r.id) AND NOT collab_worker.integration_contributor(candidate,r.reviewer_id)
  AND r.revision_hash=collab_worker.integration_revision_hash(candidate) AND (p.reviewer_approvals OR pm.role IN ('maintainer','developer')),false) AS counts
  FROM latest r LEFT JOIN collab.project_memberships pm ON pm.project_id=r.project_id AND pm.user_id=r.reviewer_id JOIN public."user" u ON u.id=r.reviewer_id)
 SELECT count(*) FILTER(WHERE counts),count(*) FILTER(WHERE decision='request_changes'),COALESCE(max(version) FILTER(WHERE reviewer_id=collab.actor()),0),
 COALESCE(jsonb_agg(jsonb_build_object('id',id,'reviewerId',reviewer_id,'reviewerName',reviewer_name,'version',version,'decision',decision,'note',note,'authorized',authorized,'counts',counts AND current_inputs,'createdAt',created_at) ORDER BY created_at,id),'[]'::jsonb)
 INTO approvals,blockers,own_version,reviews FROM eligible;
 RETURN jsonb_build_object('policyId',i.policy_id,'policyVersion',p.version,'requiredApprovals',p.required_approvals,'reviewerApprovals',p.reviewer_approvals,
 'policyCurrent',i.policy_id IS NOT DISTINCT FROM collab_worker.current_integration_policy(i.repository_id,i.target_branch),
 'revisionHash',collab_worker.integration_revision_hash(candidate),'current',current_inputs,'approvals',CASE WHEN current_inputs THEN approvals ELSE 0 END,'blockers',blockers,
 'reviewSatisfied',COALESCE(i.status='checked' AND current_inputs AND p.id IS NOT NULL AND approvals>=p.required_approvals AND blockers=0,false),
 'canReview',i.status='checked' AND current_inputs AND p.id IS NOT NULL AND collab.project_role(i.project_id) IN ('maintainer','developer','reviewer'),
 'contributor',collab_worker.integration_contributor(candidate,collab.actor()),'ownVersion',own_version,'reviews',reviews);
END $$;
REVOKE ALL ON FUNCTION collab_worker.current_integration_policy(uuid,text),collab.publish_integration_policy(uuid,uuid,integer,boolean,integer,text,uuid),collab_worker.pin_integration_policy(),collab.request_integration(uuid,text,uuid[],uuid,uuid,uuid),collab_worker.integration_current(uuid),collab_worker.integration_revision_hash(uuid),collab_worker.integration_contributor(uuid,text),collab_worker.integration_review_authorized(uuid),collab.submit_integration_review(uuid,text,integer,text,text,uuid),collab.integration_review_state(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.publish_integration_policy(uuid,uuid,integer,boolean,integer,text,uuid),collab.request_integration(uuid,text,uuid[],uuid,uuid,uuid),collab.submit_integration_review(uuid,text,integer,text,text,uuid),collab.integration_review_state(uuid) TO pi_collab_app;
