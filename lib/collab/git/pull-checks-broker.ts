import { setTimeout as delay } from "node:timers/promises";
import type { Pool } from "pg";
import { z } from "zod";
import { GitHubError, openGitHubKey } from "./github-credentials";
import { githubAppConfig } from "./github-schema";
import { githubPushBinding } from "./github-task-target";
import { observedPullIdentity } from "./github-pull-observation";
import { GitHubPullChecksReader, type PullChecksEvidence } from "./github-pull-checks";
import { pullRevisionInput } from "./pull-revision";
import { checksConfig } from "./pull-checks-schema";

const claimSchema = z.object({ jobId: z.uuid(), claimId: z.uuid(), admission: z.object({
  changeId: z.uuid(), organizationId: z.uuid(), repositoryId: z.uuid(), connectionId: z.uuid(),
  installationVersion: z.string().regex(/^[1-9][0-9]*$/), bindingVersion: z.string().regex(/^[1-9][0-9]*$/),
  binding: githubPushBinding, identity: observedPullIdentity,
  observationId: z.uuid(), observationHash: z.string(), snapshot: z.object({}).passthrough(), revisionId: z.uuid(), manifestHash: z.string(), diffHash: z.string(), input: pullRevisionInput,
  policy: z.object({ id: z.uuid(), version: z.number().int().positive(), config: checksConfig }).strict(),
}).strict() }).strict();
type Options = { transport?: typeof fetch; signal?: AbortSignal; afterClaim?: (id: string) => Promise<void>; afterBegin?: (id: string) => Promise<void>;
  beforeFinish?: (id: string, observation: PullChecksEvidence) => Promise<void>; beforeCommit?: (id: string) => Promise<void> };

/** One explicit read per durable request, with pinned SQL ownership and live
 * authority. Publication records exact-head check evidence under the pinned producer policy.
 * A refresh never grants remote merge authority. Recovery never replays an abandoned provider request. */
export async function processPullChecks(pool: Pool, master: () => Promise<Buffer>, options: Options = {}) {
  const db = await pool.connect(), lost = new AbortController(), denied = new AbortController(), monitorStop = new AbortController();
  const signal = AbortSignal.any([lost.signal, denied.signal, options.signal ?? new AbortController().signal, AbortSignal.timeout(180000)]);
  let claim: z.infer<typeof claimSchema> | undefined, monitor: Promise<void> | undefined;
  const disconnected = () => lost.abort(); db.on("error", disconnected);
  const check = () => { if (signal.aborted) throw new GitHubError(denied.signal.aborted ? "pull_checks_authority_changed" : "pull_checks_cancelled"); };
  const stopMonitor = async () => { monitorStop.abort(); await monitor; };
  try {
    check(); const raw = (await db.query("SELECT collab_git.claim_pull_checks() AS result")).rows[0].result;
    if (!raw || raw.recovered) return raw;
    claim = claimSchema.parse(raw); const { jobId, claimId, admission } = claim;
    await db.query("SELECT set_config('application_name',$1,false)", [`pi-collab-pull-checks:${jobId}`]);
    await options.afterClaim?.(jobId); check();
    const connection = (await db.query("SELECT collab_git.begin_pull_checks($1,$2) AS result", [jobId, claimId])).rows[0].result;
    monitor = (async () => {
      while (!monitorStop.signal.aborted && !signal.aborted) {
        try { await delay(500, undefined, { signal: monitorStop.signal }); }
        catch (error) { if (monitorStop.signal.aborted) return; throw error; }
        if (signal.aborted || monitorStop.signal.aborted) break;
        const timeout = new AbortController();
        try {
          const live = (await Promise.race([
            db.query("SELECT collab_git.pull_checks_live($1,$2) AS result", [jobId, claimId]),
            delay(2000, undefined, { signal: timeout.signal }).then((): never => { throw new GitHubError("pull_checks_owner_unavailable"); }),
          ])).rows[0].result;
          if (live !== true) denied.abort();
        } finally { timeout.abort(); }
      }
    })().catch(() => lost.abort());
    await options.afterBegin?.(jobId); check();
    const config = githubAppConfig.parse({ appId: connection.appId, installationId: connection.installationId, accountId: connection.accountId });
    const bytes = await master(); let client: GitHubPullChecksReader;
    try { client = new GitHubPullChecksReader(config, openGitHubKey(bytes, { ...config, connectionId: admission.connectionId, organizationId: admission.organizationId }, connection.sealed), options.transport); }
    finally { bytes.fill(0); }
    check(); const observation = await client.observe(admission.binding, admission.identity, admission.input, signal);
    await stopMonitor(); await options.beforeFinish?.(jobId, observation); check();
    try {
      await db.query("BEGIN"); check();
      const result = (await db.query("SELECT collab_git.finish_pull_checks($1,$2,$3) AS result", [jobId, claimId, JSON.stringify(observation)])).rows[0].result;
      await options.beforeCommit?.(jobId); check();
      try { await db.query("COMMIT"); } catch (error) { lost.abort(); throw error; }
      return result;
    } catch (error) { if (!lost.signal.aborted) await db.query("ROLLBACK").catch(() => lost.abort()); throw error; }
  } catch (error) {
    await stopMonitor();
    if (claim && !lost.signal.aborted) {
      const domain = error instanceof Error && (error as { code?: string }).code === "P0001" && /^(?:pull_checks|invalid_pull_checks)_[a-z_]+$/.test(error.message) ? error.message : null;
      const code = denied.signal.aborted ? "pull_checks_authority_changed" : error instanceof GitHubError ? error.code : domain ?? "pull_checks_broker_failed";
      const failed = await db.query("SELECT collab_git.fail_pull_checks($1,$2,$3) AS result", [claim.jobId, claim.claimId, code]).catch(() => null);
      if (failed) return failed.rows[0].result;
    }
    throw new GitHubError("pull_checks_outcome_unknown");
  } finally { monitorStop.abort(); lost.abort(); await monitor; db.removeListener("error", disconnected); db.release(true); }
}
