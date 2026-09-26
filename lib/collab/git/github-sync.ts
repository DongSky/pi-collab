import { randomUUID } from "node:crypto";
import { mkdir, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { GitHubReadClient } from "./github-client";
import { GitHubError, openGitHubKey } from "./github-credentials";
import { githubAppConfig, type GitHubRepositoryEvidence } from "./github-schema";
import { downloadGitHubGit } from "./github-pack";
import { abortGitHubSync, applyGitHubSync, classifyGitHubSync, prepareGitHubSync, syncGitInput, type SyncClassification, type SyncGitInput, type SyncObservation } from "./github-sync-git";

export const githubSyncInput = z.object({ repositoryId: z.uuid(), actorId: z.string().min(1).max(200), reason: z.string().trim().min(10).max(2000), idempotencyKey: z.uuid() }).strict();
type Input = z.infer<typeof githubSyncInput>;
type Job = { id: string; organization_id: string; project_id: string; repository_id: string; connection_id: string; github_repository_id: string;
  installation_version: string; actor_id: string; organization_version: string; project_version: string; target_branch: string; old_sha: string;
  status: "pending" | "fetching" | "applying" | "blocked" | "completed" | "failed"; classification: SyncClassification | null; outcome: string | null;
  input: SyncGitInput | null; evidence: GitHubRepositoryEvidence | null; failure: string | null; };
async function transaction<T>(db: PoolClient, actor: string, work: () => Promise<T>) {
  try { await db.query("BEGIN"); await db.query("SELECT set_config('collab.user_id',$1,true)", [actor]); const result = await work(); await db.query("COMMIT"); return result; }
  catch (e) { await db.query("ROLLBACK").catch(() => {}); throw e; }
}
async function authority(db: PoolClient, repositoryId: string) {
  const repo = (await db.query("SELECT * FROM collab.repositories WHERE id=$1", [repositoryId])).rows[0];
  if (!repo) throw new GitHubError("github_repository_unavailable");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,811))", [repo.organization_id]);
  await db.query('SELECT 1 FROM public."user" WHERE id=collab.actor() FOR SHARE');
  const grant = (await db.query("SELECT m.authorization_version::text AS organization,pm.authorization_version::text AS project FROM collab.memberships m JOIN collab.project_memberships pm ON pm.organization_id=m.organization_id AND pm.user_id=m.user_id WHERE m.organization_id=$1 AND pm.project_id=$2 AND m.user_id=collab.actor() AND m.active AND pm.active AND pm.role='maintainer' AND collab.actor_has_mfa()", [repo.organization_id, repo.project_id])).rows[0];
  if (!grant) throw new GitHubError("github_maintainer_authority_required");
  return { repo: (await db.query("SELECT * FROM collab.repositories WHERE id=$1", [repositoryId])).rows[0], grant };
}
async function connection(db: PoolClient, job: Job) {
  const { repo, grant } = await authority(db, job.repository_id);
  if (grant.organization !== job.organization_version || grant.project !== job.project_version) throw new GitHubError("github_sync_authority_changed");
  if (repo.base_sha !== job.old_sha || repo.default_branch !== job.target_branch) throw new GitHubError("github_sync_target_moved");
  const c = (await db.query("SELECT c.*,s.sealed FROM collab.github_installations c JOIN collab_git.credentials s ON s.connection_id=c.id JOIN collab.github_bindings b ON b.connection_id=c.id WHERE b.repository_id=$1 AND b.github_repository_id=$2 AND c.id=$3 AND c.organization_id=$4 AND c.enabled AND c.version=$5 AND b.installation_version=c.version", [job.repository_id, job.github_repository_id, job.connection_id, job.organization_id, job.installation_version])).rows[0];
  if (!c) throw new GitHubError("github_connection_unavailable"); return c;
}
async function admit(admin: Pool, input: Input): Promise<Job> {
  const db = await admin.connect();
  try { return await transaction(db, input.actorId, async () => {
    await db.query("SELECT pg_advisory_xact_lock(82467116)");
    const { repo, grant } = await authority(db, input.repositoryId), payload = { reason: input.reason };
    const prior = (await db.query("SELECT *,request=$4::jsonb AS same FROM collab.github_syncs WHERE repository_id=$1 AND actor_id=$2 AND idempotency_key=$3", [input.repositoryId, input.actorId, input.idempotencyKey, payload])).rows[0];
    if (prior) { if (!prior.same) throw new GitHubError("idempotency_conflict"); return prior; }
    const binding = (await db.query("SELECT b.* FROM collab.github_bindings b JOIN collab.github_installations c ON c.id=b.connection_id WHERE b.repository_id=$1 AND c.enabled AND b.installation_version=c.version", [input.repositoryId])).rows[0];
    if (!binding) throw new GitHubError("github_connection_unavailable");
    if ((await db.query("SELECT 1 FROM collab.github_syncs WHERE repository_id=$1 AND target_branch=$2 AND status NOT IN ('completed','failed') UNION ALL SELECT 1 FROM collab.promotions WHERE repository_id=$1 AND target_branch=$2 AND status NOT IN ('applied','aborted') UNION ALL SELECT 1 FROM collab.integrations WHERE repository_id=$1 AND target_branch=$2 AND status IN ('integrating','checking','unknown')", [input.repositoryId, repo.default_branch])).rowCount) throw new GitHubError("github_sync_target_busy");
    const job = (await db.query("INSERT INTO collab.github_syncs(id,organization_id,project_id,repository_id,connection_id,github_repository_id,installation_version,actor_id,organization_version,project_version,idempotency_key,request,target_branch,old_sha) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *", [randomUUID(), repo.organization_id, repo.project_id, repo.id, binding.connection_id, binding.github_repository_id, binding.installation_version, input.actorId, grant.organization, grant.project, input.idempotencyKey, payload, repo.default_branch, repo.base_sha])).rows[0];
    await db.query("INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES($1,$2,$3,'github.sync_requested',$4,$5)", [job.organization_id, job.project_id, input.actorId, job.id, { ...payload, repositoryId: repo.id, targetBranch: repo.default_branch, oldSha: repo.base_sha, source: "local-administrator-cli" }]);
    return job;
  }); } finally { db.release(); }
}
const answer = (job: Job, replayed: boolean) => ({ jobId: job.id, repositoryId: job.repository_id, status: job.status, outcome: job.outcome, classification: job.classification,
  oldSha: job.old_sha, remoteSha: job.evidence?.targetSha ?? null, replayed });
async function record(db: PoolClient, job: Job, outcome: string | null, observation: SyncObservation | null) {
  const status = outcome ? "completed" : "blocked";
  await db.query("UPDATE collab.github_syncs SET status=$2,outcome=$3,observation=$4,failure=$5,finished_at=CASE WHEN $3::text IS NOT NULL THEN now() END WHERE id=$1", [job.id, status, outcome, observation, outcome ? null : "github_sync_target_diverged"]);
  await db.query("INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES($1,$2,collab.actor(),$3,$4,$5)", [job.organization_id, job.project_id, `github.sync_${outcome ?? "blocked"}`, job.id, { requestedBy: job.actor_id, classification: job.classification, observation }]);
  return { ...job, status, outcome } as Job;
}
async function settle(db: PoolClient, job: Job, observation: SyncObservation) {
  const repo = (await db.query("SELECT * FROM collab.repositories WHERE id=$1 FOR UPDATE", [job.repository_id])).rows[0];
  if (repo.base_sha !== job.old_sha || repo.default_branch !== job.target_branch) return record(db, job, null, observation);
  if (observation.decision === "aborted" && observation.targetSha === job.old_sha) return record(db, job, "aborted", observation);
  if (observation.decision !== "applied" || observation.targetSha !== job.input!.newSha) return record(db, job, null, observation);
  await db.query("UPDATE collab.repositories SET base_sha=$2 WHERE id=$1", [job.repository_id, job.input!.newSha]);
  const sequence = (await db.query("UPDATE collab.projects SET event_sequence=event_sequence+1 WHERE id=$1 RETURNING event_sequence", [job.project_id])).rows[0].event_sequence;
  await db.query("INSERT INTO collab.repository_baselines(organization_id,project_id,repository_id,sync_id,sequence,target_branch,old_sha,new_sha) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [job.organization_id, job.project_id, job.repository_id, job.id, sequence, job.target_branch, job.old_sha, job.input!.newSha]);
  return record(db, job, "fast_forward", observation);
}
type Options = { transport?: typeof fetch; signal?: AbortSignal; afterFetch?: (id: string) => Promise<void>; afterAdmission?: (id: string) => Promise<void>;
  beforeApply?: (id: string) => Promise<void>; afterUpdate?: (id: string) => Promise<void>; beforeCommit?: (id: string) => Promise<void> };
/** Local administrator entry, until a dedicated Git broker is available.
 * Same-key continuation reconciles an admitted effect, never applies it again.
 * Uncertain operations retain target occupancy even after DB connection loss. */
export async function syncGitHubRepository(admin: Pool, root: string, master: Buffer, raw: z.input<typeof githubSyncInput>, options: Options = {}) {
  const input = githubSyncInput.parse(raw);
  return executeSync(admin, root, master, input, await admit(admin, input), options);
}

/** A different current maintainer may reconcile a revoked request. This entry
 * can only observe/abort; it never downloads or reapplies a target update. */
export async function reconcileGitHubSync(admin: Pool, root: string, jobId: string, actorId: string, reason: string) {
  z.uuid().parse(jobId); z.string().min(1).max(200).parse(actorId); reason = z.string().trim().min(10).max(2000).parse(reason);
  const db = await admin.connect(); let job: Job;
  try { job = await transaction(db, actorId, async () => {
    const found = (await db.query("SELECT * FROM collab.github_syncs WHERE id=$1", [jobId])).rows[0];
    if (!found) throw new GitHubError("github_sync_unavailable");
    await authority(db, found.repository_id);
    await db.query("INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES($1,$2,$3,'github.sync_reconcile_requested',$4,$5)", [found.organization_id, found.project_id, actorId, jobId, { reason }]);
    return found;
  }); } finally { db.release(); }
  return executeSync(admin, root, Buffer.alloc(0), { repositoryId: job.repository_id, actorId, reason, idempotencyKey: randomUUID() }, job, {}, true);
}

async function executeSync(admin: Pool, root: string, master: Buffer, input: Input, initial: Job, options: Options, reconcileOnly = false) {
  const db = await admin.connect();
  const lost = new AbortController(), signal = AbortSignal.any([lost.signal, options.signal ?? AbortSignal.timeout(300_000), AbortSignal.timeout(300_000)]);
  let connected = true, locked = false, effectPossible = false, job = initial;
  const disconnected = () => { connected = false; lost.abort(); }; db.on("error", disconnected);
  try {
    locked = (await db.query("SELECT pg_try_advisory_lock(hashtextextended($1,918276433)) AS locked", [job.id])).rows[0].locked;
    if (!locked) throw new GitHubError("github_sync_busy");
    await db.query("SELECT set_config('application_name',$1,false)", [`pi-collab-github-sync:${job.id}`]);
    job = (await db.query("SELECT * FROM collab.github_syncs WHERE id=$1", [job.id])).rows[0];
    if (job.status === "completed") return answer(job, true);
    if ((await db.query("SELECT 1 FROM collab_git.sync_dispatch WHERE sync_id=$1", [job.id])).rowCount) throw new GitHubError("github_sync_managed_by_broker");
    if (job.status === "failed") throw new GitHubError(job.failure ?? "github_sync_failed");
    effectPossible = job.input !== null;
    if (effectPossible) {
      // Recovery requires current project maintainer MFA, but deliberately not
      // the original installation/authority: revoked operations still need to
      // be terminally fenced or have their already-achieved effect recorded.
      const settled = await transaction(db, input.actorId, async () => {
        await authority(db, job.repository_id);
        const result = await settle(db, job, await abortGitHubSync(root, syncGitInput.parse(job.input), signal));
        await options.beforeCommit?.(job.id); return result;
      }); return answer(settled, true);
    }
    if (reconcileOnly || job.status !== "pending") throw new GitHubError("github_sync_fetch_abandoned");
    const c = await transaction(db, input.actorId, () => connection(db, job));
    await db.query("UPDATE collab.github_syncs SET status='fetching' WHERE id=$1", [job.id]); job.status = "fetching";
    const canonical = await realpath(root), parent = path.join(canonical, "github-syncs"); await mkdir(parent, { recursive: true, mode: 0o700 });
    if ((await lstat(parent)).isSymbolicLink()) throw new GitHubError("github_sync_path_invalid");
    const config = githubAppConfig.parse({ appId: c.app_id, installationId: c.installation_id, accountId: c.account_id });
    const key = openGitHubKey(master, { ...config, connectionId: job.connection_id, organizationId: job.organization_id }, c.sealed);
    job.evidence = (await new GitHubReadClient(config, key, options.transport).readGitRepository(job.github_repository_id,
      (evidence, read, deadline) => downloadGitHubGit(path.join(parent, job.id), evidence, read, deadline), signal)).evidence;
    await options.afterFetch?.(job.id);
    if (signal.aborted) throw new GitHubError("github_request_cancelled");
    job.classification = await classifyGitHubSync(root, job.repository_id, job.id, job.target_branch, job.old_sha, job.evidence.defaultBranch, job.evidence.targetSha, signal);
    if (signal.aborted) throw new GitHubError("github_request_cancelled");
    // Durable effect intent is acknowledged before any receipt/target write.
    // Mark possible before COMMIT: its reply may be lost after it took effect.
    effectPossible = job.classification === "remote_ahead";
    job.input = effectPossible ? syncGitInput.parse({ version: 1, syncId: job.id, repositoryId: job.repository_id, targetBranch: job.target_branch, oldSha: job.old_sha, newSha: job.evidence.targetSha, observedAt: job.evidence.verifiedAt }) : null;
    const admitted = await transaction(db, input.actorId, async () => {
      await connection(db, job); if (signal.aborted) throw new GitHubError("github_request_cancelled");
      await db.query("UPDATE collab.github_syncs SET classification=$2,evidence=$3,input=$4,status=CASE WHEN $4::jsonb IS NOT NULL THEN 'applying' ELSE status END WHERE id=$1", [job.id, job.classification, job.evidence, job.input]);
      await db.query("UPDATE collab.github_bindings SET evidence=$2,verified_at=$3 WHERE repository_id=$1", [job.repository_id, job.evidence, job.evidence!.verifiedAt]);
      return effectPossible ? { ...job, status: "applying" as const } : record(db, job, job.classification!, null);
    });
    job = admitted; if (!effectPossible) return answer(job, false);
    await options.afterAdmission?.(job.id);
    await prepareGitHubSync(root, job.input!, signal);
    await options.beforeApply?.(job.id);
    const settled = await transaction(db, input.actorId, async () => {
      await connection(db, job); if (signal.aborted) throw new GitHubError("github_request_cancelled");
      const observation = await applyGitHubSync(root, job.input!, signal, { afterUpdate: options.afterUpdate ? () => options.afterUpdate!(job.id) : undefined });
      const result = await settle(db, job, observation);
      await options.beforeCommit?.(job.id); return result;
    }); return answer(settled, false);
  } catch (error) {
    // A possible target write may only be closed by Git decision reconciliation.
    // Pending/fetch failures cannot write a ref; late processes use the dead
    // pinned SQL connection and cannot admit a new effect on a fresh connection.
    if (locked && connected && !(error instanceof GitHubError && error.code === "github_sync_managed_by_broker") && !effectPossible && ["pending", "fetching"].includes(job.status)) {
      await db.query("WITH failed AS (UPDATE collab.github_syncs SET status='failed',failure=$2,finished_at=now() WHERE id=$1 AND status IN ('pending','fetching') AND input IS NULL RETURNING *) INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) SELECT organization_id,project_id,actor_id,'github.sync_failed',id::text,jsonb_build_object('reason',failure) FROM failed", [job.id, error instanceof GitHubError ? error.code : "github_sync_failed"]).catch(() => {});
    }
    if (effectPossible || !connected) throw new GitHubError("github_sync_outcome_unknown");
    if (error instanceof GitHubError) throw error; throw new GitHubError("github_sync_failed");
  } finally {
    if (connected && locked) await db.query("SELECT pg_advisory_unlock(hashtextextended($1,918276433))", [job.id]).catch(disconnected);
    db.removeListener("error", disconnected); db.release(!connected);
  }
}
