import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import type { Pool } from "pg";
import { z } from "zod";
import { GitHubError, openGitHubKey } from "./github-credentials";
import { githubAppConfig } from "./github-schema";
import { githubPushBinding } from "./github-task-target";
import { GitHubTaskPullClient, PreparedTaskPull, taskPullIntent, type TaskPullResult } from "./github-task-pull";

const claimSchema = z.object({ jobId: z.uuid(), claimId: z.uuid(), organizationId: z.uuid(), connectionId: z.uuid(),
  attempt: z.object({ intent: taskPullIntent, binding: githubPushBinding }).passthrough(), requestText: z.string().max(200000) }).strict();
type Options = { transport?: typeof fetch; signal?: AbortSignal; afterClaim?: (id: string) => Promise<void>;
  afterBegin?: (id: string) => Promise<void>; beforeGateCommit?: (id: string) => Promise<void>; afterGateCommit?: (id: string) => Promise<void>;
  afterExecute?: (id: string, result: TaskPullResult) => Promise<void>; beforeFinishCommit?: (id: string) => Promise<void> };

/** One pinned SQL owner, one positively committed final authority decision and
 * at most one provider create POST. Losing a COMMIT reply discards ownership;
 * the next worker can classify the durable record but cannot execute it again. */
export async function processTaskPullDelivery(pool: Pool, master: () => Promise<Buffer>, options: Options = {}) {
  const db = await pool.connect(), lost = new AbortController(), denied = new AbortController(), monitorStop = new AbortController();
  const signal = AbortSignal.any([lost.signal, denied.signal, options.signal ?? new AbortController().signal, AbortSignal.timeout(240000)]);
  let claim: z.infer<typeof claimSchema> | undefined, monitor: Promise<void> | undefined;
  const disconnected = () => lost.abort(); db.on("error", disconnected);
  const check = () => { if (signal.aborted) throw new GitHubError(denied.signal.aborted ? "task_pull_authority_changed" : "task_pull_cancelled"); };
  const stopMonitor = async () => { monitorStop.abort(); await monitor; };
  const commit = async () => { try { await db.query("COMMIT"); } catch (error) { lost.abort(); throw error; } };
  try {
    check(); const raw = (await db.query("SELECT collab_git.claim_pull_delivery() AS result")).rows[0].result;
    if (!raw || raw.recovered) return raw;
    claim = claimSchema.parse(raw); const { jobId, claimId } = claim;
    const prepared = PreparedTaskPull.prepare(claim.attempt.binding, claim.attempt.intent);
    if (jobId !== prepared.attempt.intent.operationId || !isDeepStrictEqual(prepared.attempt, claim.attempt)
      || JSON.stringify(prepared.attempt.request) !== claim.requestText) throw new GitHubError("task_pull_evidence_mismatch");
    await db.query("SELECT set_config('application_name',$1,false)", ["pi-collab-pull-delivery:" + jobId]);
    await options.afterClaim?.(jobId); check();
    if ((await db.query("SELECT collab_git.pull_delivery_live($1,$2) AS result", [jobId, claimId])).rows[0].result !== true) throw new GitHubError("task_pull_authority_changed");
    monitor = (async () => {
      while (!monitorStop.signal.aborted && !signal.aborted) {
        try { await delay(500, undefined, { signal: monitorStop.signal }); }
        catch (error) { if (monitorStop.signal.aborted) return; throw error; }
        if (signal.aborted || monitorStop.signal.aborted) break;
        const timeout = new AbortController();
        try {
          const live = (await Promise.race([
            db.query("SELECT collab_git.pull_delivery_live($1,$2) AS result", [jobId, claimId]),
            delay(2000, undefined, { signal: timeout.signal }).then((): never => { throw new GitHubError("task_pull_owner_unavailable"); }),
          ])).rows[0].result;
          if (live !== true) denied.abort();
        } finally { timeout.abort(); }
      }
    })().catch(() => lost.abort());
    check(); const connection = (await db.query("SELECT collab_git.begin_pull_delivery($1,$2,$3,$4) AS result",
      [jobId, claimId, prepared.attempt, claim.requestText])).rows[0].result;
    await options.afterBegin?.(jobId); check();
    const config = githubAppConfig.parse({ appId: connection.appId, installationId: connection.installationId, accountId: connection.accountId });
    const bytes = await master(); let client: GitHubTaskPullClient;
    try { client = new GitHubTaskPullClient(config, openGitHubKey(bytes, { ...config, connectionId: claim.connectionId, organizationId: claim.organizationId }, connection.sealed), options.transport); }
    finally { bytes.fill(0); }
    check(); const result = await client.execute(prepared, async value => {
      await stopMonitor(); check();
      try {
        await db.query("BEGIN"); check();
        const allowed = (await db.query("SELECT collab_git.gate_pull_delivery($1,$2,$3,$4,$5) AS result",
          [jobId, claimId, value.attempt, JSON.stringify(value.evidence), value.evidenceHash])).rows[0].result;
        if (allowed !== true) throw new GitHubError("task_pull_authority_changed");
        await options.beforeGateCommit?.(jobId); check(); await commit();
        await options.afterGateCommit?.(jobId); check(); return true;
      } catch (error) { if (!lost.signal.aborted) await db.query("ROLLBACK").catch(() => lost.abort()); throw error; }
    }, signal);
    await stopMonitor(); await options.afterExecute?.(jobId, result);
    // Current revocation cannot erase an already observed remote effect.
    if (lost.signal.aborted) throw new GitHubError("task_pull_owner_unavailable");
    try {
      await db.query("BEGIN");
      const settled = (await db.query("SELECT collab_git.finish_pull_delivery($1,$2,$3) AS result", [jobId, claimId, JSON.stringify(result)])).rows[0].result;
      await options.beforeFinishCommit?.(jobId); await commit(); return settled;
    } catch (error) { if (!lost.signal.aborted) await db.query("ROLLBACK").catch(() => lost.abort()); throw error; }
  } catch (error) {
    await stopMonitor();
    if (claim && !lost.signal.aborted) {
      const domain = error instanceof Error && (error as { code?: string }).code === "P0001" && /^(?:task_pull|invalid_task_pull)_[a-z_]+$/.test(error.message) ? error.message : null;
      const code = denied.signal.aborted ? "task_pull_authority_changed" : error instanceof GitHubError ? error.code : domain ?? "task_pull_broker_failed";
      const failed = await db.query("SELECT collab_git.fail_pull_delivery($1,$2,$3) AS result", [claim.jobId, claim.claimId, code]).catch(() => null);
      if (failed) return failed.rows[0].result;
    }
    throw new GitHubError("task_pull_outcome_unknown");
  } finally { monitorStop.abort(); lost.abort(); await monitor; db.removeListener("error", disconnected); db.release(true); }
}
