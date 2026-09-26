CREATE TABLE collab_meta.operations (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), draining boolean NOT NULL DEFAULT false,
 reason text NOT NULL DEFAULT '', updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO collab_meta.operations(singleton) VALUES(true);
CREATE FUNCTION collab.operation_status() RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('draining',draining,'updatedAt',updated_at) FROM collab_meta.operations WHERE singleton
$$;
REVOKE EXECUTE ON FUNCTION collab.operation_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.operation_status() TO pi_collab_app;
CREATE FUNCTION collab_meta.guard_admission() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE stopped boolean;
BEGIN
 SELECT draining INTO stopped FROM collab_meta.operations WHERE singleton FOR SHARE;
 IF stopped THEN RAISE EXCEPTION 'installation_draining' USING ERRCODE='P0001'; END IF;
 RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION collab_meta.guard_admission() FROM PUBLIC;
-- Locking the singleton makes drain wait for admissions already in flight. Existing jobs can finish.
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['collab.runs','collab.snapshots','collab.validations','collab.integrations','collab.promotions',
 'collab.github_imports','collab.github_syncs','collab_git.workspace_operations','collab_git.push_previews',
 'collab_git.push_deliveries','collab_git.pull_proposals','collab_git.pull_deliveries','collab_git.pull_observation_jobs',
 'collab_git.pull_revision_jobs','collab_git.pull_checks_jobs','collab_git.pull_releases'] LOOP
   IF to_regclass(relation) IS NULL THEN RAISE EXCEPTION 'Unknown drain admission table: %',relation; END IF;
   EXECUTE format('CREATE TRIGGER operations_admission BEFORE INSERT ON %s FOR EACH ROW EXECUTE FUNCTION collab_meta.guard_admission()',relation);
 END LOOP;
END $$;
