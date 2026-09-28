import { z } from "zod";
const uuid = z.uuid();
const sha = z.string().regex(/^[a-f0-9]{40}$/);
// Simplification: allow a local working directory path directly (Codex/Cursor-style),
// instead of requiring a pre-imported repositoryId. The server will import it
// on-the-fly as a lightweight local repository.
export const runInput = z.object({
  repositoryId: uuid.optional(),
  workingDirectory: z.string().trim().min(1).max(1024).optional(),
  baseSha: sha.optional(),
  prompt: z.string().trim().min(1).max(20000),
  expectedVersion: z.number().int().positive(), idempotencyKey: uuid,
  modelProfileId: uuid.optional(), executionKind: z.enum(["ai","terminal"]).default("ai"),
  snapshotId: uuid.optional(), suggestionId: uuid.optional(), editorVersionId: uuid.optional(),
}).strict().refine(
  (v) => (v.repositoryId ? 1 : 0) + (v.workingDirectory ? 1 : 0) === 1,
  { message: "Provide exactly one of repositoryId or workingDirectory" }
);
