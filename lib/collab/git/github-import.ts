import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { importDirectory, writeImportReceipt, readImportReceipt } from "./github-import-receipt";
import { GitHubReadClient } from "./github-client";
import { GitHubError, openGitHubKey } from "./github-credentials";
import { githubAppConfig, githubId, type GitHubRepositoryEvidence } from "./github-schema";
import { downloadGitHubGit, verifyImportedGit, importGit } from "./github-pack";

export const githubImportInput = z.object({ projectId: z.uuid(), actorId: z.string().min(1).max(200), connectionId: z.uuid(), githubRepositoryId: githubId,
  name: z.string().trim().min(1).max(120), reason: z.string().trim().min(10).max(2000), idempotencyKey: z.uuid() }).strict();
type Input = z.infer<typeof githubImportInput>;
type Job = { id: string; repository_id: string; organization_id: string; project_id: string; connection_id: string; github_repository_id: string;
  actor_id: string; organization_version: string; project_version: string; installation_version: string; request: { name: string; reason: string };
  status: "pending" | "fetching" | "completed" | "failed"; evidence: GitHubRepositoryEvidence | null; failure: string | null };
async function transaction<T>(db: PoolClient, actor: string, work: () => Promise<T>) {
  try { await db.query("BEGIN"); await db.query("SELECT set_config('collab.user_id',$1,true)", [actor]); const result = await work(); await db.query("COMMIT"); return result; }
  catch (error) { await db.query("ROLLBACK").catch(() => {}); throw error; }
}
async function authority(db: PoolClient, projectId: string) {
  const project = (await db.query("SELECT organization_id FROM collab.projects WHERE id=$1", [projectId])).rows[0];
  if (!project) throw new GitHubError("github_maintainer_authority_required");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,811))", [project.organization_id]);
  await db.query('SELECT 1 FROM public."user" WHERE id=collab.actor() FOR SHARE');
  const grant = (await db.query("SELECT m.authorization_version::text AS organization,pm.authorization_version::text AS project FROM collab.memberships m JOIN collab.project_memberships pm ON pm.organization_id=m.organization_id AND pm.user_id=m.user_id WHERE m.organization_id=$1 AND pm.project_id=$2 AND m.user_id=collab.actor() AND m.active AND pm.active AND pm.role='maintainer' AND collab.actor_has_mfa()", [project.organization_id, projectId])).rows[0];
  if (!grant) throw new GitHubError("github_maintainer_authority_required");
  return { organizationId: project.organization_id as string, organization: grant.organization as string, project: grant.project as string };
}
async function currentConnection(db: PoolClient, job: Job) {
  const grant = await authority(db, job.project_id);
  if (grant.organizationId !== job.organization_id || grant.organization !== job.organization_version || grant.project !== job.project_version) throw new GitHubError("github_import_authority_changed");
  const connection = (await db.query("SELECT c.*,s.sealed FROM collab.github_installations c JOIN collab_git.credentials s ON s.connection_id=c.id WHERE c.id=$1 AND c.organization_id=$2 AND c.enabled AND c.version=$3", [job.connection_id, job.organization_id, job.installation_version])).rows[0];
  if (!connection) throw new GitHubError("github_connection_unavailable"); return connection;
}
async function admit(admin: Pool, input: Input): Promise<Job> {
  const db = await admin.connect();
  try { return await transaction(db, input.actorId, async () => {
    const grant = await authority(db, input.projectId), payload = { connectionId: input.connectionId, githubRepositoryId: input.githubRepositoryId, name: input.name, reason: input.reason };
    const prior = (await db.query("SELECT *,request=$4::jsonb AS same FROM collab.github_imports WHERE project_id=$1 AND actor_id=$2 AND idempotency_key=$3", [input.projectId, input.actorId, input.idempotencyKey, payload])).rows[0];
    if (prior) { if (!prior.same) throw new GitHubError("idempotency_conflict"); return prior; }
    const connection = (await db.query("SELECT version::text FROM collab.github_installations WHERE id=$1 AND organization_id=$2 AND enabled", [input.connectionId, grant.organizationId])).rows[0];
    if (!connection) throw new GitHubError("github_connection_unavailable");
    if ((await db.query("SELECT 1 FROM collab.github_bindings WHERE github_repository_id=$1 UNION ALL SELECT 1 FROM collab.github_imports WHERE github_repository_id=$1 AND status<>'failed'", [input.githubRepositoryId])).rowCount) throw new GitHubError("github_repository_already_bound");
    const job = (await db.query("INSERT INTO collab.github_imports(id,repository_id,organization_id,project_id,connection_id,github_repository_id,actor_id,idempotency_key,organization_version,project_version,installation_version,request) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *", [randomUUID(), randomUUID(), grant.organizationId, input.projectId, input.connectionId, input.githubRepositoryId, input.actorId, input.idempotencyKey, grant.organization, grant.project, connection.version, payload])).rows[0];
    await db.query("INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES($1,$2,$3,'github.import_requested',$4,$5)", [grant.organizationId, input.projectId, input.actorId, job.id, { ...payload, source: "local-administrator-cli" }]);
    return job;
  }); } catch (error) { if ((error as { code?: string }).code === "23505") throw new GitHubError("github_repository_already_bound"); throw error; }
  finally { db.release(); }
}
const answer = (job: Job, replayed: boolean) => ({ jobId: job.id, id: job.repository_id, baseSha: job.evidence!.targetSha, defaultBranch: job.evidence!.defaultBranch, replayed });

/** Native local administrator operation. Same-key retry observes the original
 * job; it never re-downloads into an abandoned or possibly live directory. */
export async function importGitHubRepository(admin: Pool, root: string, master: Buffer, raw: z.input<typeof githubImportInput>, options: { transport?: typeof fetch; signal?: AbortSignal; beforeFinalize?: (jobId: string) => Promise<void> } = {}) {
  const input = githubImportInput.parse(raw), admission = await admit(admin, input), db = await admin.connect();
  const lost = new AbortController(), signal = AbortSignal.any([lost.signal, options.signal ?? AbortSignal.timeout(240_000), AbortSignal.timeout(240_000)]);
  let connected = true, locked = false, ready = false, job = admission;
  const disconnected = () => { connected = false; lost.abort(); }; db.on("error", disconnected);
  try {
    locked = (await db.query("SELECT pg_try_advisory_lock(hashtextextended($1,918276432)) AS locked", [job.id])).rows[0].locked;
    if (!locked) throw new GitHubError("github_import_busy");
    await db.query("SELECT set_config('application_name',$1,false)", [`pi-collab-github-import:${job.id}`]);
    job = (await db.query("SELECT * FROM collab.github_imports WHERE id=$1", [job.id])).rows[0];
    if (job.status === "completed") return answer(job, true);
    if ((await db.query("SELECT 1 FROM collab_git.import_dispatch WHERE import_id=$1", [job.id])).rowCount) throw new GitHubError("github_import_managed_by_broker");
    if (job.status === "failed") throw new GitHubError(job.failure ?? "github_import_failed");
    const connection = await transaction(db, input.actorId, () => currentConnection(db, job));
    const directory = await importDirectory(root, job); let evidence: GitHubRepositoryEvidence;
    if (job.status === "pending") {
      await db.query("UPDATE collab.github_imports SET status='fetching' WHERE id=$1 AND status='pending'", [job.id]);
      job.status = "fetching";
      const config = githubAppConfig.parse({ appId: connection.app_id, installationId: connection.installation_id, accountId: connection.account_id });
      const key = openGitHubKey(master, { ...config, connectionId: job.connection_id, organizationId: job.organization_id }, connection.sealed);
      evidence = (await new GitHubReadClient(config, key, options.transport).readGitRepository(job.github_repository_id,
        (observed, read, deadline) => downloadGitHubGit(directory, observed, read, deadline), signal)).evidence;
      if (signal.aborted) throw new GitHubError("github_request_cancelled");
      await writeImportReceipt(directory, master, job, evidence); ready = true;
      await readImportReceipt(directory, master, job);
    } else {
      if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink()) throw new GitHubError("github_import_path_invalid");
      evidence = await readImportReceipt(directory, master, job); ready = true;
      await verifyImportedGit(directory, evidence, signal);
      if ((await importGit(path.join(directory, "git"), ["symbolic-ref", "HEAD"], signal)).trim() !== `refs/heads/${evidence.defaultBranch}`) throw new GitHubError("github_git_baseline_mismatch");
    }
    await options.beforeFinalize?.(job.id);
    if (signal.aborted && connected) throw new GitHubError("github_request_cancelled");
    await transaction(db, input.actorId, async () => {
      await currentConnection(db, job);
      if (signal.aborted) throw new GitHubError("github_request_cancelled");
      if ((await db.query("SELECT 1 FROM collab.github_bindings WHERE github_repository_id=$1", [job.github_repository_id])).rowCount) throw new GitHubError("github_repository_already_bound");
      await db.query("INSERT INTO collab.repositories(id,organization_id,project_id,name,provider,base_sha,default_branch) VALUES($1,$2,$3,$4,'github',$5,$6)", [job.repository_id, job.organization_id, job.project_id, job.request.name, evidence.targetSha, evidence.defaultBranch]);
      await db.query("INSERT INTO collab.github_bindings(repository_id,organization_id,project_id,connection_id,installation_version,github_repository_id,evidence,bound_by,idempotency_key,request,verified_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [job.repository_id, job.organization_id, job.project_id, job.connection_id, job.installation_version, job.github_repository_id, evidence, job.actor_id, input.idempotencyKey, { connectionId: job.connection_id, githubRepositoryId: job.github_repository_id, reason: job.request.reason }, evidence.verifiedAt]);
      if (!(await db.query("UPDATE collab.github_imports SET status='completed',evidence=$2,finished_at=now() WHERE id=$1 AND status='fetching' RETURNING id", [job.id, evidence])).rowCount) throw new GitHubError("github_import_state_changed");
      await db.query("INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES($1,$2,$3,'github.repository_imported',$4,$5)", [job.organization_id, job.project_id, job.actor_id, job.repository_id, { jobId: job.id, targetSha: evidence.targetSha, defaultBranch: evidence.defaultBranch }]);
      if (signal.aborted) throw new GitHubError("github_request_cancelled");
    });
    job.evidence = evidence; return answer(job, admission.status !== "pending");
  } catch (error) {
    if ((error as { code?: string }).code === "23505") error = new GitHubError("github_repository_already_bound");
    // Never delete bytes after any uncertain SQL acknowledgement. A retry on a
    // new connection will inspect the completed row or authenticated receipt.
    if (locked && connected && !(error instanceof GitHubError && error.code === "github_import_managed_by_broker") && (!ready || error instanceof GitHubError) && ["pending", "fetching"].includes(job.status)) {
      await db.query("WITH failed AS (UPDATE collab.github_imports SET status='failed',failure=$2,finished_at=now() WHERE id=$1 AND status IN ('pending','fetching') RETURNING *) INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) SELECT organization_id,project_id,actor_id,'github.import_failed',id::text,jsonb_build_object('reason',failure) FROM failed", [job.id, error instanceof GitHubError ? error.code : "github_import_failed"]).catch(() => {});
    }
    if (!connected || (ready && !(error instanceof GitHubError))) throw new GitHubError("github_import_outcome_unknown");
    if (error instanceof GitHubError) throw error; throw new GitHubError("github_import_failed");
  } finally {
    if (connected && locked) await db.query("SELECT pg_advisory_unlock(hashtextextended($1,918276432))", [job.id]).catch(disconnected);
    db.removeListener("error", disconnected); db.release(!connected);
  }
}
