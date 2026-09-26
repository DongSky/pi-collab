import { z } from "zod";
import type { TaskPullAttempt, TaskPullIdentity, TaskPullPreflight } from "./github-task-pull";
import type { GitHubPushBinding } from "./github-task-target";

export const pullProposalRequest = z.object({ idempotencyKey: z.uuid(), expectedTaskVersion: z.number().int().min(1).max(999999999),
  title: z.string().trim().min(1).max(256).regex(/^[^\x00-\x1f\x7f]+$/),
  body: z.string().min(1).max(48000).refine(value => !value.includes("\0") && new TextEncoder().encode(value).length <= 59000),
}).strict();
export const pullProposalCancel = z.object({ idempotencyKey: z.uuid(), reason: z.string().trim().min(10).max(2000) }).strict();
export type PullProposalObservation = { target: TaskPullPreflight; existing: TaskPullIdentity[]; tokenExpiresAt: string; tokenRevoked: true };
export type PullProposalRecord = { jobId: string; deliveryId: string; actorId: string; actorName: string; status: "queued" | "running" | "ready" | "existing" | "failed" | "cancelled";
  stopRequested: boolean; createdAt: string; finishedAt: string | null; failure: string | null; title: string; body: string; taskVersion: number;
  source: { deliveryId: string; repositoryId: string; taskId: string; workspaceId: string; headSha: string; manifestHash: string; binding: GitHubPushBinding };
  observation: PullProposalObservation | null; observationText: string | null; observationHash: string | null; attempt: TaskPullAttempt | null; requestText: string | null; valid: boolean };
export type PullProposalContext = { taskVersion: number; canRequest: boolean; canCancel: boolean; proposals: PullProposalRecord[] };
