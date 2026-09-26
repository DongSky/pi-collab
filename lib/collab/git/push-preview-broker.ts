import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import type { Pool } from "pg";
import { z } from "zod";
import { GitHubError, openGitHubKey } from "./github-credentials";
import { githubAppConfig } from "./github-schema";
import { GitHubReadClient } from "./github-client";
import { createTaskPushPreview, taskPushPreviewInput } from "./task-push-preview";
import { verifyTaskPushExport } from "./task-push-export";

const claimSchema = z.object({ jobId: z.uuid(), claimId: z.uuid(), organizationId: z.uuid(), connectionId: z.uuid(), admission: taskPushPreviewInput }).strict();
type Options = { transport?: typeof fetch; signal?: AbortSignal; afterClaim?: (id: string) => Promise<void>; afterBegin?: (id: string) => Promise<void>;
  afterPreview?: (id: string, value: Awaited<ReturnType<typeof createTaskPushPreview>>) => Promise<void>; beforeFinish?: (id: string) => Promise<void>; beforeCommit?: (id: string) => Promise<void> };

/** One read-only attempt per durable request, with a pinned SQL owner. A lost
 * connection never reconnects to repeat a credential request or artifact read.
 * Reclaimed orphan readers are failed; their unique artifacts cannot publish.
 * Dispatch of a remote write is a separate protocol and is not provided here. */
export async function processTaskPushPreview(pool: Pool, root: string, master: () => Promise<Buffer>, options: Options = {}) {
  const db = await pool.connect(), lost = new AbortController(), denied = new AbortController(), monitorStop = new AbortController();
  const signal = AbortSignal.any([lost.signal, denied.signal, options.signal ?? new AbortController().signal, AbortSignal.timeout(420000)]);
  let claim: z.infer<typeof claimSchema> | undefined, monitor: Promise<void> | undefined;
  const disconnected = () => lost.abort(); db.on("error", disconnected);
  const check = () => { if (signal.aborted) throw new GitHubError(denied.signal.aborted ? "task_push_preview_authority_changed" : "task_push_preview_cancelled"); };
  const stopMonitor = async () => { monitorStop.abort(); await monitor; };
  try {
    check(); const raw = (await db.query("SELECT collab_git.claim_push_preview() AS result")).rows[0].result;
    if (!raw) return null;
    if (raw.status === "failed") return { jobId: z.uuid().parse(raw.jobId), status: "failed" };
    claim = claimSchema.parse(raw); const { jobId, claimId, admission } = claim;
    if (jobId !== admission.exportId) throw new GitHubError("task_push_preview_evidence_mismatch");
    await db.query("SELECT set_config('application_name',$1,false)", [`pi-collab-push-preview:${jobId}`]);
    await options.afterClaim?.(jobId); check();
    const connection = (await db.query("SELECT collab_git.begin_push_preview($1,$2) AS result", [jobId, claimId])).rows[0].result;
    // The monitor uses this same pinned connection only while no publication
    // transaction is active; it is fully joined before final SQL settlement.
    monitor = (async () => {
      while (!monitorStop.signal.aborted && !signal.aborted) {
        try { await delay(500, undefined, { signal: monitorStop.signal }); }
        catch (error) { if (monitorStop.signal.aborted) return; throw error; }
        if (signal.aborted || monitorStop.signal.aborted) break;
        // A silent SQL socket must not leave the read capability live until the
        // transfer timeout. The connection is discarded on this local deadline;
        // no later query/result from it can publish or restart the attempt.
        const timeout = new AbortController();
        let live: unknown;
        try {
          live = (await Promise.race([
            db.query("SELECT collab_git.push_preview_live($1,$2) AS result", [jobId, claimId]),
            delay(2000, undefined, { signal: timeout.signal }).then((): never => { throw new GitHubError("task_push_preview_owner_unavailable"); }),
          ])).rows[0].result;
        } finally { timeout.abort(); }
        if (live !== true) denied.abort();
      }
    })().catch(() => lost.abort());
    await options.afterBegin?.(jobId); check();
    const config = githubAppConfig.parse({ appId: connection.appId, installationId: connection.installationId, accountId: connection.accountId });
    const bytes = await master(); let client: GitHubReadClient;
    try { client = new GitHubReadClient(config, openGitHubKey(bytes, { ...config, connectionId: claim.connectionId, organizationId: claim.organizationId }, connection.sealed), options.transport); }
    finally { bytes.fill(0); }
    check(); const result = await createTaskPushPreview(root, admission, client, signal);
    await options.afterPreview?.(jobId, result); check();
    const verified = await verifyTaskPushExport(root, admission.exportId, result.manifestHash, signal);
    if (!isDeepStrictEqual(result.input, admission) || !isDeepStrictEqual(verified.manifest, result.manifest)) throw new GitHubError("task_push_preview_evidence_mismatch");
    await stopMonitor(); await options.beforeFinish?.(jobId); check();
    try {
      await db.query("BEGIN"); check();
      const settled = (await db.query("SELECT collab_git.finish_push_preview($1,$2,$3,$4,$5) AS result",
        [jobId, claimId, JSON.stringify(result.observation), JSON.stringify(verified.manifest), result.manifestHash])).rows[0].result;
      await options.beforeCommit?.(jobId); check(); await db.query("COMMIT"); return settled;
    } catch (error) { await db.query("ROLLBACK").catch(() => {}); throw error; }
  } catch (error) {
    await stopMonitor();
    if (claim && !lost.signal.aborted) {
      const domain = error instanceof Error && (error as { code?: string }).code === "P0001" && /^task_push_preview_[a-z_]+$/.test(error.message) ? error.message : null;
      const code = denied.signal.aborted ? "task_push_preview_authority_changed" : error instanceof GitHubError ? error.code : domain ?? "task_push_preview_broker_failed";
      const failed = await db.query("SELECT collab_git.fail_push_preview($1,$2,$3) AS result", [claim.jobId, claim.claimId, code]).catch(() => null);
      if (failed) return failed.rows[0].result;
    }
    throw new GitHubError("task_push_preview_outcome_unknown");
  } finally { monitorStop.abort(); lost.abort(); await monitor; db.removeListener("error", disconnected); db.release(true); }
}
