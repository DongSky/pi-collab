-- Ordinary discussion is deliberately separate from coordination input and Pi commands.
CREATE TABLE collab.discussion_threads (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, project_id uuid NOT NULL, task_id uuid NOT NULL,
 author_id text NOT NULL REFERENCES public."user"(id), title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
 anchor jsonb, replacement text CHECK(octet_length(replacement)<=65536),
 resolved boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,project_id,id),
 FOREIGN KEY(organization_id,project_id,task_id) REFERENCES collab.tasks(organization_id,project_id,id),
 CHECK(replacement IS NULL OR anchor IS NOT NULL)
);
CREATE TABLE collab.discussion_messages (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, thread_id uuid NOT NULL REFERENCES collab.discussion_threads(id),
 organization_id uuid NOT NULL, project_id uuid NOT NULL, author_id text NOT NULL REFERENCES public."user"(id),
 body text NOT NULL CHECK(length(body) BETWEEN 1 AND 8000), mentions text[] NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,project_id,thread_id) REFERENCES collab.discussion_threads(organization_id,project_id,id)
);
CREATE TABLE collab.task_subscriptions (
 task_id uuid NOT NULL REFERENCES collab.tasks(id), user_id text NOT NULL REFERENCES public."user"(id), enabled boolean NOT NULL,
 PRIMARY KEY(task_id,user_id)
);
CREATE TABLE collab.inbox (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, organization_id uuid NOT NULL, project_id uuid NOT NULL, task_id uuid NOT NULL,
 recipient_id text NOT NULL REFERENCES public."user"(id), actor_id text REFERENCES public."user"(id),
 kind text NOT NULL, thread_id uuid REFERENCES collab.discussion_threads(id), event_key text NOT NULL,
 read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(recipient_id,event_key),
 FOREIGN KEY(organization_id,project_id,task_id) REFERENCES collab.tasks(organization_id,project_id,id)
);
CREATE TABLE collab.discussion_requests (
 actor_id text NOT NULL REFERENCES public."user"(id), request_key uuid NOT NULL, request jsonb NOT NULL, result jsonb NOT NULL,
 PRIMARY KEY(actor_id,request_key)
);
CREATE TABLE collab.run_suggestions (
 run_id uuid PRIMARY KEY REFERENCES collab.runs(id), thread_id uuid NOT NULL REFERENCES collab.discussion_threads(id),
 applied_hash text, applied_at timestamptz
);
CREATE INDEX discussion_task ON collab.discussion_threads(task_id,created_at DESC);
CREATE INDEX discussion_messages_thread ON collab.discussion_messages(thread_id,id);
CREATE INDEX inbox_recipient ON collab.inbox(recipient_id,id DESC);
ALTER TABLE collab.discussion_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE collab.discussion_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE collab.task_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE collab.inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE collab.discussion_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE collab.run_suggestions ENABLE ROW LEVEL SECURITY;
CREATE POLICY discussion_threads_read ON collab.discussion_threads FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
CREATE POLICY discussion_messages_read ON collab.discussion_messages FOR SELECT USING(collab.project_role(project_id) IS NOT NULL);
CREATE POLICY task_subscriptions_read ON collab.task_subscriptions FOR SELECT USING(user_id=collab.actor() AND EXISTS(SELECT 1 FROM collab.tasks WHERE id=task_id));
CREATE POLICY inbox_read ON collab.inbox FOR SELECT USING(recipient_id=collab.actor() AND collab.project_role(project_id) IS NOT NULL);
CREATE POLICY inbox_mark ON collab.inbox FOR UPDATE USING(recipient_id=collab.actor() AND collab.project_role(project_id) IS NOT NULL) WITH CHECK(recipient_id=collab.actor() AND collab.project_role(project_id) IS NOT NULL);
CREATE POLICY run_suggestions_read ON collab.run_suggestions FOR SELECT USING(EXISTS(SELECT 1 FROM collab.runs WHERE id=run_id));
GRANT SELECT ON collab.discussion_threads,collab.discussion_messages,collab.task_subscriptions,collab.inbox,collab.run_suggestions TO pi_collab_app;
GRANT UPDATE(read_at) ON collab.inbox TO pi_collab_app;

-- Private fanout: only current members receive entries; later revocation also hides entries via RLS.
CREATE FUNCTION collab.notify_task(task uuid, who text, event_kind text, event text, thread uuid DEFAULT NULL, mentioned text[] DEFAULT '{}') RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 INSERT INTO collab.inbox(organization_id,project_id,task_id,recipient_id,actor_id,kind,thread_id,event_key)
 SELECT t.organization_id,t.project_id,t.id,pm.user_id,who,
   CASE WHEN event_kind='discussion.message' AND pm.user_id=ANY(mentioned) THEN 'mention' ELSE event_kind END,thread,event
 FROM collab.tasks t JOIN collab.project_memberships pm ON pm.project_id=t.project_id AND pm.active
 JOIN collab.memberships m ON m.organization_id=pm.organization_id AND m.user_id=pm.user_id AND m.active
 LEFT JOIN collab.task_subscriptions s ON s.task_id=t.id AND s.user_id=pm.user_id
 WHERE t.id=task AND pm.user_id IS DISTINCT FROM who AND
 (pm.user_id=ANY(mentioned) OR s.enabled OR (s.enabled IS NULL AND pm.user_id=t.owner_id))
 ON CONFLICT(recipient_id,event_key) DO NOTHING
$$;
CREATE FUNCTION collab.discussion_command(task uuid, request_key uuid, payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t collab.tasks; d collab.discussion_threads; role text; prior collab.discussion_requests; request jsonb; result jsonb;
 action text:=payload->>'action'; mentions text[]; message_id bigint; anchor jsonb:=payload->'anchor'; snapshot collab.snapshots;
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
     INSERT INTO collab.discussion_threads(organization_id,project_id,task_id,author_id,title,anchor,replacement)
     VALUES(t.organization_id,t.project_id,task,collab.actor(),btrim(payload->>'title'),anchor,payload->>'replacement') RETURNING * INTO d;
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

-- Application to a newly restored workspace is part of run admission; existing workspaces are never patched by Web.
CREATE FUNCTION collab.submit_suggestion_run(task uuid, repository uuid, base text, message text, runtime_mode text, request_key uuid, expected_version integer, model_profile uuid, snapshot uuid, suggestion uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE accepted jsonb; d collab.discussion_threads; r uuid;
BEGIN
 IF suggestion IS NOT NULL THEN
   SELECT * INTO d FROM collab.discussion_threads WHERE id=suggestion AND task_id=task;
   IF d.id IS NULL OR collab.project_role(d.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
   IF d.replacement IS NULL OR (d.anchor->>'snapshotId')::uuid IS DISTINCT FROM snapshot THEN RAISE EXCEPTION 'suggestion_source_unavailable' USING ERRCODE='P0001'; END IF;
 END IF;
 accepted:=collab.submit_run(task,repository,base,message,runtime_mode,request_key,expected_version,model_profile,snapshot);
 r:=(accepted->>'runId')::uuid;
 IF (accepted->>'replayed')::boolean THEN
   IF (SELECT thread_id FROM collab.run_suggestions WHERE run_id=r) IS DISTINCT FROM suggestion THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
 ELSIF suggestion IS NOT NULL THEN
   IF d.resolved THEN RAISE EXCEPTION 'discussion_resolved' USING ERRCODE='P0001'; END IF;
   INSERT INTO collab.run_suggestions(run_id,thread_id) VALUES(r,suggestion);
 END IF;
 RETURN accepted;
END
$$;
CREATE FUNCTION collab_worker.run_suggestion(executor uuid, run uuid, generation bigint, applied text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab.runs; d collab.discussion_threads;
BEGIN
 r:=collab_worker.assert_lease(executor,run,generation);
 IF NOT collab_worker.authorized(run) OR r.status<>'starting' THEN RAISE EXCEPTION 'run_not_executable' USING ERRCODE='P0001'; END IF;
 SELECT t.* INTO d FROM collab.run_suggestions s JOIN collab.discussion_threads t ON t.id=s.thread_id WHERE s.run_id=run;
 IF d.id IS NULL THEN RETURN NULL; END IF;
 IF applied IS NOT NULL THEN
   IF applied !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'invalid_discussion' USING ERRCODE='P0001'; END IF;
   UPDATE collab.run_suggestions SET applied_hash=applied,applied_at=now() WHERE run_id=run AND applied_at IS NULL;
 END IF;
 RETURN jsonb_build_object('threadId',d.id,'anchor',d.anchor,'replacement',d.replacement);
END
$$;
CREATE FUNCTION collab.discussion_run_notification() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('completed','failed','cancelled','reconciling') THEN
   PERFORM collab.notify_task(NEW.task_id,NULL,'run.'||NEW.status,'run:'||NEW.id::text||':'||NEW.revision::text,NULL,ARRAY[NEW.requested_by]);
 END IF;
 RETURN NEW;
END
$$;
CREATE TRIGGER discussion_run_notification AFTER UPDATE OF status ON collab.runs FOR EACH ROW EXECUTE FUNCTION collab.discussion_run_notification();
REVOKE EXECUTE ON FUNCTION collab.notify_task(uuid,text,text,text,uuid,text[]),collab.discussion_command(uuid,uuid,jsonb),collab.submit_suggestion_run(uuid,uuid,text,text,text,uuid,integer,uuid,uuid,uuid),collab_worker.run_suggestion(uuid,uuid,bigint,text),collab.discussion_run_notification() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.discussion_command(uuid,uuid,jsonb),collab.submit_suggestion_run(uuid,uuid,text,text,text,uuid,integer,uuid,uuid,uuid) TO pi_collab_app;
GRANT EXECUTE ON FUNCTION collab_worker.run_suggestion(uuid,uuid,bigint,text) TO pi_collab_executor;
