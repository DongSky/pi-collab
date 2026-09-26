import { z } from "zod";
const uuid = z.uuid();
export const runInput = z.object({
  repositoryId: uuid, baseSha: z.string().regex(/^[a-f0-9]{40}$/),
  prompt: z.string().trim().min(1).max(20000),
  expectedVersion: z.number().int().positive(), idempotencyKey: uuid,
  modelProfileId: uuid.optional(), executionKind: z.enum(["ai","terminal"]).default("ai"),
  snapshotId: uuid.optional(), suggestionId: uuid.optional(), editorVersionId: uuid.optional(),
}).strict();
