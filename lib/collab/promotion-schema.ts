import { z } from "zod";

const sha = z.string().regex(/^[a-f0-9]{40}$/), hash = z.string().regex(/^[a-f0-9]{64}$/);
/** Trusted supervisor input, never a browser's proposed Git operation. */
export const promotionInputSchema = z.object({
  version: z.literal(1), promotionId: z.uuid(), integrationId: z.uuid(), repositoryId: z.uuid(),
  requestedAt: z.iso.datetime({ precision: 3 }).refine(value => Date.parse(value) >= 0),
  targetBranch: z.string().min(1).max(240).refine(value => !/[\x00-\x20\x7f]/.test(value)),
  targetSha: sha, candidateSha: sha, candidateTree: sha, inputHash: hash, revisionHash: hash,
  policyId: z.uuid(), profileId: z.uuid(), manifestHash: hash, worktreeCommit: sha,
}).strict();
export type PromotionInput = z.infer<typeof promotionInputSchema>;
export type PromotionDecision = "absent" | "prepared" | "applied" | "aborted";
export interface PromotionObservation {
  decision: PromotionDecision; receiptRef: string; receiptOid: string | null;
  promotionSha: string; applicationEvidence: "receipt" | "target" | "ancestry" | null;
  targetSha: string | null; targetMatchesExpected: boolean; appliedTargetCurrent: boolean;
}

export const promotionRequestSchema = z.object({
  revisionHash: hash, acknowledgeExcluded: z.literal(true), reason: z.string().trim().min(10).max(2000), idempotencyKey: z.uuid(),
}).strict();
export const promotionActionSchema = z.object({
  action: z.enum(["cancel", "reconcile"]), reason: z.string().trim().min(10).max(2000), idempotencyKey: z.uuid(),
}).strict();
export interface PromotionClaim {
  id: string; executorId: string; epoch: string; input: PromotionInput; promotionSha: string; mode: "prepare" | "reconcile";
}
