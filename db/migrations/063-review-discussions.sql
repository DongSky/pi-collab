-- Fixed diff comments reuse task discussion messages, notifications and resolution.
ALTER TABLE collab.discussion_threads ADD COLUMN review_anchor jsonb;
ALTER TABLE collab.discussion_threads ADD CONSTRAINT discussion_one_anchor CHECK(review_anchor IS NULL OR (anchor IS NULL AND replacement IS NULL));
CREATE INDEX discussion_review_source ON collab.discussion_threads ((review_anchor->>'sourceId')) WHERE review_anchor IS NOT NULL;
CREATE FUNCTION collab.review_discussion_context(kind text, source uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE project uuid; hash text; tasks jsonb;
BEGIN
 IF kind='pull' THEN
  SELECT j.project_id,j.manifest_hash,jsonb_build_array(jsonb_build_object('id',t.id,'title',t.title)) INTO project,hash,tasks
  FROM collab_git.pull_revision_jobs j JOIN collab.tasks t ON t.id=j.task_id WHERE j.id=source AND j.status='ready';
 ELSIF kind='integration' THEN
  SELECT i.project_id,i.input_hash,(SELECT jsonb_agg(jsonb_build_object('id',t.id,'title',t.title) ORDER BY t.title,t.id)
   FROM collab.integration_sources s JOIN collab.tasks t ON t.id=s.task_id WHERE s.integration_id=i.id)
  INTO project,hash,tasks FROM collab.integrations i WHERE i.id=source AND i.evidence IS NOT NULL AND EXISTS(SELECT 1 FROM collab_worker.artifacts a WHERE a.kind='integration' AND a.id=i.id AND a.state='retained');
 ELSE RAISE EXCEPTION 'invalid_discussion' USING ERRCODE='P0001'; END IF;
 IF project IS NULL OR hash IS NULL OR collab.project_role(project) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 RETURN jsonb_build_object('userId',collab.actor(),'sourceHash',hash,'tasks',coalesce(tasks,'[]'::jsonb),'members',
 (SELECT coalesce(jsonb_agg(jsonb_build_object('user_id',pm.user_id,'name',u.name) ORDER BY u.name,pm.user_id),'[]'::jsonb)
  FROM collab.project_memberships pm JOIN collab.memberships m ON m.organization_id=pm.organization_id AND m.user_id=pm.user_id
  JOIN public."user" u ON u.id=pm.user_id WHERE pm.project_id=project AND pm.active AND m.active));
END $$;
REVOKE ALL ON FUNCTION collab.review_discussion_context(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.review_discussion_context(text,uuid) TO pi_collab_app;

CREATE OR REPLACE FUNCTION collab.discussion_command(task uuid, request_key uuid, payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t collab.tasks; d collab.discussion_threads; role text; prior collab.discussion_requests; request jsonb; result jsonb;
 action text:=payload->>'action'; mentions text[]; message_id bigint; anchor jsonb:=payload->'anchor'; snapshot collab.snapshots; review jsonb:=nullif(payload->'reviewAnchor','null'::jsonb); context jsonb;
BEGIN
 SELECT * INTO t FROM collab.tasks WHERE id=task;
 IF t.id IS NULL OR collab.project_role(t.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(t.organization_id::text,811));
 PERFORM pg_advisory_xact_lock(hashtextextended(task::text,838));
 role:=collab.project_role(t.project_id);
 IF role IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 IF request_key IS NULL OR action IS NULL OR action NOT IN ('create','reply','resolve','subscribe') THEN RAISE EXCEPTION 'invalid_discussion' USING ERRCODE='P0001'; END IF;
 IF action<>'subscribe' AND role NOT IN ('developer','reviewer','maintainer') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
 IF collab.user_requires_mfa(collab.actor()) AND NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001'; END IF;
 request:=jsonb_build_object('taskId',task,'payload',payload);
 SELECT * INTO prior FROM collab.discussion_requests WHERE actor_id=collab.actor() AND discussion_requests.request_key=discussion_command.request_key;
 IF FOUND THEN
   IF prior.request<>request THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
   RETURN prior.result||jsonb_build_object('replayed',true);
 END IF;
 IF action='subscribe' THEN
   IF jsonb_typeof(payload->'enabled') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'invalid_discussion' USING ERRCODE='P0001'; END IF;
   INSERT INTO collab.task_subscriptions(task_id,user_id,enabled) VALUES(task,collab.actor(),(payload->>'enabled')::boolean)
   ON CONFLICT(task_id,user_id) DO UPDATE SET enabled=EXCLUDED.enabled;
   result:=jsonb_build_object('subscribed',(payload->>'enabled')::boolean);
 ELSE
   IF action IN ('create','reply') THEN
     IF jsonb_typeof(payload->'body') IS DISTINCT FROM 'string' OR length(btrim(payload->>'body')) NOT BETWEEN 1 AND 8000
       OR jsonb_typeof(payload->'mentions') IS DISTINCT FROM 'array' OR jsonb_array_length(payload->'mentions')>20
       THEN RAISE EXCEPTION 'invalid_discussion' USING ERRCODE='P0001'; END IF;
     SELECT coalesce(array_agg(DISTINCT value),'{}') INTO mentions FROM jsonb_array_elements_text(payload->'mentions');
     IF EXISTS(SELECT 1 FROM unnest(mentions) u WHERE NOT EXISTS(SELECT 1 FROM collab.project_memberships pm JOIN collab.memberships m ON m.organization_id=pm.organization_id AND m.user_id=pm.user_id WHERE pm.project_id=t.project_id AND pm.user_id=u AND pm.active AND m.active)) THEN RAISE EXCEPTION 'invalid_mention' USING ERRCODE='P0001'; END IF;
   END IF;
   IF action='create' THEN
     IF length(btrim(payload->>'title')) NOT BETWEEN 1 AND 200 OR payload->>'title' IS NULL THEN RAISE EXCEPTION 'invalid_discussion' USING ERRCODE='P0001'; END IF;
     IF anchor IS NOT NULL AND anchor<>'null'::jsonb THEN
       SELECT * INTO snapshot FROM collab.snapshots WHERE id=(anchor->>'snapshotId')::uuid AND task_id=task AND status='ready' AND manifest_hash=anchor->>'manifestHash';
       IF snapshot.id IS NULL OR length(anchor->>'path') NOT BETWEEN 1 AND 1024 OR (anchor->>'fileHash') !~ '^[a-f0-9]{64}$'
         OR (anchor->>'startLine')::integer<1 OR (anchor->>'endLine')::integer<(anchor->>'startLine')::integer
         THEN RAISE EXCEPTION 'suggestion_source_unavailable' USING ERRCODE='P0001'; END IF;
     ELSE anchor:=NULL; END IF;
     IF review IS NOT NULL THEN
       IF anchor IS NOT NULL OR payload->>'replacement' IS NOT NULL THEN RAISE EXCEPTION 'invalid_discussion' USING ERRCODE='P0001'; END IF;
       context:=collab.review_discussion_context(review->>'kind',(review->>'sourceId')::uuid);
       IF context->>'sourceHash' IS DISTINCT FROM review->>'sourceHash'
         OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(context->'tasks') x WHERE x->>'id'=task::text)
         OR review->>'diffHash' IS NULL OR review->>'diffHash' !~ '^[a-f0-9]{64}$'
         OR review->>'path' IS NULL OR length(review->>'path') NOT BETWEEN 1 AND 1024
         OR review->>'side' IS NULL OR review->>'side' NOT IN ('before','after')
         OR review->>'startLine' IS NULL OR review->>'endLine' IS NULL
         OR (review->>'startLine')::integer NOT BETWEEN 1 AND 8000
         OR (review->>'endLine')::integer NOT BETWEEN (review->>'startLine')::integer AND 8000
         THEN RAISE EXCEPTION 'invalid_discussion' USING ERRCODE='P0001'; END IF;
     END IF;
     INSERT INTO collab.discussion_threads(organization_id,project_id,task_id,author_id,title,anchor,replacement,review_anchor)
     VALUES(t.organization_id,t.project_id,task,collab.actor(),btrim(payload->>'title'),anchor,payload->>'replacement',review) RETURNING * INTO d;
   ELSE
     SELECT * INTO d FROM collab.discussion_threads WHERE id=(payload->>'threadId')::uuid AND task_id=task FOR UPDATE;
     IF d.id IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
   END IF;
   IF action='resolve' THEN
     IF role<>'maintainer' AND collab.actor()<>d.author_id AND collab.actor()<>t.owner_id THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001'; END IF;
     IF (payload->>'expectedVersion')::integer IS DISTINCT FROM d.version THEN RAISE EXCEPTION 'stale_revision' USING ERRCODE='P0001'; END IF;
     IF jsonb_typeof(payload->'resolved') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'invalid_discussion' USING ERRCODE='P0001'; END IF;
     UPDATE collab.discussion_threads SET resolved=(payload->>'resolved')::boolean,version=version+1,updated_at=now() WHERE id=d.id;
     PERFORM collab.notify_task(task,collab.actor(),'discussion.state',d.id::text||':state:'||(d.version+1)::text,d.id,ARRAY[d.author_id]);
   ELSE
     IF d.resolved THEN RAISE EXCEPTION 'discussion_resolved' USING ERRCODE='P0001'; END IF;
     INSERT INTO collab.discussion_messages(thread_id,organization_id,project_id,author_id,body,mentions)
     VALUES(d.id,t.organization_id,t.project_id,collab.actor(),btrim(payload->>'body'),mentions) RETURNING id INTO message_id;
     UPDATE collab.discussion_threads SET updated_at=now() WHERE id=d.id;
     PERFORM collab.notify_task(task,collab.actor(),'discussion.message','message:'||message_id::text,d.id,mentions);
   END IF;
   result:=jsonb_build_object('threadId',d.id,'messageId',message_id);
   INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail)
   VALUES(t.organization_id,t.project_id,collab.actor(),'discussion.'||action,d.id::text,jsonb_build_object('taskId',task));
 END IF;
 INSERT INTO collab.discussion_requests VALUES(collab.actor(),request_key,request,result);
 RETURN result||jsonb_build_object('replayed',false);
END
$$;


-- Keep the fixed code available for the lifetime of its discussion, as for snapshot comments.
DO $$ DECLARE previous text; updated text; BEGIN
 SELECT pg_get_functiondef('collab_worker.artifact_protection_before_service(text,uuid)'::regprocedure) INTO previous;
 updated:=replace(previous,'EXISTS(SELECT 1 FROM collab.integration_reviews WHERE integration_id=artifact)','EXISTS(SELECT 1 FROM collab.integration_reviews WHERE integration_id=artifact) OR EXISTS(SELECT 1 FROM collab.discussion_threads WHERE review_anchor->>''kind''=''integration'' AND review_anchor->>''sourceId''=artifact::text)');
 IF updated=previous THEN RAISE EXCEPTION 'Missing integration artifact protection boundary'; END IF;
 EXECUTE updated;
END $$;

DO $$ DECLARE previous text; updated text; BEGIN
 SELECT pg_get_functiondef('collab.result_evidence_metadata(uuid)'::regprocedure) INTO previous;
 updated:=replace(previous,'''anchor'',d.anchor,','''anchor'',d.anchor,''reviewAnchor'',d.review_anchor,');
 IF updated=previous THEN RAISE EXCEPTION 'Missing discussion evidence boundary'; END IF;
 EXECUTE updated;
END $$;
