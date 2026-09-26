import { z } from "zod";

const common = { reason: z.string().trim().min(10).max(2000), idempotencyKey: z.uuid() };
export const gitlabOperationInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.enum(["import", "sync"]), ...common }).strict(),
  z.object({ kind: z.literal("prepare"), resultId: z.uuid(), ...common }).strict(),
  z.object({ kind: z.literal("publish"), sourceId: z.uuid(), planHash: z.string().regex(/^[a-f0-9]{64}$/), acknowledge: z.literal(true), ...common }).strict(),
  z.object({ kind: z.literal("observe"), sourceId: z.uuid(), ...common }).strict(),
  z.object({ kind: z.enum(["ready", "merge"]), sourceId: z.uuid(), expectedSha: z.string().regex(/^[a-f0-9]{40}$/), ...common }).strict(),
]);

// Shared by browser recovery and the server: a retry preserves the exact intent.
export const gitlabPendingOperation = z.object({
  connectionId: z.uuid(),
  command: gitlabOperationInput,
}).strict();
