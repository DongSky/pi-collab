CREATE TABLE collab.revert_tasks (
 task_id uuid PRIMARY KEY REFERENCES collab.tasks(id), organization_id uuid NOT NULL, project_id uuid NOT NULL,
 repository_id uuid NOT NULL REFERENCES collab.repositories(id), promotion_id uuid NOT NULL REFERENCES collab.promotions(id),
 target_sha text NOT NULL, old_sha text NOT NULL, new_sha text NOT NULL,
 created_by text NOT NULL REFERENCES public."user"(id), request_key uuid NOT NULL, request jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(created_by,request_key),
 FOREIGN KEY(organization_id,project_id,task_id) REFERENCES collab.tasks(organization_id,project_id,id)
);
ALTER TABLE collab.revert_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY revert_read ON collab.revert_tasks FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
GRANT SELECT ON collab.revert_tasks TO pi_collab_app;
CREATE FUNCTION collab.create_revert_task(source uuid, expected_base text, title text, reason text, request_key uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p collab.promotions; repo collab.repositories; prior collab.revert_tasks; task uuid:=gen_random_uuid(); payload jsonb;
BEGIN
 SELECT * INTO p FROM collab.promotions WHERE id=source;
 IF p.id IS NULL OR collab.project_role(p.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p.organization_id::text,811));
 IF collab.project_role(p.project_id) IS DISTINCT FROM 'maintainer' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
 IF title IS NULL OR length(btrim(title)) NOT BETWEEN 1 AND 200 OR reason IS NULL OR length(btrim(reason)) NOT BETWEEN 10 AND 2000 OR request_key IS NULL THEN RAISE EXCEPTION 'invalid_revert' USING ERRCODE='P0001'; END IF;
 payload:=jsonb_build_object('promotionId',source,'baseSha',expected_base,'title',btrim(title),'reason',btrim(reason));
 SELECT * INTO prior FROM collab.revert_tasks WHERE created_by=collab.actor() AND revert_tasks.request_key=create_revert_task.request_key;
 IF FOUND THEN
  IF prior.request<>payload THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
  RETURN jsonb_build_object('taskId',prior.task_id,'replayed',true);
 END IF;
 SELECT * INTO repo FROM collab.repositories WHERE id=p.repository_id;
 IF p.status<>'applied' OR repo.base_sha IS DISTINCT FROM expected_base OR repo.default_branch<>p.target_branch
  OR NOT EXISTS(SELECT 1 FROM collab.repository_baselines WHERE promotion_id=p.id AND new_sha=p.promotion_sha)
 THEN RAISE EXCEPTION 'revert_source_unavailable' USING ERRCODE='P0001'; END IF;
 INSERT INTO collab.tasks(id,organization_id,project_id,title,description,acceptance,owner_id,created_by)
 VALUES(task,p.organization_id,p.project_id,btrim(title),btrim(reason),
 '撤回固定推进的完整代码差异，保留其后的独立变更。核对冲突、执行固定验证、发布成果，再取得独立评审后推进新提交；不能 reset 共享分支。',collab.actor(),collab.actor());
 INSERT INTO collab.revert_tasks VALUES(task,p.organization_id,p.project_id,p.repository_id,p.id,expected_base,p.input->>'targetSha',p.promotion_sha,collab.actor(),request_key,payload,now());
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(p.organization_id,p.project_id,collab.actor(),'revert.created',task::text,payload);
 RETURN jsonb_build_object('taskId',task,'replayed',false);
END $$;
-- Pin all entry points, including legacy submit functions. Old executors fail
-- closed before taking a revert task; only the aware claim supplies its input.
CREATE FUNCTION collab_worker.guard_revert_run() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE input collab.revert_tasks; w collab.workspaces;
BEGIN
 SELECT * INTO input FROM collab.revert_tasks WHERE task_id=NEW.task_id;
 IF NOT FOUND THEN RETURN NEW; END IF;
 SELECT * INTO w FROM collab.workspaces WHERE id=NEW.workspace_id;
 IF w.repository_id<>input.repository_id OR w.base_sha<>input.target_sha
  OR NOT EXISTS(SELECT 1 FROM collab.repositories WHERE id=input.repository_id AND base_sha=input.target_sha)
 THEN RAISE EXCEPTION 'revert_source_unavailable' USING ERRCODE='P0001'; END IF;
 IF TG_OP='UPDATE' AND NEW.status='starting' AND OLD.status<>'starting' AND current_setting('collab.revert_protocol',true) IS DISTINCT FROM '1'
 THEN RAISE EXCEPTION 'revert_executor_upgrade_required' USING ERRCODE='P0001'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER revert_run_admission BEFORE INSERT ON collab.runs FOR EACH ROW EXECUTE FUNCTION collab_worker.guard_revert_run();
CREATE TRIGGER revert_run_claim BEFORE UPDATE OF status ON collab.runs FOR EACH ROW WHEN (NEW.status='starting') EXECUTE FUNCTION collab_worker.guard_revert_run();
CREATE FUNCTION collab_worker.claim_revert_aware(executor uuid, runtime_mode text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE claimed jsonb; input jsonb;
BEGIN
 PERFORM set_config('collab.revert_protocol','1',true);
 claimed:=collab_worker.claim_resolution_aware(executor,runtime_mode);
 IF claimed IS NULL THEN RETURN NULL; END IF;
 SELECT jsonb_build_object('version',1,'taskId',r.task_id,'repositoryId',r.repository_id,'promotionId',r.promotion_id,'targetSha',r.target_sha,'oldSha',r.old_sha,'newSha',r.new_sha)
 INTO input FROM collab.revert_tasks r WHERE task_id=(claimed->'run'->>'task_id')::uuid;
 RETURN claimed||jsonb_build_object('revert',input);
END $$;
ALTER FUNCTION collab_worker.resolution_current(uuid) RENAME TO resolution_current_v18;
CREATE FUNCTION collab_worker.resolution_current(task uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT collab_worker.resolution_current_v18(task) AND NOT EXISTS(SELECT 1 FROM collab.revert_tasks rt JOIN collab.repositories r ON r.id=rt.repository_id WHERE rt.task_id=task AND rt.target_sha<>r.base_sha)
$$;
REVOKE ALL ON FUNCTION collab.create_revert_task(uuid,text,text,text,uuid),collab_worker.guard_revert_run(),collab_worker.claim_revert_aware(uuid,text),collab_worker.resolution_current(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.create_revert_task(uuid,text,text,text,uuid) TO pi_collab_app;
GRANT EXECUTE ON FUNCTION collab_worker.claim_revert_aware(uuid,text) TO pi_collab_executor;
