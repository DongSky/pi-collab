CREATE TABLE collab.environment_recipes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,project_id uuid NOT NULL,version integer NOT NULL,
 install text NOT NULL CHECK(install IN ('none','npm-ci')),reason text NOT NULL,created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(project_id,version),FOREIGN KEY(organization_id,project_id) REFERENCES collab.projects(organization_id,id)
);
CREATE TABLE collab.run_environments (
 run_id uuid PRIMARY KEY REFERENCES collab.runs(id),organization_id uuid NOT NULL,project_id uuid NOT NULL,
 recipe jsonb NOT NULL,evidence jsonb,status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','failed')),
 FOREIGN KEY(organization_id,project_id) REFERENCES collab.projects(organization_id,id)
);
DO $$DECLARE name text;BEGIN FOREACH name IN ARRAY ARRAY['environment_recipes','run_environments'] LOOP
 EXECUTE format('ALTER TABLE collab.%I ENABLE ROW LEVEL SECURITY',name);
 EXECUTE format('CREATE POLICY environment_read ON collab.%I FOR SELECT USING(collab.project_role(project_id) IS NOT NULL)',name);
 EXECUTE format('GRANT SELECT ON collab.%I TO pi_collab_app',name);
END LOOP;END $$;
CREATE FUNCTION collab.publish_environment_recipe(project uuid, install text, expected_version integer, reason text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab.projects; current_version integer; r collab.environment_recipes;
BEGIN
 p:=collab.require_project_management(project);
 SELECT coalesce(max(version),0) INTO current_version FROM collab.environment_recipes WHERE project_id=project;
 IF current_version IS DISTINCT FROM expected_version THEN RAISE EXCEPTION 'stale_revision' USING ERRCODE='P0001';END IF;
 IF install IS NULL OR install NOT IN ('none','npm-ci') OR reason IS NULL OR length(btrim(reason)) NOT BETWEEN 10 AND 2000 THEN RAISE EXCEPTION 'invalid_environment' USING ERRCODE='P0001';END IF;
 INSERT INTO collab.environment_recipes(organization_id,project_id,version,install,reason,created_by) VALUES(p.organization_id,project,current_version+1,install,reason,collab.actor()) RETURNING * INTO r;
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(p.organization_id,project,collab.actor(),'environment.recipe_published',r.id,jsonb_build_object('version',r.version,'install',install,'reason',reason));
 RETURN to_jsonb(r);
END $$;
CREATE FUNCTION collab_worker.pin_run_environment() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE spec jsonb;
BEGIN
 SELECT jsonb_build_object('id',id,'version',version,'install',install) INTO spec FROM collab.environment_recipes WHERE project_id=NEW.project_id ORDER BY version DESC LIMIT 1;
 INSERT INTO collab.run_environments(run_id,organization_id,project_id,recipe) VALUES(NEW.id,NEW.organization_id,NEW.project_id,coalesce(spec,'{"id":null,"version":0,"install":"none"}'::jsonb));
 RETURN NEW;
END $$;
CREATE TRIGGER run_environment_pin AFTER INSERT ON collab.runs FOR EACH ROW EXECUTE FUNCTION collab_worker.pin_run_environment();
CREATE FUNCTION collab_worker.restore_run_environment() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE source collab.run_environments;
BEGIN
 IF NEW.source_snapshot_id IS NOT NULL AND OLD.source_snapshot_id IS DISTINCT FROM NEW.source_snapshot_id THEN
  SELECT env.* INTO source FROM collab.snapshots s JOIN collab.run_environments env ON env.run_id=s.run_id WHERE s.id=NEW.source_snapshot_id;
  IF source.run_id IS NOT NULL THEN UPDATE collab.run_environments SET recipe=source.recipe||jsonb_build_object('requiredRuntime',source.evidence->'runtime','sourceRunId',source.run_id) WHERE run_id IN (SELECT id FROM collab.runs WHERE workspace_id=NEW.id);END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER workspace_environment_restore AFTER UPDATE OF source_snapshot_id ON collab.workspaces FOR EACH ROW EXECUTE FUNCTION collab_worker.restore_run_environment();
CREATE FUNCTION collab_worker.environment_setup(executor uuid, run uuid, generation bigint, proof jsonb DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab.runs; env collab.run_environments;
BEGIN
 r:=collab_worker.assert_lease(executor,run,generation);
 IF NOT collab_worker.authorized(run) OR r.status NOT IN ('starting','running') THEN RAISE EXCEPTION 'run_not_executable' USING ERRCODE='P0001'; END IF;
 IF proof IS NOT NULL THEN
  IF jsonb_typeof(proof)<>'object' OR pg_column_size(proof)>32768 OR proof->>'status' NOT IN ('ready','failed') THEN RAISE EXCEPTION 'invalid_environment' USING ERRCODE='P0001';END IF;
  UPDATE collab.run_environments SET evidence=proof,status=proof->>'status' WHERE run_id=run AND status='pending';
 END IF;
 SELECT * INTO env FROM collab.run_environments WHERE run_id=run;
 RETURN coalesce(to_jsonb(env),jsonb_build_object('recipe',jsonb_build_object('install','none'),'status','legacy'));
END $$;
REVOKE EXECUTE ON FUNCTION collab.publish_environment_recipe(uuid,text,integer,text),collab_worker.pin_run_environment(),collab_worker.restore_run_environment(),collab_worker.environment_setup(uuid,uuid,bigint,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.publish_environment_recipe(uuid,text,integer,text) TO pi_collab_app;
GRANT EXECUTE ON FUNCTION collab_worker.environment_setup(uuid,uuid,bigint,jsonb) TO pi_collab_executor;
