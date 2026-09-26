import { pullRevisionInput, type PullRevisionInput } from "./pull-revision";
import { normalizedCheck, type NormalizedCheck } from "./pull-checks-schema";
import type { KeyObject } from "node:crypto";
import { z } from "zod";
import { GitHubError } from "./github-credentials";
import { GitHubHttp } from "./github-http";
import { GitHubReadClient, githubAppJwt } from "./github-client";
import { githubAppConfig, githubId, repositoryResponse, repositoriesResponse, tokenResponse, type GitHubAppConfig, type GitHubInstallationEvidence } from "./github-schema";
import { githubPushBinding, type GitHubPushBinding } from "./github-task-target";
import { readTaskPullSnapshot, type TaskPullIdentity, type TaskPullSnapshot } from "./github-task-pull";

import { observedPullIdentity } from "./github-pull-observation";
export type PullChecksEvidence = { version: 1; installation: GitHubInstallationEvidence; binding: GitHubPushBinding; identity: TaskPullIdentity;
  input: PullRevisionInput; snapshot: TaskPullSnapshot; checks: NormalizedCheck[]; tokenExpiresAt: string; tokenRevoked: true; completedAt: string };
const checkResponse = z.object({ id: githubId, name: z.string().min(1).max(200), head_sha: z.string().regex(/^[a-f0-9]{40}$/),
  app: z.object({ id: githubId }), check_suite: z.object({ id: githubId }), status: normalizedCheck.shape.status, conclusion: normalizedCheck.shape.conclusion,
  started_at: z.iso.datetime().nullable(), completed_at: z.iso.datetime().nullable() });
const checkPage = z.object({ total_count: z.number().int().min(0).max(1000), check_runs: z.array(checkResponse).max(100) });
/** Reads only a durably attributed PR. No listing/adoption, branch requirement,
 * update, create, review or merge method. A 404 is unavailable, never deletion. */
export class GitHubPullChecksReader {
  readonly config: GitHubAppConfig;
  private readonly http: GitHubHttp;
  private readonly reader: GitHubReadClient;
  constructor(config: GitHubAppConfig, private readonly key: KeyObject, transport: typeof fetch = fetch) {
    this.config = githubAppConfig.parse(config); this.http = new GitHubHttp(transport); this.reader = new GitHubReadClient(this.config, key, transport);
  }
  async observe(rawBinding: GitHubPushBinding, rawIdentity: TaskPullIdentity, rawInput: PullRevisionInput, external?: AbortSignal): Promise<PullChecksEvidence> {
    const binding = githubPushBinding.parse(rawBinding), identity = observedPullIdentity.parse(rawIdentity), input = pullRevisionInput.parse(rawInput);
    const fail = (code: string): never => { throw new GitHubError(code); };
    if (input.githubRepositoryId !== binding.githubRepositoryId || input.pullId !== identity.id || input.pullNumber !== identity.number || binding.ownerId !== this.config.accountId || identity.url !== `https://github.com/${binding.ownerLogin}/${binding.name}/pull/${identity.number}`) fail("github_pull_identity_mismatch");
    const signal = AbortSignal.any([external ?? new AbortController().signal, AbortSignal.timeout(90000)]);
    let bearer: string | undefined, failure: unknown, result: Omit<PullChecksEvidence, "tokenRevoked" | "completedAt"> | undefined;
    try {
      signal.throwIfAborted();
      const installation = await this.reader.inspectInstallation(signal);
      if (!["read", "write"].includes(installation.permissions.checks ?? "")) fail("github_checks_permission_required");
      if (!["read", "write"].includes(installation.permissions.pull_requests ?? "")) fail("github_pull_permission_required");
      const raw = await this.http.request("POST", `/app/installations/${this.config.installationId}/access_tokens`, githubAppJwt(this.config, this.key), signal,
        { repository_ids: [Number(binding.githubRepositoryId)], permissions: { contents: "read", pull_requests: "read", checks: "read" } });
      const safe = tokenResponse.shape.token.safeParse((raw as { token?: unknown })?.token); if (safe.success) bearer = safe.data;
      const issued = tokenResponse.parse(raw), lifetime = Date.parse(issued.expires_at) - Date.now();
      if (lifetime < 60000 || lifetime > 3720000 || issued.permissions.contents !== "read" || issued.permissions.pull_requests !== "read" || issued.permissions.checks !== "read"
        || Object.entries(issued.permissions).some(([name, level]) => !["contents", "pull_requests", "checks", "metadata"].includes(name) || level !== "read")) fail("github_token_scope_mismatch");
      const repository = (raw: unknown) => {
        const value = repositoryResponse.parse(raw);
        if (value.id !== binding.githubRepositoryId || value.node_id !== binding.nodeId || value.owner.id !== binding.ownerId || value.owner.login !== binding.ownerLogin
          || value.name !== binding.name || value.private !== binding.private || value.visibility !== binding.visibility || value.default_branch !== binding.defaultBranch
          || value.archived || value.disabled) fail("github_pull_repository_changed");
      };
      const listing = repositoriesResponse.parse(await this.http.request("GET", "/installation/repositories?per_page=2&page=1", bearer!, signal));
      repository(listing.repositories[0]); repository(await this.http.request("GET", `/repositories/${binding.githubRepositoryId}`, bearer!, signal));
      const pull = async () => {
        const value = readTaskPullSnapshot(await this.http.request("GET", `/repos/${binding.ownerLogin}/${binding.name}/pulls/${identity.number}`, bearer!, signal), binding, identity);
        if (value.headSha !== input.headSha || value.baseSha !== input.baseSha || value.headRef !== input.headRef || value.baseRef !== input.baseRef)
          fail("github_checks_revision_changed");
        if (value.state !== "open" || value.merged) fail("github_checks_pull_closed");
        return value;
      };
      await pull();
      const readChecks = async () => {
        const checks: NormalizedCheck[] = []; let total: number | undefined;
        for (let page = 1; page <= 10; page++) {
          const value = checkPage.parse(await this.http.request("GET", `/repos/${binding.ownerLogin}/${binding.name}/commits/${input.headSha}/check-runs?filter=latest&per_page=100&page=${page}`, bearer!, signal));
          if (total !== undefined && total !== value.total_count) fail("github_checks_changed"); total = value.total_count;
          for (const c of value.check_runs) {
            if (c.head_sha !== input.headSha || (c.status === "completed" ? c.conclusion === null || c.completed_at === null : c.conclusion !== null || c.completed_at !== null)) fail("github_invalid_checks");
            if (c.started_at && Date.parse(c.started_at) > Date.now() + 5000) fail("github_invalid_checks");
            if (c.completed_at && (Date.parse(c.completed_at) > Date.now() + 5000 || (c.started_at && Date.parse(c.started_at) > Date.parse(c.completed_at)))) fail("github_invalid_checks");
            checks.push(normalizedCheck.parse({ id: c.id, name: c.name, appId: c.app.id, suiteId: c.check_suite.id, headSha: c.head_sha,
              status: c.status, conclusion: c.conclusion, startedAt: c.started_at, completedAt: c.completed_at }));
          }
          if (checks.length === total) break;
          if (checks.length > total || value.check_runs.length !== 100) fail("github_checks_incomplete");
        }
        if (checks.length !== total || new Set(checks.map(c => c.id)).size !== checks.length) fail("github_checks_incomplete");
        return checks.sort((a,b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
      };
      const checks = await readChecks();
      if (JSON.stringify(checks) !== JSON.stringify(await readChecks())) fail("github_checks_changed");
      const snapshot = await pull();
      repository(await this.http.request("GET", `/repositories/${binding.githubRepositoryId}`, bearer!, signal));
      const after = await this.reader.inspectInstallation(signal);
      if (!["read", "write"].includes(after.permissions.checks ?? "")) fail("github_checks_permission_required");
      if (!["read", "write"].includes(after.permissions.pull_requests ?? "")) fail("github_pull_permission_required");
      if (signal.aborted || Date.parse(issued.expires_at) < Date.now() + 5000) fail("github_request_cancelled");
      result = { version: 1, installation: after, binding, identity, input, snapshot, checks, tokenExpiresAt: issued.expires_at };
    } catch (error) {
      failure = signal.aborted ? new GitHubError("github_request_cancelled") : error instanceof GitHubError ? error : new GitHubError("github_invalid_response");
    } finally {
      if (bearer) {
        try { await this.http.request("DELETE", "/installation/token", bearer, AbortSignal.timeout(5000)); }
        catch { failure ??= new GitHubError("github_token_revocation_unconfirmed"); }
        bearer = undefined;
      }
    }
    if (failure) throw failure;
    if (!result) throw new GitHubError("github_invalid_response");
    return { ...result, tokenRevoked: true, completedAt: new Date().toISOString() };
  }
}
