import { setTimeout as delay } from "node:timers/promises";
import type { Pool } from "pg";
import { z } from "zod";
import { GitHubError, openGitHubKey } from "./github-credentials";
import { githubAppConfig } from "./github-schema";
import { githubPushBinding } from "./github-task-target";
import { observedPullIdentity } from "./github-pull-observation";
import { GitHubReadClient } from "./github-client";
import { capturePullRevision, verifyPullRevision, pullRevisionInput, type PullRevisionManifest } from "./pull-revision";

const claimSchema = z.object({ jobId: z.uuid(), claimId: z.uuid(), admission: z.object({
  changeId: z.uuid(), organizationId: z.uuid(), repositoryId: z.uuid(), connectionId: z.uuid(),
  installationVersion: z.string().regex(/^[1-9][0-9]*$/), bindingVersion: z.string().regex(/^[1-9][0-9]*$/),
  binding: githubPushBinding, identity: observedPullIdentity, observationId: z.uuid(), observationHash: z.string().regex(/^[a-f0-9]{64}$/),
  snapshot: z.object({ headSha: z.string(), baseSha: z.string(), headRef: z.string(), baseRef: z.string() }).passthrough(),
}).strict() }).strict();
type Options = { transport?: typeof fetch; signal?: AbortSignal; afterClaim?: (id: string) => Promise<void>; afterBegin?: (id: string) => Promise<void>;
  beforeFinish?: (id: string, manifest: PullRevisionManifest) => Promise<void>; beforeCommit?: (id: string) => Promise<void> };

/** One explicit read per durable request, with pinned SQL ownership and live
 * authority. Publication binds verified Git artifacts to the immutable observation.
 * A newer observation invalidates pending work, not published historical bytes. Recovery never replays an abandoned provider request. */
export async function processPullRevision(pool: Pool, root: string, master: () => Promise<Buffer>, options: Options = {}) {
  const db = await pool.connect(), lost = new AbortController(), denied = new AbortController(), monitorStop = new AbortController();
  const signal = AbortSignal.any([lost.signal, denied.signal, options.signal ?? new AbortController().signal, AbortSignal.timeout(180000)]);
  let claim: z.infer<typeof claimSchema> | undefined, monitor: Promise<void> | undefined;
  const disconnected = () => lost.abort(); db.on("error", disconnected);
  const check = () => { if (signal.aborted) throw new GitHubError(denied.signal.aborted ? "pull_revision_authority_changed" : "pull_revision_cancelled"); };
  const stopMonitor = async () => { monitorStop.abort(); await monitor; };
  try {
    check(); const raw = (await db.query("SELECT collab_git.claim_pull_revision() AS result")).rows[0].result;
    if (!raw || raw.recovered) return raw;
    claim = claimSchema.parse(raw); const { jobId, claimId, admission } = claim;
    await db.query("SELECT set_config('application_name',$1,false)", [`pi-collab-pull-revision:${jobId}`]);
    await options.afterClaim?.(jobId); check();
    const connection = (await db.query("SELECT collab_git.begin_pull_revision($1,$2) AS result", [jobId, claimId])).rows[0].result;
    monitor = (async () => {
      while (!monitorStop.signal.aborted && !signal.aborted) {
        try { await delay(500, undefined, { signal: monitorStop.signal }); }
        catch (error) { if (monitorStop.signal.aborted) return; throw error; }
        if (signal.aborted || monitorStop.signal.aborted) break;
        const timeout = new AbortController();
        try {
          const live = (await Promise.race([
            db.query("SELECT collab_git.pull_revision_live($1,$2) AS result", [jobId, claimId]),
            delay(2000, undefined, { signal: timeout.signal }).then((): never => { throw new GitHubError("pull_revision_owner_unavailable"); }),
          ])).rows[0].result;
          if (live !== true) denied.abort();
        } finally { timeout.abort(); }
      }
    })().catch(() => lost.abort());
    await options.afterBegin?.(jobId); check();
    const config = githubAppConfig.parse({ appId: connection.appId, installationId: connection.installationId, accountId: connection.accountId });
    const bytes = await master(); let client: GitHubReadClient;
    try { client = new GitHubReadClient(config, openGitHubKey(bytes, { ...config, connectionId: admission.connectionId, organizationId: admission.organizationId }, connection.sealed), options.transport); }
    finally { bytes.fill(0); }
    const input = pullRevisionInput.parse({ version: 1, revisionId: jobId, changeId: admission.changeId, repositoryId: admission.repositoryId,
      githubRepositoryId: admission.binding.githubRepositoryId, pullId: admission.identity.id, pullNumber: admission.identity.number,
      observationId: admission.observationId, observationHash: admission.observationHash,
      headSha: admission.snapshot.headSha, baseSha: admission.snapshot.baseSha, headRef: admission.snapshot.headRef, baseRef: admission.snapshot.baseRef });
    check(); const captured = await client.readGitRepository(admission.binding.githubRepositoryId, async (observed, read, deadline) => {
      for (const [key, value] of Object.entries({ repositoryId: admission.binding.githubRepositoryId, nodeId: admission.binding.nodeId,
        ownerId: admission.binding.ownerId, ownerLogin: admission.binding.ownerLogin, name: admission.binding.name,
        private: admission.binding.private, visibility: admission.binding.visibility, defaultBranch: admission.binding.defaultBranch })) {
        if (observed[key as keyof typeof observed] !== value) throw new GitHubError("pull_revision_repository_changed");
      }
      return capturePullRevision(root, input, read, deadline);
    }, signal);
    const { manifest, manifestHash } = captured.value;
    await options.beforeFinish?.(jobId, manifest); check();
    const verified = await verifyPullRevision(root, jobId, manifestHash, signal);
    if (JSON.stringify(verified.manifest) !== JSON.stringify(manifest)) throw new GitHubError("pull_revision_artifact_changed");
    await stopMonitor(); check();
    try {
      await db.query("BEGIN"); check();
      const result = (await db.query("SELECT collab_git.finish_pull_revision($1,$2,$3,$4,$5) AS result", [jobId, claimId, JSON.stringify(manifest), manifestHash, captured.evidence])).rows[0].result;
      await options.beforeCommit?.(jobId); check();
      try { await db.query("COMMIT"); } catch (error) { lost.abort(); throw error; }
      return result;
    } catch (error) { if (!lost.signal.aborted) await db.query("ROLLBACK").catch(() => lost.abort()); throw error; }
  } catch (error) {
    await stopMonitor();
    if (claim && !lost.signal.aborted) {
      const domain = error instanceof Error && (error as { code?: string }).code === "P0001" && /^(?:pull_revision|invalid_pull_revision)_[a-z_]+$/.test(error.message) ? error.message : null;
      const artifact = error instanceof Error && /^pull_revision_[a-z_]+$/.test(error.message) ? error.message : null;
      const code = denied.signal.aborted ? "pull_revision_authority_changed" : error instanceof GitHubError ? error.code : domain ?? artifact ?? "pull_revision_broker_failed";
      const failed = await db.query("SELECT collab_git.fail_pull_revision($1,$2,$3) AS result", [claim.jobId, claim.claimId, code]).catch(() => null);
      if (failed) return failed.rows[0].result;
    }
    throw new GitHubError("pull_revision_outcome_unknown");
  } finally { monitorStop.abort(); lost.abort(); await monitor; db.removeListener("error", disconnected); db.release(true); }
}
