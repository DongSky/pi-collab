import { lstat } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { z } from "zod";
import { GitHubError, openGitHubKey } from "./github-credentials";
import { githubAppConfig, type GitHubRepositoryEvidence } from "./github-schema";
import { GitHubReadClient } from "./github-client";
import { downloadGitHubGit, verifyImportedGit, importGit } from "./github-pack";
import { importDirectory, readImportReceipt, writeImportReceipt } from "./github-import-receipt";

const claimSchema = z.object({ claimId: z.uuid(), mode: z.enum(["import", "reconcile"]), job: z.object({ id: z.uuid(), repository_id: z.uuid(),
  organization_id: z.uuid(), project_id: z.uuid(), connection_id: z.uuid(), installation_version: z.coerce.string().regex(/^[1-9][0-9]*$/), github_repository_id: z.string() }) });
type Options = { transport?: typeof fetch; signal?: AbortSignal; afterClaim?: (id: string) => Promise<void>;
  afterReceipt?: (id: string) => Promise<void>; beforeFinalize?: (id: string) => Promise<void>; beforeCommit?: (id: string) => Promise<void> };

/** A new import writes only its reserved directory. Recovery reads the original
 * HMAC receipt and Git objects; it never repeats the download or reuses a path.
 * master() returns an owned key buffer which is wiped before releasing the claim. */
export async function processGitImport(pool: Pool, root: string, master: () => Promise<Buffer>, options: Options = {}) {
  const db = await pool.connect(), lost = new AbortController();
  const signal = AbortSignal.any([lost.signal, options.signal ?? AbortSignal.timeout(240_000), AbortSignal.timeout(240_000)]);
  let claim: z.infer<typeof claimSchema> | undefined, keyBytes: Buffer | undefined;
  const disconnected = () => lost.abort(); db.on("error", disconnected);
  try {
    const raw = (await db.query("SELECT collab_git.claim_import() AS result")).rows[0].result;
    if (!raw) return null;
    if (raw.attentionJob) return { jobId: z.uuid().parse(raw.attentionJob), status: "attention" };
    claim = claimSchema.parse(raw); const { job, claimId, mode } = claim;
    await db.query("SELECT set_config('application_name',$1,false)", [`pi-collab-git-import:${job.id}`]);
    await options.afterClaim?.(job.id);
    const connection = (await db.query("SELECT collab_git.begin_import($1,$2) AS result", [job.id, claimId])).rows[0].result;
    keyBytes = await master(); const directory = await importDirectory(root, job);
    let evidence: GitHubRepositoryEvidence;
    if (mode === "import") {
      const config = githubAppConfig.parse({ appId: connection.appId, installationId: connection.installationId, accountId: connection.accountId });
      const client = new GitHubReadClient(config, openGitHubKey(keyBytes, { ...config, connectionId: job.connection_id, organizationId: job.organization_id }, connection.sealed), options.transport);
      evidence = (await client.readGitRepository(job.github_repository_id, (observed, read, deadline) => downloadGitHubGit(directory, observed, read, deadline), signal)).evidence;
      if (signal.aborted) throw new GitHubError("github_request_cancelled");
      await writeImportReceipt(directory, keyBytes, job, evidence);
      await options.afterReceipt?.(job.id);
    }
    // Even a freshly produced receipt is verified before publication. Recovery
    // never contacts the provider or decrypts the App private key.
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new GitHubError("github_import_path_invalid");
    evidence = await readImportReceipt(directory, keyBytes, job);
    await verifyImportedGit(directory, evidence, signal);
    if ((await importGit(path.join(directory, "git"), ["symbolic-ref", "HEAD"], signal)).trim() !== `refs/heads/${evidence.defaultBranch}`) throw new GitHubError("github_git_baseline_mismatch");
    await options.beforeFinalize?.(job.id);
    if (signal.aborted) throw new GitHubError("github_request_cancelled");
    try {
      await db.query("BEGIN");
      const result = (await db.query("SELECT collab_git.finish_import($1,$2,$3) AS result", [job.id, claimId, evidence])).rows[0].result;
      await options.beforeCommit?.(job.id); await db.query("COMMIT"); return result;
    } catch (error) { await db.query("ROLLBACK").catch(() => {}); throw error; }
  } catch (error) {
    if (claim && !lost.signal.aborted) {
      const domain = error instanceof Error && (error as { code?: string }).code === "P0001" && ["github_import_cancelled", "github_import_authority_changed", "github_import_claim_lost", "github_connection_unavailable"].includes(error.message) ? error.message : null;
      const failure = error instanceof GitHubError ? error.code : domain ?? "github_import_broker_failed";
      const result = await db.query("SELECT collab_git.fail_import($1,$2,$3) AS result", [claim.job.id, claim.claimId, failure]).catch(() => null);
      if (result) return result.rows[0].result;
    }
    throw new GitHubError("github_import_outcome_unknown");
  } finally { keyBytes?.fill(0); lost.abort(); db.removeListener("error", disconnected); db.release(true); }
}
