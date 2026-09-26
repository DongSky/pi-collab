import { z } from "zod";
import type { TaskPushOutcome } from "./task-push-protocol";
export const pushDeliveryRequest = z.object({ idempotencyKey: z.uuid(), manifestHash: z.string().regex(/^[a-f0-9]{64}$/), acknowledgePush: z.literal(true) }).strict();
export const pushDeliveryAction = z.discriminatedUnion("action", [
  z.object({ idempotencyKey: z.uuid(), action: z.literal("cancel"), reason: z.string().trim().min(10).max(2000), acknowledgeUnknown: z.literal(false) }).strict(),
  z.object({ idempotencyKey: z.uuid(), action: z.literal("retire"), reason: z.string().trim().min(20).max(2000), acknowledgeUnknown: z.literal(true) }).strict(),
]);
export type PushDeliveryRecord = { jobId: string; confirmationId: string; previewId: string; actorId: string;
  status: "queued" | "running" | "acknowledged" | "rejected" | "not_sent" | "unknown" | "retired"; stopRequested: boolean;
  createdAt: string; finishedAt: string | null; failure: string | null; gateAt: string | null; requestHash: string | null;
  outcome: TaskPushOutcome | null; credential: { status: "unrecorded" | "not_requested" | "issuance_unconfirmed" | "revoked" | "revocation_unconfirmed"; expiresAt: string | null }; canRetire: boolean };
