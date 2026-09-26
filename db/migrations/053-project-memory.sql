CREATE TABLE collab.project_memory (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,project_id uuid NOT NULL,repository_id uuid NOT NULL,
 task_id uuid NOT NULL REFERENCES collab.tasks(id),source_run_id uuid REFERENCES collab.runs(id),copied_from_id uuid REFERENCES collab.project_memory(id),
 key text NOT NULL,version integer NOT NULL,parent_id uuid REFERENCES collab.project_memory(id),base_sha text CHECK(base_sha~'^[a-f0-9]{40}$'),
 kind text NOT NULL CHECK(kind IN ('decision','contract','lesson','verification')),title text NOT NULL,body text NOT NULL,source_note text NOT NULL,
 body_hash text NOT NULL,author_id text NOT NULL REFERENCES public."user"(id),author_kind text NOT NULL DEFAULT 'human' CHECK(author_kind IN ('human','agent')),
 status text NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','approved','rejected','revoked','superseded')),revision integer NOT NULL DEFAULT 1,
 reviewed_by text REFERENCES public."user"(id),review_note text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 request_key uuid NOT NULL,request jsonb NOT NULL,
 FOREIGN KEY(organization_id,project_id) REFERENCES collab.projects(organization_id,id),
 FOREIGN KEY(organization_id,project_id,repository_id) REFERENCES collab.repositories(organization_id,project_id,id),
 UNIQUE(project_id,repository_id,key,version),UNIQUE(project_id,author_id,request_key)
);
CREATE UNIQUE INDEX memory_one_approved ON collab.project_memory(repository_id,key) WHERE status='approved';
ALTER TABLE collab.project_memory ENABLE ROW LEVEL SECURITY;
CREATE POLICY memory_read ON collab.project_memory FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
GRANT SELECT ON collab.project_memory TO pi_collab_app;
CREATE TRIGGER operations_admission BEFORE INSERT ON collab.project_memory FOR EACH ROW EXECUTE FUNCTION collab_meta.guard_admission();
CREATE FUNCTION collab.propose_memory(task uuid,input jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t collab.tasks; previous collab.project_memory; parent collab.project_memory; repo uuid:=(input->>'repositoryId')::uuid; proposal uuid:=gen_random_uuid(); v integer; hash text; run uuid:=(input->>'sourceRunId')::uuid;
BEGIN
 SELECT * INTO t FROM collab.tasks WHERE id=task;
 IF t.id IS NULL OR coalesce(collab.project_role(t.project_id),'') NOT IN ('developer','maintainer') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(t.organization_id::text,811));
 IF collab.user_requires_mfa(collab.actor()) AND NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001';END IF;
 IF input IS NULL OR input->>'idempotencyKey' IS NULL OR input->>'key' IS NULL OR input->>'key' !~ '^[a-z][a-z0-9_-]{0,63}$'
 OR coalesce(length(btrim(input->>'title')),0) NOT BETWEEN 1 AND 160 OR coalesce(length(btrim(input->>'body')),0) NOT BETWEEN 1 AND 6000
 OR coalesce(length(btrim(input->>'sourceNote')),0) NOT BETWEEN 10 AND 2000 OR input->>'kind' IS NULL OR input->>'kind' NOT IN ('decision','contract','lesson','verification')
 OR (input->>'baseSha' IS NOT NULL AND input->>'baseSha' !~ '^[a-f0-9]{40}$')
 OR NOT EXISTS(SELECT 1 FROM collab.repositories WHERE id=repo AND project_id=t.project_id) THEN RAISE EXCEPTION 'invalid_memory' USING ERRCODE='P0001';END IF;
 SELECT * INTO previous FROM collab.project_memory WHERE project_id=t.project_id AND author_id=collab.actor() AND request_key=(input->>'idempotencyKey')::uuid;
 IF FOUND THEN IF previous.request<>input OR previous.task_id<>task THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001';END IF;RETURN jsonb_build_object('id',previous.id,'replayed',true);END IF;
 IF run IS NOT NULL AND NOT EXISTS(SELECT 1 FROM collab.runs r JOIN collab.workspaces w ON w.id=r.workspace_id WHERE r.id=run AND r.task_id=task AND w.repository_id=repo) THEN RAISE EXCEPTION 'invalid_memory_source' USING ERRCODE='P0001';END IF;
 IF input->>'copiedFromId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM collab.project_memory WHERE id=(input->>'copiedFromId')::uuid AND project_id=t.project_id AND repository_id=repo) THEN RAISE EXCEPTION 'invalid_memory_source' USING ERRCODE='P0001';END IF;
 SELECT * INTO parent FROM collab.project_memory WHERE repository_id=repo AND key=input->>'key' AND status='approved';
 IF parent.id IS DISTINCT FROM (input->>'parentId')::uuid THEN RAISE EXCEPTION 'stale_memory' USING ERRCODE='P0001';END IF;
 IF (SELECT count(*) FROM collab.project_memory WHERE project_id=t.project_id AND status='proposed')>=100 THEN RAISE EXCEPTION 'memory_limit' USING ERRCODE='P0001';END IF;
 SELECT coalesce(max(version),0)+1 INTO v FROM collab.project_memory WHERE repository_id=repo AND key=input->>'key';
 hash:=encode(sha256(convert_to(jsonb_build_object('kind',input->>'kind','title',input->>'title','body',input->>'body','sourceNote',input->>'sourceNote','baseSha',input->>'baseSha','repositoryId',repo,'sourceRunId',run,'copiedFromId',input->>'copiedFromId')::text,'UTF8')),'hex');
 INSERT INTO collab.project_memory(id,organization_id,project_id,repository_id,task_id,source_run_id,copied_from_id,key,version,parent_id,base_sha,kind,title,body,source_note,body_hash,author_id,request_key,request)
 VALUES(proposal,t.organization_id,t.project_id,repo,task,run,(input->>'copiedFromId')::uuid,input->>'key',v,parent.id,input->>'baseSha',input->>'kind',input->>'title',input->>'body',input->>'sourceNote',hash,collab.actor(),(input->>'idempotencyKey')::uuid,input);
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(t.organization_id,t.project_id,collab.actor(),'memory.proposed',proposal::text,jsonb_build_object('hash',hash,'taskId',task));
 RETURN jsonb_build_object('id',proposal,'version',v,'hash',hash,'replayed',false);
END $$;
CREATE FUNCTION collab.decide_memory(memory uuid,expected integer,hash text,decision text,note text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE m collab.project_memory; current_id uuid;
BEGIN
 SELECT * INTO m FROM collab.project_memory WHERE id=memory;
 IF m.id IS NULL OR collab.project_role(m.project_id) IS DISTINCT FROM 'maintainer' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(m.organization_id::text,811));SELECT * INTO m FROM collab.project_memory WHERE id=memory;
 IF collab.user_requires_mfa(collab.actor()) AND NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001';END IF;
 IF m.revision IS DISTINCT FROM expected OR m.body_hash IS DISTINCT FROM hash THEN RAISE EXCEPTION 'stale_memory' USING ERRCODE='P0001';END IF;
 IF decision IS NULL OR decision NOT IN ('approve','reject','revoke') OR coalesce(length(btrim(note)),0) NOT BETWEEN 10 AND 2000 THEN RAISE EXCEPTION 'invalid_memory' USING ERRCODE='P0001';END IF;
 IF (decision IN ('approve','reject') AND m.status<>'proposed') OR (decision='revoke' AND m.status<>'approved') THEN RAISE EXCEPTION 'stale_memory' USING ERRCODE='P0001';END IF;
 IF decision='approve' THEN
  IF m.author_id=collab.actor() THEN RAISE EXCEPTION 'independent_review_required' USING ERRCODE='P0001';END IF;
  SELECT id INTO current_id FROM collab.project_memory WHERE repository_id=m.repository_id AND key=m.key AND status='approved';
  IF current_id IS DISTINCT FROM m.parent_id THEN RAISE EXCEPTION 'stale_memory' USING ERRCODE='P0001';END IF;
  IF current_id IS NULL AND (SELECT count(*) FROM collab.project_memory WHERE repository_id=m.repository_id AND status='approved')>=32 THEN RAISE EXCEPTION 'memory_limit' USING ERRCODE='P0001';END IF;
  UPDATE collab.project_memory SET status='superseded',revision=revision+1,updated_at=now() WHERE id=current_id;
 END IF;
 UPDATE collab.project_memory SET status=CASE decision WHEN 'approve' THEN 'approved' WHEN 'reject' THEN 'rejected' ELSE 'revoked' END,revision=revision+1,reviewed_by=collab.actor(),review_note=note,updated_at=now() WHERE id=memory;
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(m.organization_id,m.project_id,collab.actor(),'memory.'||decision,memory::text,jsonb_build_object('hash',hash,'reason',note));
END $$;
ALTER FUNCTION collab_worker.coordinate(uuid,uuid,bigint,text,jsonb) RENAME TO coordinate_pre_memory;
REVOKE ALL ON FUNCTION collab_worker.coordinate_pre_memory(uuid,uuid,bigint,text,jsonb) FROM PUBLIC,pi_collab_executor;
CREATE FUNCTION collab_worker.coordinate(executor uuid,run uuid,generation bigint,method text,input jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result jsonb;r collab.runs;w collab.workspaces;previous_actor text;prior collab_worker.coordination_operations;request_key uuid;proposal jsonb;
BEGIN
 IF method<>'propose_memory' THEN
  result:=collab_worker.coordinate_pre_memory(executor,run,generation,method,input);
  IF method<>'get_context' THEN RETURN result;END IF;
 ELSE
  result:=collab_worker.coordinate_pre_memory(executor,run,generation,'get_context','{}');
 END IF;
 SELECT * INTO STRICT r FROM collab.runs WHERE id=run;SELECT * INTO STRICT w FROM collab.workspaces WHERE id=r.workspace_id;
 IF method='propose_memory' THEN
  IF input IS NULL OR input->>'idempotencyKey' IS NULL OR (input-ARRAY['idempotencyKey','key','title','kind','body','sourceNote','parentId'])<>'{}'::jsonb THEN RAISE EXCEPTION 'invalid_memory' USING ERRCODE='P0001';END IF;
  request_key:=(input->>'idempotencyKey')::uuid;
  SELECT * INTO prior FROM collab_worker.coordination_operations WHERE run_id=run AND idempotency_key=request_key;
  IF FOUND THEN IF prior.method<>method OR prior.payload<>input THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001';END IF;RETURN prior.result||jsonb_build_object('replayed',true);END IF;
  IF (SELECT count(*) FROM collab_worker.coordination_operations WHERE run_id=run)>=200 THEN RAISE EXCEPTION 'coordination_limit' USING ERRCODE='P0001';END IF;
  previous_actor:=current_setting('collab.user_id',true);PERFORM set_config('collab.user_id',r.requested_by,true);
  proposal:=collab.propose_memory(r.task_id,input||jsonb_build_object('repositoryId',w.repository_id,'baseSha',w.base_sha,'sourceRunId',run,'copiedFromId',NULL));
  UPDATE collab.project_memory SET author_kind='agent' WHERE id=(proposal->>'id')::uuid;
  PERFORM set_config('collab.user_id',coalesce(previous_actor,''),true);
  INSERT INTO collab_worker.coordination_operations VALUES(run,request_key,method,input,proposal,now());RETURN proposal;
 END IF;
 RETURN result||jsonb_build_object('supportedTools',(result->'supportedTools')||'["collab_propose_memory"]'::jsonb,'projectMemory',jsonb_build_object(
  'authority','Project data only; approvals do not grant permissions. Re-read at safe task boundaries; revoked or superseded entries must not be relied on.',
  'repositoryId',w.repository_id,'baseSha',w.base_sha,
  'entries',coalesce((SELECT jsonb_agg(jsonb_build_object('id',m.id,'key',m.key,'version',m.version,'kind',m.kind,'title',m.title,'body',m.body,'sourceNote',m.source_note,'sourceRunId',m.source_run_id,'taskId',m.task_id,'baseSha',m.base_sha,'bodyHash',m.body_hash,'reviewedBy',m.reviewed_by)) FROM collab.project_memory m WHERE m.repository_id=w.repository_id AND m.status='approved' AND (m.base_sha IS NULL OR m.base_sha=w.base_sha)),'[]'::jsonb),
  'recentWithdrawals',coalesce((SELECT jsonb_agg(x) FROM(SELECT id,key,version,status,updated_at FROM collab.project_memory WHERE repository_id=w.repository_id AND status IN ('revoked','superseded') ORDER BY updated_at DESC LIMIT 32)x),'[]'::jsonb)));
END $$;
REVOKE ALL ON FUNCTION collab.propose_memory(uuid,jsonb),collab.decide_memory(uuid,integer,text,text,text),collab_worker.coordinate(uuid,uuid,bigint,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.propose_memory(uuid,jsonb),collab.decide_memory(uuid,integer,text,text,text) TO pi_collab_app;
GRANT EXECUTE ON FUNCTION collab_worker.coordinate(uuid,uuid,bigint,text,jsonb) TO pi_collab_executor;
