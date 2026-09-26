import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import type { Pool } from "pg";
import { z } from "zod";
import { GitHubError, openGitHubKey } from "./github-credentials";
import { githubAppConfig } from "./github-schema";
import { githubPushBinding, GitHubTaskPushClient, type GitHubPushResult } from "./github-task-push";
import { prepareExportedTaskPush } from "./task-push-export";
import { taskPushIntent } from "./task-push-protocol";

const claimSchema = z.object({ jobId: z.uuid(), claimId: z.uuid(), organizationId: z.uuid(), connectionId: z.uuid(),
  previewId: z.uuid(), manifestHash: z.string().regex(/^[a-f0-9]{64}$/), binding: githubPushBinding, intent: taskPushIntent }).strict();
type Options = { transport?: typeof fetch; signal?: AbortSignal; afterClaim?: (id: string) => Promise<void>;
  afterBegin?: (id: string) => Promise<void>; beforeGateCommit?: (id: string) => Promise<void>; afterGateCommit?: (id: string) => Promise<void>;
  afterExecute?: (id: string, result: GitHubPushResult) => Promise<void>; beforeFinishCommit?: (id: string) => Promise<void> };

/** A pinned SQL session owns one immutable attempt. No reconnect or replay is
 * permitted. A positively acknowledged gate COMMIT must precede the single
 * receive request; losing SQL after the gate leaves its destination occupied. */
export async function processTaskPushDelivery(pool: Pool, root: string, master: () => Promise<Buffer>, options: Options = {}) {
  const db = await pool.connect(), lost = new AbortController(), denied = new AbortController(), monitorStop = new AbortController();
  const signal = AbortSignal.any([lost.signal, denied.signal, options.signal ?? new AbortController().signal, AbortSignal.timeout(420000)]);
  let claim: z.infer<typeof claimSchema> | undefined, monitor: Promise<void> | undefined;
  const disconnected = () => lost.abort(); db.on("error", disconnected);
  const check = () => { if (signal.aborted) throw new GitHubError(denied.signal.aborted ? "task_push_authority_changed" : "task_push_cancelled"); };
  const stopMonitor = async () => { monitorStop.abort(); await monitor; };
  // An uncertain COMMIT must discard this session. Even successful rollback
  // cannot prove whether the preceding transaction committed.
  const commit = async () => { try { await db.query("COMMIT"); } catch (error) { lost.abort(); throw error; } };
  try {
    check(); const raw = (await db.query("SELECT collab_git.claim_task_push_delivery() AS result")).rows[0].result;
    if (!raw || raw.recovered) return raw;
    claim = claimSchema.parse(raw); const { jobId, claimId } = claim;
    if (jobId !== claim.intent.operationId || claim.binding.repositoryId !== claim.intent.repositoryId) throw new GitHubError("task_push_evidence_mismatch");
    await db.query("SELECT set_config('application_name',$1,false)", [`pi-collab-push-delivery:${jobId}`]);
    await options.afterClaim?.(jobId); check();
    if ((await db.query("SELECT collab_git.task_push_delivery_live($1,$2) AS result", [jobId, claimId])).rows[0].result !== true) throw new GitHubError("task_push_authority_changed");
    monitor = (async () => {
      while (!monitorStop.signal.aborted && !signal.aborted) {
        try { await delay(500, undefined, { signal: monitorStop.signal }); }
        catch (error) { if (monitorStop.signal.aborted) return; throw error; }
        if (signal.aborted || monitorStop.signal.aborted) break;
        const timeout = new AbortController();
        try {
          const live = (await Promise.race([
            db.query("SELECT collab_git.task_push_delivery_live($1,$2) AS result", [jobId, claimId]),
            delay(2000, undefined, { signal: timeout.signal }).then((): never => { throw new GitHubError("task_push_owner_unavailable"); }),
          ])).rows[0].result;
          if (live !== true) denied.abort();
        } finally { timeout.abort(); }
      }
    })().catch(() => lost.abort());
    // Verify and prepare broker-owned bytes before opening any credential.
    const prepared = await prepareExportedTaskPush(root, claim.previewId, claim.manifestHash, signal);
    const intent = Object.fromEntries(Object.keys(claim.intent).map(key => [key, prepared.attempt[key as keyof typeof prepared.attempt]]));
    if (!isDeepStrictEqual(intent, claim.intent)) throw new GitHubError("task_push_evidence_mismatch");
    check(); const connection = (await db.query("SELECT collab_git.begin_task_push_delivery($1,$2,$3) AS result", [jobId, claimId, prepared.attempt])).rows[0].result;
    await options.afterBegin?.(jobId); check();
    const config = githubAppConfig.parse({ appId: connection.appId, installationId: connection.installationId, accountId: connection.accountId });
    const bytes = await master(); let client: GitHubTaskPushClient;
    try { client = new GitHubTaskPushClient(config, openGitHubKey(bytes, { ...config, connectionId: claim.connectionId, organizationId: claim.organizationId }, connection.sealed), options.transport); }
    finally { bytes.fill(0); }
    check(); const result = await client.execute(prepared, claim.binding, async value => {
      await stopMonitor(); check();
      try {
        await db.query("BEGIN"); check();
        const allowed = (await db.query("SELECT collab_git.gate_task_push_delivery($1,$2,$3,$4,$5) AS result",
          [jobId, claimId, value.attempt, JSON.stringify(value.evidence), value.evidenceHash])).rows[0].result;
        if (allowed !== true) throw new GitHubError("task_push_authority_changed");
        await options.beforeGateCommit?.(jobId); check(); await commit();
        await options.afterGateCommit?.(jobId); check(); return true;
      } catch (error) { if (!lost.signal.aborted) await db.query("ROLLBACK").catch(() => lost.abort()); throw error; }
    }, signal);
    await stopMonitor(); await options.afterExecute?.(jobId, result);
    // Cancellation or permission loss cannot erase the independently observed
    // Git result or credential cleanup. Only lost SQL ownership blocks recording.
    if (lost.signal.aborted) throw new GitHubError("task_push_owner_unavailable");
    try {
      await db.query("BEGIN");
      const settled = (await db.query("SELECT collab_git.finish_task_push_delivery($1,$2,$3) AS result", [jobId, claimId, result])).rows[0].result;
      await options.beforeFinishCommit?.(jobId); await commit(); return settled;
    } catch (error) { if (!lost.signal.aborted) await db.query("ROLLBACK").catch(() => lost.abort()); throw error; }
  } catch (error) {
    await stopMonitor();
    if (claim && !lost.signal.aborted) {
      const domain = error instanceof Error && (error as { code?: string }).code === "P0001" && /^task_push_[a-z_]+$/.test(error.message) ? error.message : null;
      const code = denied.signal.aborted ? "task_push_authority_changed" : error instanceof GitHubError ? error.code : domain ?? "task_push_broker_failed";
      const failed = await db.query("SELECT collab_git.fail_task_push_delivery($1,$2,$3) AS result", [claim.jobId, claim.claimId, code]).catch(() => null);
      if (failed) return failed.rows[0].result;
    }
    throw new GitHubError("task_push_outcome_unknown");
  } finally { monitorStop.abort(); lost.abort(); await monitor; db.removeListener("error", disconnected); db.release(true); }
}
