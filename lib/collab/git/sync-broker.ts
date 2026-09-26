import { mkdir, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { GitHubError, openGitHubKey } from "./github-credentials";
import { githubAppConfig } from "./github-schema";
import { GitHubReadClient } from "./github-client";
import { downloadGitHubGit } from "./github-pack";
import { abortGitHubSync, applyGitHubSync, classifyGitHubSync, prepareGitHubSync, syncGitInput } from "./github-sync-git";

const claimSchema = z.object({ claimId: z.uuid(), mode: z.enum(["sync", "reconcile"]), job: z.object({ id: z.uuid(), organization_id: z.uuid(), repository_id: z.uuid(),
  connection_id: z.uuid(), github_repository_id: z.string(), target_branch: z.string(), old_sha: z.string(), input: syncGitInput.nullable() }) });
type Hooks = { afterClaim?: (jobId: string) => Promise<void>; afterFetch?: (jobId: string) => Promise<void>; afterIntent?: (jobId: string) => Promise<void>;
  beforeGate?: (jobId: string) => Promise<void>; afterUpdate?: (jobId: string) => Promise<void>; beforeCommit?: (jobId: string) => Promise<void> };
type Options = Hooks & { transport?: typeof fetch; signal?: AbortSignal };
async function transaction<T>(db: PoolClient, work: () => Promise<T>) {
  try { await db.query("BEGIN"); const result = await work(); await db.query("COMMIT"); return result; }
  catch (error) { await db.query("ROLLBACK").catch(() => {}); throw error; }
}
/** Claims one browser-authorized operation using only the dedicated Git role.
 * Every query and final authority gate uses the same pinned SQL connection.
 * Closing it releases the session lock; it never reconnects to repeat an effect.
 * master() is lazy: reconciliation needs neither the Git key nor provider I/O. */
export async function processGitSync(pool: Pool, root: string, master: () => Promise<Buffer>, options: Options = {}) {
  const db = await pool.connect(), lost = new AbortController();
  const signal = AbortSignal.any([lost.signal, options.signal ?? AbortSignal.timeout(300_000), AbortSignal.timeout(300_000)]);
  let claim: z.infer<typeof claimSchema> | undefined;
  const disconnected = () => { lost.abort(); }; db.on("error", disconnected);
  try {
    const raw = (await db.query("SELECT collab_git.claim_sync() AS result")).rows[0].result;
    if (!raw) return null;
    if (raw.attentionJob) return { jobId: z.uuid().parse(raw.attentionJob), status: "attention" };
    claim = claimSchema.parse(raw); const { job, claimId, mode } = claim;
    await db.query("SELECT set_config('application_name',$1,false)", [`pi-collab-git-broker:${job.id}`]);
    await options.afterClaim?.(job.id);
    if (mode === "reconcile") {
      return await transaction(db, async () => {
        const input = (await db.query("SELECT collab_git.gate_sync_reconcile($1,$2) AS result", [job.id, claimId])).rows[0].result;
        if (!input) return (await db.query("SELECT collab_git.fail_sync($1,$2,'github_sync_fetch_abandoned') AS result", [job.id, claimId])).rows[0].result;
        const observed = await abortGitHubSync(root, syncGitInput.parse(input), signal);
        const result = (await db.query("SELECT collab_git.finish_sync($1,$2,$3) AS result", [job.id, claimId, observed])).rows[0].result;
        await options.beforeCommit?.(job.id); return result;
      });
    }
    const connection = (await db.query("SELECT collab_git.begin_sync($1,$2) AS result", [job.id, claimId])).rows[0].result;
    const config = githubAppConfig.parse({ appId: connection.appId, installationId: connection.installationId, accountId: connection.accountId });
    const keyBytes = await master(); let client: GitHubReadClient;
    try { client = new GitHubReadClient(config, openGitHubKey(keyBytes, { ...config, connectionId: job.connection_id, organizationId: job.organization_id }, connection.sealed), options.transport); }
    finally { keyBytes.fill(0); }
    const canonical = await realpath(root), parent = path.join(canonical, "github-syncs"); await mkdir(parent, { recursive: true, mode: 0o700 });
    if ((await lstat(parent)).isSymbolicLink()) throw new GitHubError("github_sync_path_invalid");
    const { evidence } = await client.readGitRepository(job.github_repository_id, (observed, read, deadline) => downloadGitHubGit(path.join(parent, job.id), observed, read, deadline), signal);
    await options.afterFetch?.(job.id);
    if (signal.aborted) throw new GitHubError("github_request_cancelled");
    const classification = await classifyGitHubSync(root, job.repository_id, job.id, job.target_branch, job.old_sha, evidence.defaultBranch, evidence.targetSha, signal);
    if (signal.aborted) throw new GitHubError("github_request_cancelled");
    const admitted = (await db.query("SELECT collab_git.admit_sync_effect($1,$2,$3,$4) AS result", [job.id, claimId, classification, evidence])).rows[0].result;
    if (!admitted.input) return admitted;
    const fixed = syncGitInput.parse(admitted.input); await options.afterIntent?.(job.id);
    await prepareGitHubSync(root, fixed, signal); await options.beforeGate?.(job.id);
    return await transaction(db, async () => {
      const allowed = (await db.query("SELECT collab_git.gate_sync($1,$2) AS result", [job.id, claimId])).rows[0].result;
      if (signal.aborted) throw new GitHubError("github_request_cancelled");
      const observed = allowed ? await applyGitHubSync(root, fixed, signal, { afterUpdate: options.afterUpdate ? () => options.afterUpdate!(job.id) : undefined })
        : await abortGitHubSync(root, fixed, signal);
      const result = (await db.query("SELECT collab_git.finish_sync($1,$2,$3) AS result", [job.id, claimId, observed])).rows[0].result;
      await options.beforeCommit?.(job.id); return result;
    });
  } catch (error) {
    if (claim && !lost.signal.aborted) {
      const domain = error instanceof Error && (error as { code?: string }).code === "P0001" && ["github_sync_cancelled", "github_sync_authority_changed", "github_sync_claim_lost"].includes(error.message) ? error.message : null;
      const failure = error instanceof GitHubError ? error.code : domain ?? "github_sync_broker_failed";
      const result = await db.query("SELECT collab_git.fail_sync($1,$2,$3) AS result", [claim.job.id, claim.claimId, failure]).catch(() => null);
      if (result) return result.rows[0].result;
    }
    // An unknown acknowledgement must be inspected by a later claim/action,
    // never by reconnecting this attempt or starting another fetch/apply.
    throw new GitHubError("github_sync_outcome_unknown");
  } finally { lost.abort(); db.removeListener("error", disconnected); db.release(true); }
}
