import { z } from "zod";
import { asUser } from "./database";
import { projectRole, uuid } from "./projects";
import { DomainError } from "./policy";

export const integrationPolicyInput = z.object({
  repositoryId: z.uuid(), profileId: z.uuid(), requiredApprovals: z.number().int().min(1).max(3),
  reviewerApprovals: z.boolean(), expectedVersion: z.number().int().min(0).max(2147483646),
  reason: z.string().trim().min(10).max(2000), idempotencyKey: z.uuid(),
}).strict();
export const integrationReviewInput = z.object({
  revisionHash: z.string().regex(/^[a-f0-9]{64}$/), expectedVersion: z.number().int().min(0).max(2147483646),
  decision: z.enum(["approve", "request_changes", "withdraw"]), note: z.string().trim().min(10).max(4000), idempotencyKey: z.uuid(),
}).strict();
export function listIntegrationPolicies(userId: string, projectId: string) {
  uuid.parse(projectId);
  return asUser(userId, async db => {
    await projectRole(db, projectId, "project.read");
    const policies = (await db.query(`SELECT DISTINCT ON (p.repository_id,p.target_branch) p.id,p.repository_id,p.target_branch,p.version,p.profile_id,p.required_approvals,p.reviewer_approvals,p.reason,p.created_at,v.name AS profile_name,v.config
      FROM collab.integration_policies p JOIN collab.validation_profiles v ON v.id=p.profile_id JOIN collab.repositories repo ON repo.id=p.repository_id AND repo.default_branch=p.target_branch
      WHERE p.project_id=$1 ORDER BY p.repository_id,p.target_branch,p.version DESC`, [projectId])).rows;
    return { policies };
  });
}
export function publishIntegrationPolicy(userId: string, projectId: string, raw: z.infer<typeof integrationPolicyInput>) {
  uuid.parse(projectId); const input = integrationPolicyInput.parse(raw);
  return asUser(userId, async db => {
    await projectRole(db, projectId, "project.read");
    if (!(await db.query("SELECT 1 FROM collab.repositories WHERE id=$1 AND project_id=$2", [input.repositoryId, projectId])).rowCount) throw new DomainError("not_found", "仓库不存在或不可访问。", 404);
    return (await db.query("SELECT collab.publish_integration_policy($1,$2,$3,$4,$5,$6,$7) AS result", [input.repositoryId,input.profileId,input.requiredApprovals,input.reviewerApprovals,input.expectedVersion,input.reason,input.idempotencyKey])).rows[0].result;
  });
}
export function submitIntegrationReview(userId: string, integrationId: string, raw: z.infer<typeof integrationReviewInput>) {
  uuid.parse(integrationId); const input = integrationReviewInput.parse(raw);
  return asUser(userId, async db => (await db.query("SELECT collab.submit_integration_review($1,$2,$3,$4,$5,$6) AS result", [integrationId,input.revisionHash,input.expectedVersion,input.decision,input.note,input.idempotencyKey])).rows[0].result);
}
