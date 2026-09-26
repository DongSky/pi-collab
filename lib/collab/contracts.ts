import { compareContracts } from "./contract-compatibility";
import { asUser } from "./database";
import { uuid } from "./projects";
import { DomainError } from "./policy";
import { proposalInput, decisionInput, publishContractInput } from "./contract-schema";
import type { z } from "zod";
export function proposeContract(userId: string, taskId: string, raw: z.infer<typeof proposalInput>) {
  uuid.parse(taskId); const input = proposalInput.parse(raw);
  return asUser(userId, async db => (await db.query("SELECT collab.propose_contract($1,$2,$3,$4,$5,$6,$7) AS result", [taskId, input.repositoryId, input.key, input.parentRevisionId, input.content, input.affectedTaskIds, input.idempotencyKey])).rows[0].result);
}
export function decideContract(userId: string, proposalId: string, raw: z.infer<typeof decisionInput>) {
  uuid.parse(proposalId); const input = decisionInput.parse(raw);
  return asUser(userId, async db => (await db.query("SELECT collab.decide_contract($1,$2,$3,$4,$5,$6) AS result", [proposalId, input.taskId, input.expectedVersion, input.decision, input.note, input.idempotencyKey])).rows[0].result);
}
export function publishContract(userId: string, proposalId: string, raw: z.infer<typeof publishContractInput>) {
  uuid.parse(proposalId); const input = publishContractInput.parse(raw);
  return asUser(userId, async db => (await db.query("SELECT collab.publish_contract($1,$2,$3) AS result", [proposalId, input.idempotencyKey, input.overrideReason])).rows[0].result);
}
export function taskContracts(userId: string, taskId: string) {
  uuid.parse(taskId);
  return asUser(userId, async db => {
    if (!(await db.query("SELECT 1 FROM collab.tasks WHERE id=$1", [taskId])).rowCount) throw new DomainError("not_found", "任务不存在或不可访问。", 404);
    const contracts = (await db.query(`SELECT c.*,v.body,v.body_hash,v.approvals,v.overridden_tasks,v.override_reason,v.published_by,v.created_at
      FROM collab.contracts c LEFT JOIN collab.contract_revisions v ON v.id=c.current_revision_id WHERE c.producer_task_id=$1 OR c.id IN (SELECT collab.required_contracts($1)) ORDER BY c.key LIMIT 100`, [taskId])).rows;
    const proposals = (await db.query(`SELECT parent.body AS parent_body,p.id,p.contract_id,p.parent_revision_id,p.content,p.proposed_by,p.source_run_id,p.source_epoch::text,p.created_at,c.key,c.repository_id,c.producer_task_id,
      v.id AS published_revision_id,v.override_reason,COALESCE(v.overridden_tasks,'{}'::uuid[]) AS overridden_tasks,c.current_revision_id IS DISTINCT FROM p.parent_revision_id AS stale,CASE WHEN v.id IS NOT NULL THEN v.approvals ELSE collab.contract_approvals(p.id) END AS approvals,
      (SELECT jsonb_object_agg(t.id,t.title) FROM collab.contract_proposal_tasks pt JOIN collab.tasks t ON t.id=pt.task_id WHERE pt.proposal_id=p.id) AS task_names
      FROM collab.contract_proposals p JOIN collab.contracts c ON c.id=p.contract_id LEFT JOIN collab.contract_revisions v ON v.proposal_id=p.id LEFT JOIN collab.contract_revisions parent ON parent.id=p.parent_revision_id
      WHERE c.producer_task_id=$1 OR EXISTS(SELECT 1 FROM collab.contract_proposal_tasks WHERE proposal_id=p.id AND task_id=$1) ORDER BY p.created_at DESC,p.id LIMIT 50`, [taskId])).rows;
    return { contracts, proposals: proposals.map(({parent_body,...p}) => ({...p,compatibilityReport:compareContracts(parent_body??null,p.content)})) };
  });
}
export function runContracts(userId: string, runId: string) {
  uuid.parse(runId);
  return asUser(userId, async db => {
    const run = (await db.query("SELECT id,collab.run_dependency_state(id) AS dependency_state FROM collab.runs WHERE id=$1", [runId])).rows[0];
    if (!run) throw new DomainError("not_found", "运行不存在或不可访问。", 404);
    return { run, contracts: (await db.query(`SELECT c.key,rc.contract_id,rc.revision_id,v.version,v.body,v.body_hash,c.current_revision_id=rc.revision_id AS is_current
      FROM collab.run_contracts rc JOIN collab.contracts c ON c.id=rc.contract_id JOIN collab.contract_revisions v ON v.id=rc.revision_id WHERE rc.run_id=$1 ORDER BY c.id`, [runId])).rows };
  });
}
export function contractRevision(userId: string, revisionId: string) {
  uuid.parse(revisionId);
  return asUser(userId, async db => {
    const revision = (await db.query("SELECT v.*,c.key,c.repository_id,c.producer_task_id FROM collab.contract_revisions v JOIN collab.contracts c ON c.id=v.contract_id WHERE v.id=$1", [revisionId])).rows[0];
    if (!revision) throw new DomainError("not_found", "契约版本不存在或不可访问。", 404);
    return { revision };
  });
}
