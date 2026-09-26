import { z } from "zod";
import { githubId } from "./github-schema";
export const checkRule = z.object({ name: z.string().trim().min(1).max(200), appId: githubId }).strict();
export const checksConfig = z.object({ version: z.literal(1), required: z.array(checkRule).min(1).max(16), maxAgeSeconds: z.number().int().min(30).max(3600) }).strict()
  .refine(value => new Set(value.required.map(r => JSON.stringify([r.name, r.appId]))).size === value.required.length, "Duplicate check rule");
export type ChecksConfig = z.infer<typeof checksConfig>;
export const checksPolicyInput = z.object({ idempotencyKey: z.uuid(), expectedVersion: z.number().int().nonnegative(), reason: z.string().trim().min(10).max(2000), config: checksConfig }).strict();
export const pullChecksRequest = z.object({ idempotencyKey: z.uuid(), expectedTaskVersion: z.number().int().positive(), expectedPolicyId: z.uuid() }).strict();
export const pullChecksCancel = z.object({ idempotencyKey: z.uuid(), reason: z.string().trim().min(10).max(2000) }).strict();
export const normalizedCheck = z.object({ id: githubId, name: z.string().min(1).max(200), appId: githubId, suiteId: githubId,
  headSha: z.string().regex(/^[a-f0-9]{40}$/), status: z.enum(["queued", "in_progress", "completed", "waiting", "requested", "pending"]),
  conclusion: z.enum(["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "stale", "startup_failure"]).nullable(),
  startedAt: z.iso.datetime().nullable(), completedAt: z.iso.datetime().nullable() }).strict();
export type NormalizedCheck = z.infer<typeof normalizedCheck>;
export function evaluateChecks(config: ChecksConfig, runs: NormalizedCheck[]) {
  return config.required.map(rule => {
    const matches = runs.filter(c => c.name === rule.name && c.appId === rule.appId);
    return { ...rule, checkId: matches.length === 1 ? matches[0].id : null,
      state: matches.length === 0 ? "missing" : matches.length > 1 ? "ambiguous" : matches[0].status !== "completed" ? "pending"
        : matches[0].conclusion === "success" ? "passed" : "failed" };
  });
}
export type ChecksPolicy = { id: string; version: number; config: ChecksConfig; reason: string; actorName: string };
export type PullChecksRecord = { jobId: string; revisionId: string; status: "queued" | "running" | "observed" | "failed" | "cancelled";
  actorName: string; stopRequested: boolean; failure: string | null; evidenceHash: string | null; completedAt: string | null;
  satisfied: boolean | null; eligible: boolean; rules: ReturnType<typeof evaluateChecks> | null; policyId: string };
export type PullChecksContext = { taskVersion: number; canConfigure: boolean; canRequest: boolean; canCancel: boolean; policy: ChecksPolicy | null; jobs: PullChecksRecord[] };
