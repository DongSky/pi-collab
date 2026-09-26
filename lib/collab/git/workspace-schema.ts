import { z } from "zod";
import { safeSnapshotPath } from "../snapshot-paths";

export const workspaceGitHash = z.string().regex(/^[a-f0-9]{64}$/);
export const sourceSchema = z.object({ runtime: z.literal("docker").optional(), workspaceId: z.uuid(), identity: z.object({ runId: z.uuid(), executorId: z.uuid(), epoch: z.string().regex(/^[1-9][0-9]*$/) }).strict() }).strict();
export const workspaceStageSelection = z.object({ path: z.string().refine(safeSnapshotPath), direction: z.enum(["stage", "unstage"]), hunks: z.union([z.literal("file"), z.array(workspaceGitHash).min(1).max(256)]) }).strict();
export const commitIdentitySchema = z.object({
  operationId: z.uuid(), actorId: z.string().min(1).max(256),
  displayName: z.string().trim().min(1).max(100).refine(value => !/[<>\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/.test(value)),
  requestedAt: z.iso.datetime(), message: z.string().min(1).max(8000).refine(value => value.trim().length > 0 && !/[\x00\r]/.test(value)),
}).strict();
const common = { idempotencyKey: z.uuid(), acknowledge: z.literal(true), revision: workspaceGitHash, expectedRunRevision: z.string().regex(/^[1-9][0-9]{0,17}$/) };
export const workspaceGitInput = z.discriminatedUnion("kind", [
  z.object({ ...common, kind: z.literal("stage"), selections: z.array(workspaceStageSelection).min(1).max(200) }).strict(),
  z.object({ ...common, kind: z.literal("commit"), message: commitIdentitySchema.shape.message }).strict(),
]);
export const workspaceGitActionInput = z.object({ action: z.enum(["cancel", "reconcile"]), reason: z.string().trim().min(10).max(2000), idempotencyKey: z.uuid() }).strict();
export const workspaceGitFileQuery = z.object({ revision: workspaceGitHash, layer: z.enum(["staged", "working"]), path: z.string().refine(safeSnapshotPath) }).strict();
export type WorkspaceGitSource = z.infer<typeof sourceSchema>;
export type WorkspaceStageSelection = z.infer<typeof workspaceStageSelection>;
export type WorkspaceCommitIdentity = z.infer<typeof commitIdentitySchema>;
export type WorkspaceGitInput = z.infer<typeof workspaceGitInput>;
export type WorkspaceGitActionInput = z.infer<typeof workspaceGitActionInput>;
export type WorkspaceGitOperation = { jobId: string; runId: string; kind: "stage" | "commit"; status: "queued" | "running" | "attention" | "applied" | "aborted"; mode: "execute" | "reconcile"; stopRequested: boolean; failure: string | null; createdAt: string; finishedAt: string | null; actorId: string; effect: { phase: string; commit: string | null } | null };
