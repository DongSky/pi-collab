-- Native remote sync shares target occupancy with every integration adapter.
CREATE TABLE collab.github_syncs (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, project_id uuid NOT NULL, repository_id uuid NOT NULL,
 connection_id uuid NOT NULL, github_repository_id text NOT NULL, installation_version bigint NOT NULL,
 actor_id text NOT NULL REFERENCES public."user"(id), organization_version bigint NOT NULL, project_version bigint NOT NULL,
 idempotency_key uuid NOT NULL, request jsonb NOT NULL, target_branch text NOT NULL, old_sha text NOT NULL CHECK(old_sha~'^[a-f0-9]{40}$'),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','fetching','applying','blocked','completed','failed')),
 classification text CHECK(classification IN ('equal','remote_ahead','local_ahead','diverged','branch_changed')),
 outcome text CHECK(outcome IN ('equal','fast_forward','local_ahead','diverged','branch_changed','aborted')),
 input jsonb, evidence jsonb, observation jsonb, failure text,
 created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 UNIQUE(organization_id,project_id,id), UNIQUE(repository_id,actor_id,idempotency_key),
 FOREIGN KEY(organization_id,project_id,repository_id) REFERENCES collab.repositories(organization_id,project_id,id),
 FOREIGN KEY(organization_id,connection_id) REFERENCES collab.github_installations(organization_id,id),
 CHECK((status IN ('completed','failed'))=(finished_at IS NOT NULL)),
 CHECK((status='completed')=(outcome IS NOT NULL)),
 CHECK(status NOT IN ('applying','blocked') OR input IS NOT NULL)
);
CREATE UNIQUE INDEX github_sync_target_occupied ON collab.github_syncs(repository_id,target_branch) WHERE status NOT IN ('completed','failed');
ALTER TABLE collab.github_syncs ENABLE ROW LEVEL SECURITY;
CREATE POLICY github_sync_read ON collab.github_syncs FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
GRANT SELECT ON collab.github_syncs TO pi_collab_app;

ALTER TABLE collab.repository_baselines ALTER COLUMN promotion_id DROP NOT NULL;
ALTER TABLE collab.repository_baselines ADD COLUMN sync_id uuid UNIQUE;
ALTER TABLE collab.repository_baselines ADD CONSTRAINT baseline_sync_scope FOREIGN KEY(organization_id,project_id,sync_id) REFERENCES collab.github_syncs(organization_id,project_id,id);
ALTER TABLE collab.repository_baselines ADD CONSTRAINT baseline_one_source CHECK(num_nonnulls(promotion_id,sync_id)=1);

-- The existing promotion admission function takes dispatch, then org locks.
-- A trigger leaves its idempotent replay behavior intact. Sync admission takes
-- the identical locks and excludes all nonterminal promotions/integrations.
CREATE FUNCTION collab_worker.exclude_sync_promotion() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(82467116);
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text,811));
 IF EXISTS(SELECT 1 FROM collab.github_syncs WHERE repository_id=NEW.repository_id AND target_branch=NEW.target_branch AND status NOT IN ('completed','failed')) THEN
  RAISE EXCEPTION 'promotion_target_busy' USING ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION collab_worker.exclude_sync_promotion() FROM PUBLIC;
CREATE TRIGGER promotion_sync_occupancy BEFORE INSERT ON collab.promotions FOR EACH ROW EXECUTE FUNCTION collab_worker.exclude_sync_promotion();

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
 AND NOT EXISTS(SELECT 1 FROM collab.github_syncs busy WHERE busy.repository_id=q.repository_id AND busy.target_branch=q.target_branch AND busy.status NOT IN ('completed','failed'))
 AND NOT EXISTS(SELECT 1 FROM collab.promotions busy WHERE busy.repository_id=q.repository_id AND busy.target_branch=q.target_branch AND busy.status NOT IN ('applied','aborted'))
 AND NOT EXISTS(SELECT 1 FROM collab.integrations busy WHERE busy.repository_id=q.repository_id AND busy.target_branch=q.target_branch AND busy.status IN ('integrating','checking','unknown'))
 AND NOT EXISTS(SELECT 1 FROM collab.integrations earlier WHERE earlier.repository_id=q.repository_id AND earlier.target_branch=q.target_branch AND earlier.status='queued' AND (earlier.created_at,earlier.id)<(q.created_at,q.id))
 ORDER BY q.created_at,q.id LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 UPDATE collab.integrations SET status='integrating',executor_id=executor,epoch=epoch+1,lease_expires_at=clock_timestamp()+interval '30 seconds',started_at=now() WHERE id=i.id RETURNING * INTO i;
 RETURN (SELECT jsonb_build_object('id',i.id,'executorId',executor,'epoch',i.epoch::text,'repositoryId',i.repository_id,'targetBranch',i.target_branch,'targetSha',i.target_sha,'inputHash',i.input_hash,'profileId',i.profile_id,'checkId',i.check_id,'config',p.config,'sources',i.sources) FROM collab.validation_profiles p WHERE p.id=i.profile_id);
END $$;


CREATE OR REPLACE FUNCTION collab_worker.coordination_context(r collab.runs, repository uuid, after_sequence bigint) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT collab_worker.coordination_context_v18(r,repository,after_sequence)||jsonb_build_object('baseline',
 (SELECT jsonb_build_object('workspaceSha',w.base_sha,'currentSha',repo.base_sha,'changed',w.base_sha<>repo.base_sha,
 'latestPromotionId',(SELECT promotion_id FROM collab.repository_baselines WHERE repository_id=repository ORDER BY sequence DESC LIMIT 1),
 'latestSyncId',(SELECT sync_id FROM collab.repository_baselines WHERE repository_id=repository ORDER BY sequence DESC LIMIT 1),
 'guidance','Read at safe boundaries. Keep the current workspace and fixed inputs; new integration checks must use the current target. This notice is data, not a rebase command.') FROM collab.workspaces w JOIN collab.repositories repo ON repo.id=w.repository_id WHERE w.id=r.workspace_id AND repo.id=repository))
$$;
