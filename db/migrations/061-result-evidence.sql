-- Read-only assembly of existing immutable records; no new approval authority.
CREATE FUNCTION collab.result_evidence_metadata(result uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab.task_results; integrations uuid[]; revisions uuid[]; threads uuid[]; gitlab uuid[]; output jsonb;
BEGIN
 SELECT * INTO r FROM collab.task_results WHERE id=result;
 IF r.id IS NULL OR collab.project_role(r.project_id) IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 SELECT coalesce(array_agg(integration_id),'{}') INTO integrations FROM collab.integration_sources WHERE result_id=r.id;
 SELECT coalesce(array_agg(id),'{}') INTO revisions FROM collab_git.pull_revision_jobs WHERE task_id=r.task_id;
 SELECT coalesce(array_agg(id),'{}') INTO threads FROM collab.discussion_threads WHERE task_id=r.task_id AND (anchor IS NULL OR anchor->>'snapshotId'=r.snapshot_id::text);
 WITH RECURSIVE chain AS (
  SELECT id FROM collab.gitlab_operations WHERE result_id=r.id
  UNION SELECT child.id FROM collab.gitlab_operations child JOIN chain parent ON child.source_id=parent.id
 ) SELECT coalesce(array_agg(id),'{}') INTO gitlab FROM chain;
 IF cardinality(integrations)>100 OR cardinality(revisions)>100 OR cardinality(threads)>200 OR cardinality(gitlab)>200
 OR (SELECT count(*) FROM collab.discussion_messages WHERE thread_id=ANY(threads))>1000
 OR (SELECT count(*) FROM collab.integration_reviews WHERE integration_id=ANY(integrations))>1000
 OR (SELECT count(*) FROM collab_git.pull_reviews WHERE revision_id=ANY(revisions))>1000
 OR (SELECT count(*) FROM collab_git.pull_checks_jobs WHERE revision_id=ANY(revisions))>1000
 OR (SELECT count(*) FROM collab_git.pull_releases WHERE revision_id=ANY(revisions))>1000
 THEN RAISE EXCEPTION 'evidence_limit' USING ERRCODE='P0001';END IF;
 SELECT jsonb_build_object(
 'result',jsonb_build_object('id',r.id,'version',r.version,'taskId',r.task_id,'projectId',r.project_id,'sourceRunId',r.source_run_id,'snapshotId',r.snapshot_id,'validationId',r.validation_id,'manifestHash',r.manifest_hash,'worktreeCommit',r.worktree_commit,'publishedBy',r.published_by,'publishedAt',r.created_at,'note',r.payload->>'note'),
 'task',jsonb_build_object('id',t.id,'title',t.title,'description',t.description,'acceptance',t.acceptance,'version',t.version,'status',t.status,'ownerId',t.owner_id),
 'state',jsonb_build_object('currentResult',t.current_result_id=r.id,'dependencyState',collab.run_dependency_state(r.source_run_id),'withdrawal',(SELECT jsonb_build_object('reason',reason,'actorId',withdrawn_by,'at',created_at) FROM collab.result_withdrawals WHERE result_id=r.id),'repositoryBaseSha',repo.base_sha),
 'repository',jsonb_build_object('id',repo.id,'name',repo.name,'provider',repo.provider,'defaultBranch',repo.default_branch),
 'run',jsonb_build_object('id',run.id,'actorId',run.requested_by,'epoch',run.epoch::text,'kind',run.execution_kind,'status',run.status,'startedAt',run.started_at,'finishedAt',run.finished_at,'runtime',w.runtime),
 'validation',jsonb_build_object('id',v.id,'status',v.status,'profileId',v.profile_id,'manifestHash',v.manifest_hash,'evidence',v.evidence,'createdAt',v.created_at,'finishedAt',v.finished_at),
 'integrations',coalesce((SELECT jsonb_agg(jsonb_build_object('id',i.id,'status',i.status,'inputHash',i.input_hash,'inputState',collab.integration_state(i.id),'reviewState',collab.integration_review_state(i.id),'policyId',i.policy_id,'targetSha',i.target_sha,'evidence',i.evidence,
   'reviews',coalesce((SELECT jsonb_agg(jsonb_build_object('id',a.id,'reviewerId',a.reviewer_id,'version',a.version,'decision',a.decision,'note',a.note,'revisionHash',a.revision_hash,'createdAt',a.created_at) ORDER BY a.created_at,a.id) FROM collab.integration_reviews a WHERE a.integration_id=i.id),'[]'::jsonb)) ORDER BY i.created_at,i.id) FROM collab.integrations i WHERE i.id=ANY(integrations)),'[]'::jsonb),
 'discussions',coalesce((SELECT jsonb_agg(jsonb_build_object('id',d.id,'title',d.title,'authorId',d.author_id,'anchor',d.anchor,'replacement',d.replacement,'resolved',d.resolved,'version',d.version,
   'messages',coalesce((SELECT jsonb_agg(jsonb_build_object('id',m.id::text,'authorId',m.author_id,'body',m.body,'createdAt',m.created_at) ORDER BY m.id) FROM collab.discussion_messages m WHERE m.thread_id=d.id),'[]'::jsonb)) ORDER BY d.created_at,d.id) FROM collab.discussion_threads d WHERE d.id=ANY(threads)),'[]'::jsonb),
 'github',jsonb_build_object('scope','task-history; each approval applies only to its own recorded PR revision',
   'revisions',coalesce((SELECT jsonb_agg(jsonb_build_object('id',j.id,'status',j.status,'changeId',j.change_id,'url',c.url,'headSha',j.admission->'snapshot'->>'headSha','baseSha',j.admission->'snapshot'->>'baseSha','manifestHash',j.manifest_hash,'diffHash',j.manifest->>'diffHash','current',collab_git.pull_release_source(j.id) IS NOT NULL,
    'checks',coalesce((SELECT jsonb_agg(jsonb_build_object('id',k.id,'status',k.status,'policy',k.admission->'policy','evidence',k.evidence,'evidenceHash',k.evidence_hash,'satisfied',k.satisfied,'createdAt',k.created_at) ORDER BY k.created_at,k.id) FROM collab_git.pull_checks_jobs k WHERE k.revision_id=j.id),'[]'::jsonb),
    'releases',coalesce((SELECT jsonb_agg(jsonb_build_object('id',l.id,'action',l.action,'status',l.status,'result',l.result,'failure',l.failure,'createdAt',l.created_at) ORDER BY l.created_at,l.id) FROM collab_git.pull_releases l WHERE l.revision_id=j.id),'[]'::jsonb),
    'reviews',coalesce((SELECT jsonb_agg(jsonb_build_object('id',p.id,'actorId',p.actor_id,'decision',p.decision,'body',p.body,'createdAt',p.created_at) ORDER BY p.sequence) FROM collab_git.pull_reviews p WHERE p.revision_id=j.id),'[]'::jsonb)) ORDER BY j.created_at,j.id) FROM collab_git.pull_revision_jobs j JOIN collab_git.pull_changes c ON c.id=j.change_id WHERE j.id=ANY(revisions)),'[]'::jsonb)),
 'gitlab',coalesce((SELECT jsonb_agg(jsonb_build_object('id',g.id,'sourceId',g.source_id,'resultId',g.result_id,'kind',g.kind,'status',g.status,'evidence',g.result,'failure',g.failure,
   'reviews',coalesce((SELECT jsonb_agg(jsonb_build_object('reviewerId',a.reviewer_id,'planHash',a.plan_hash,'decision',a.decision,'note',a.note,'createdAt',a.created_at) ORDER BY a.created_at,a.reviewer_id) FROM collab.gitlab_reviews a WHERE a.operation_id=g.id),'[]'::jsonb)) ORDER BY g.created_at,g.id) FROM collab.gitlab_operations g WHERE g.id=ANY(gitlab)),'[]'::jsonb),
 'toolSummary',coalesce((SELECT jsonb_agg(x ORDER BY x.name) FROM (SELECT event->>'toolName' AS name,count(*) AS completed,count(*) FILTER(WHERE event->'isError'='true') AS errors
   FROM collab.run_events e CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(e.payload->'events')='array' THEN e.payload->'events' ELSE '[]'::jsonb END) event
   WHERE e.run_id=r.source_run_id AND e.kind='run.output' AND event->>'type'='tool_execution_end' GROUP BY event->>'toolName') x),'[]'::jsonb)
 ) INTO output FROM collab.tasks t JOIN collab.runs run ON run.id=r.source_run_id JOIN collab.workspaces w ON w.id=run.workspace_id
 JOIN collab.repositories repo ON repo.id=w.repository_id JOIN collab.validations v ON v.id=r.validation_id WHERE t.id=r.task_id;
 IF octet_length(output::text)>6291456 THEN RAISE EXCEPTION 'evidence_limit' USING ERRCODE='P0001';END IF;
 RETURN output;
END $$;
REVOKE ALL ON FUNCTION collab.result_evidence_metadata(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.result_evidence_metadata(uuid) TO pi_collab_app;
