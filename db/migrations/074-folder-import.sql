-- Browser-selected bytes only; never an HTTP-supplied host filesystem path.
CREATE TABLE collab.folder_imports (
 project_id uuid NOT NULL REFERENCES collab.projects(id),actor_id text NOT NULL,request_key uuid NOT NULL,
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),bytes bigint NOT NULL CHECK(bytes BETWEEN 0 AND 33554432),
 result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(project_id,actor_id,request_key)
);
ALTER TABLE collab.folder_imports ENABLE ROW LEVEL SECURITY;
CREATE POLICY folder_import_read ON collab.folder_imports FOR SELECT USING(actor_id=collab.actor() AND collab.project_role(project_id) IS NOT NULL);
GRANT SELECT ON collab.folder_imports TO pi_collab_app;
CREATE FUNCTION collab.register_folder(project uuid,request_key uuid,fingerprint text,folder_name text,ids jsonb,base text,digest text,snapshot_summary jsonb,byte_size bigint,workspace_bytes bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE org uuid; org_version bigint; member_version bigint; previous collab.folder_imports; result jsonb;
 repo uuid:=(ids->>'repositoryId')::uuid; task uuid:=(ids->>'taskId')::uuid; workspace uuid:=(ids->>'workspaceId')::uuid; run uuid:=(ids->>'runId')::uuid; snapshot uuid:=(ids->>'snapshotId')::uuid; editor uuid;
BEGIN
 IF collab.project_role(project) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 IF collab.project_role(project) NOT IN ('developer','maintainer') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001';END IF;
 IF collab.user_requires_mfa(collab.actor()) AND NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001';END IF;
 SELECT organization_id INTO STRICT org FROM collab.projects WHERE id=project;
 PERFORM pg_advisory_xact_lock(hashtextextended(org::text,811));
 SELECT * INTO previous FROM collab.folder_imports f WHERE f.project_id=project AND f.actor_id=collab.actor() AND f.request_key=register_folder.request_key;
 IF FOUND THEN IF previous.fingerprint<>fingerprint THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001';END IF;RETURN previous.result;END IF;
 IF request_key IS NULL OR fingerprint IS NULL OR fingerprint !~ '^[a-f0-9]{64}$' OR base IS NULL OR base !~ '^[a-f0-9]{40}$' OR digest IS NULL OR digest !~ '^[a-f0-9]{64}$' OR folder_name IS NULL OR length(folder_name) NOT BETWEEN 1 AND 120 OR byte_size IS NULL OR byte_size NOT BETWEEN 0 AND 33554432 OR workspace_bytes IS NULL OR workspace_bytes<0 OR repo IS NULL OR task IS NULL OR workspace IS NULL OR run IS NULL OR snapshot IS NULL THEN RAISE EXCEPTION 'invalid_folder_import' USING ERRCODE='P0001';END IF;
 IF (SELECT count(*) FROM collab.folder_imports WHERE project_id=project)>=64 OR (SELECT coalesce(sum(bytes),0)+byte_size FROM collab.folder_imports WHERE project_id=project)>536870912 THEN RAISE EXCEPTION 'folder_import_limit' USING ERRCODE='P0001';END IF;
 SELECT authorization_version INTO org_version FROM collab.memberships WHERE organization_id=org AND user_id=collab.actor();
 SELECT authorization_version INTO member_version FROM collab.project_memberships WHERE project_id=project AND user_id=collab.actor();
 INSERT INTO collab.repositories(id,organization_id,project_id,name,provider,base_sha,default_branch) VALUES(repo,org,project,folder_name,'local',base,'main');
 INSERT INTO collab.tasks(id,organization_id,project_id,title,description,acceptance,owner_id,created_by) VALUES(task,org,project,'编辑文件夹：'||folder_name,'从浏览器选择的本机文件夹建立协作副本。原目录不受修改，Git 历史与凭据不导入。','检查修改并在共享草稿确认保存。',collab.actor(),collab.actor());
 INSERT INTO collab.workspaces(id,organization_id,project_id,task_id,repository_id,created_by,base_sha,runtime,status) VALUES(workspace,org,project,task,repo,collab.actor(),base,'native','stopped');
 -- A completed preparation record, explicitly labelled as import, never a billed AI run.
 INSERT INTO collab.runs(id,organization_id,project_id,task_id,workspace_id,requested_by,prompt,status,authorization_version,summary,finished_at) VALUES(run,org,project,task,workspace,collab.actor(),'导入工作文件夹：'||folder_name,'completed',org_version,'{"reason":"folder_import"}',now());
 UPDATE collab.run_controls SET instructions_open=false WHERE run_id=run;
 UPDATE collab.run_environments SET status='ready' WHERE run_id=run;
 INSERT INTO collab_worker.workspace_usage(workspace_id,epoch,bytes) VALUES(workspace,0,workspace_bytes);
 INSERT INTO collab.snapshots(id,organization_id,project_id,task_id,run_id,workspace_id,requested_by,idempotency_key,payload,context,organization_version,project_version,status,manifest_hash,summary,finished_at) VALUES(snapshot,org,project,task,run,workspace,collab.actor(),request_key,jsonb_build_object('note','导入工作文件夹：'||folder_name),'{}',org_version,member_version,'ready',digest,snapshot_summary,now());
 editor:=collab.open_editor(task,snapshot,1);
 result:=jsonb_build_object('repositoryId',repo,'taskId',task,'sessionId',editor,'snapshotId',snapshot,'folderName',folder_name);
 INSERT INTO collab.folder_imports VALUES(project,collab.actor(),request_key,fingerprint,byte_size,result,now());
 INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES(org,project,collab.actor(),'folder.imported',repo,jsonb_build_object('taskId',task,'name',folder_name,'bytes',byte_size,'source','browser-selected-files'));
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION collab.register_folder(uuid,uuid,text,text,jsonb,text,text,jsonb,bigint,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.register_folder(uuid,uuid,text,text,jsonb,text,text,jsonb,bigint,bigint) TO pi_collab_app;
