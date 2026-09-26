import { z } from "zod";
import type { PullObservation } from "./github-pull-observation";
import type { TaskPullIdentity, TaskPullSnapshot } from "./github-task-pull";
export const pullObservationRequest = z.object({ idempotencyKey: z.uuid(), expectedTaskVersion: z.number().int().positive(),
  expectedObservationVersion: z.string().regex(/^(0|[1-9][0-9]{0,17})$/) }).strict();
export const pullObservationCancel = z.object({ idempotencyKey: z.uuid(), reason: z.string().trim().min(10).max(2000) }).strict();
export type PullObservationRecord = { jobId: string; changeId: string; actorId: string; actorName: string; status: "queued" | "running" | "observed" | "failed" | "cancelled";
  stopRequested: boolean; createdAt: string; finishedAt: string | null; failure: string | null; observationVersion: string | null;
  observation: PullObservation | null; observationText: string | null; observationHash: string | null };
export type PullObservationContext = { taskVersion: number; observationVersion: string; canRequest: boolean; canCancel: boolean; identity: TaskPullIdentity;
  initial: TaskPullSnapshot; latest: PullObservationRecord | null; jobs: PullObservationRecord[] };
