import { z } from "zod";
import type { ValidationConfig } from "./validation-config";
import type { ValidationEvidence } from "./runtime/validation";
export const integrationInput = z.object({ repositoryId: z.uuid(), targetSha: z.string().regex(/^[a-f0-9]{40}$/), resultIds: z.array(z.uuid()).min(1).max(32).refine(ids=>new Set(ids).size===ids.length), profileId: z.uuid(), expectedPolicyId: z.uuid().nullable().optional(), idempotencyKey: z.uuid() }).strict();
export const integrationCancelInput = z.object({ reason: z.string().trim().min(10).max(2000), idempotencyKey: z.uuid() }).strict();
const commit = z.string().regex(/^[a-f0-9]{40}$/);
export const integrationSourceSchema = z.object({
  resultId: z.uuid(), taskId: z.uuid(), snapshotId: z.uuid(), manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
  worktreeCommit: commit, baseSha: commit, dependencyResultIds: z.array(z.uuid()).max(32),
}).strict();
export const integrationSourcesSchema = z.array(integrationSourceSchema).min(1).max(32).superRefine((sources, ctx) => {
  const results = new Set<string>(), tasks = new Set<string>();
  for (const source of sources) {
    if (results.has(source.resultId) || tasks.has(source.taskId) || new Set(source.dependencyResultIds).size !== source.dependencyResultIds.length
      || source.dependencyResultIds.some(id => !results.has(id))) ctx.addIssue({ code: "custom", message: "integration_input_order" });
    results.add(source.resultId); tasks.add(source.taskId);
  }
});
export const integrationMergeSchema = z.object({ resultId: z.uuid(), sourceCommit: commit, mergedCommit: commit, tree: commit }).strict();
export type IntegrationSource = z.infer<typeof integrationSourceSchema>;
export interface IntegrationClaim {
  runtime?: "native" | "docker";
  id: string; executorId: string; epoch: string; repositoryId: string; targetBranch: string; targetSha: string; inputHash: string;
  profileId: string; checkId: string; config: ValidationConfig; sources: IntegrationSource[];
}
export interface MergeConflict { path: string; base: string | null; ours: string | null; theirs: string | null; }
export interface IntegrationEvidence {
  version: 1; integrationId: string; repositoryId: string; targetBranch: string; targetSha: string; inputHash: string;
  sources: IntegrationSource[]; merges: { resultId: string; sourceCommit: string; mergedCommit: string; tree: string }[];
  conflict: { resultId: string; files: MergeConflict[] } | null; candidateCommit: string | null;
  snapshot: { id: string; manifestHash: string; worktreeCommit: string; excluded: { path: string; reason: string }[] } | null;
  validation: ValidationEvidence | null;
  outcome: "checked" | "conflicted" | "check_failed" | "cancelled" | "unknown";
}
