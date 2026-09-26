import { z } from "zod";
export const subtaskProposal = z.object({ title: z.string().trim().min(1).max(200), description: z.string().max(10000), acceptance: z.string().trim().min(1).max(10000), prompt: z.string().trim().min(1).max(10000), idempotencyKey: z.uuid() }).strict();
export const subtaskDecision = z.object({ decision: z.enum(["accept", "reject"]), expectedVersion: z.number().int().positive(), acknowledge: z.boolean(), reason: z.string().trim().min(10).max(2000), idempotencyKey: z.uuid() }).strict();
export const subtaskAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("adopt"), childTaskId: z.uuid(), resultId: z.uuid(), expectedVersion: z.number().int().positive(), reason: z.string().trim().min(10).max(2000), idempotencyKey: z.uuid() }).strict(),
  z.object({ action: z.literal("stop"), reason: z.string().trim().min(10).max(2000), idempotencyKey: z.uuid() }).strict(),
]);
export const subtaskPolicy = z.object({ expectedVersion: z.number().int().nonnegative(), concurrentChildren: z.number().int().min(1).max(16), descendants: z.number().int().min(1).max(64), depth: z.number().int().min(1).max(4), reason: z.string().trim().min(10).max(2000), idempotencyKey: z.uuid() }).strict();
export type SubtaskContext = {
  historyTruncated: boolean; taskVersion: number; rootTaskId: string; canManage: boolean; canAct: boolean;
  parent: null | { taskId: string; title: string; runId: string; depth: number };
  policy: { version: number; concurrentChildren: number; descendants: number; depth: number };
  proposals: { id: string; parentRunId: string; authorId: string; sourceKind: string; version: number; status: string; request: z.infer<typeof subtaskProposal>; note: string | null; canAccept: boolean; modelId: string | null; modelName: string | null; runtime: string; baseSha: string }[];
  children: { taskId: string; title: string; parentRunId: string; depth: number; ownerId: string; status: string; adoptedResultId: string | null;
    run: null | { id: string; status: string; workspaceId: string; runtime: string; quotaAvailable: boolean };
    result: null | { id: string; version: number; worktreeCommit: string; snapshotId: string; validationId: string; manifestHash: string; note: string; valid: boolean } }[];
};
