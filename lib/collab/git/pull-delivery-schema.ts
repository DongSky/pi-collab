import { z } from "zod";
import type { TaskPullResult, TaskPullSnapshot } from "./github-task-pull";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const pullDeliveryRequest = z.object({ idempotencyKey: z.uuid(), requestHash: hash, observationHash: hash,
  acknowledgeContent: z.literal(true), acknowledgeNotification: z.literal(true), acknowledgeVersions: z.literal(true) }).strict();
export const pullDeliveryAction = z.discriminatedUnion("action", [
  z.object({ idempotencyKey: z.uuid(), action: z.literal("cancel"), reason: z.string().trim().min(10).max(2000), acknowledgeUnknown: z.literal(false) }).strict(),
  z.object({ idempotencyKey: z.uuid(), action: z.literal("retire"), reason: z.string().trim().min(20).max(2000), acknowledgeUnknown: z.literal(true) }).strict(),
]);
export type PullDeliveryRecord = { jobId: string; actorId: string; actorName: string;
  status: "queued" | "running" | "created" | "rejected" | "not_created" | "unknown" | "retired"; stopRequested: boolean;
  createdAt: string; finishedAt: string | null; failure: string | null; gateAt: string | null; requestHash: string; resultHash: string | null;
  outcome: TaskPullResult["outcome"] | null; credential: { status: "unrecorded" | TaskPullResult["credential"]["status"]; expiresAt: string | null }; canRetire: boolean;
  changeRequest: { id: string; pullId: string; number: number; nodeId: string; url: string; observations: {
    sequence: number; kind: "creation" | "followup"; sourceSha: string; targetSha: string; evidence: TaskPullSnapshot; evidenceText: string; evidenceHash: string;
  }[] } | null };
export type PullDeliveryContext = { canControl: boolean; canCreate: boolean; occupied: boolean; delivery: PullDeliveryRecord | null };
