import { z } from "zod";
import { integrationMergeSchema, integrationSourcesSchema } from "./integration-schema";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const conflictFile = z.object({
  path: z.string().min(1).max(1024), base: sha.nullable(), ours: sha.nullable(), theirs: sha.nullable(),
}).strict().refine(file => file.base !== null || file.ours !== null || file.theirs !== null);

/** Trusted admission input for a future durable resolution task. No fields
 * here grant permissions; the supervisor must obtain them from the database. */
export const resolutionInputSchema = z.object({
  version: z.literal(1), taskId: z.uuid(), integrationId: z.uuid(), inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  repositoryId: z.uuid(), targetBranch: z.string().min(1).max(1024), targetSha: sha, profileId: z.uuid(), policyId: z.uuid(),
  sources: integrationSourcesSchema,
  merges: z.array(integrationMergeSchema).max(31),
  conflict: z.object({ resultId: z.uuid(), files: z.array(conflictFile).min(1).max(256) }).strict(),
}).strict().superRefine((input, ctx) => {
  const index = input.sources.findIndex(source => source.resultId === input.conflict.resultId);
  if (index < 0 || input.sources.some(source => source.taskId === input.taskId) || input.merges.length !== index || input.merges.some((merge, i) => merge.resultId !== input.sources[i].resultId)
    || new Set(input.conflict.files.map(file => file.path)).size !== input.conflict.files.length)
    ctx.addIssue({ code: "custom", message: "integration_resolution_input_invalid" });
});
export type ResolutionInput = z.infer<typeof resolutionInputSchema>;
