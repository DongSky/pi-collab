import type { KeyObject } from "node:crypto";
import { z } from "zod";
import { GitHubError } from "./github-credentials";
import { GitHubHttp } from "./github-http";
import { GitHubReadClient, githubAppJwt } from "./github-client";
import { githubAppConfig, githubId, repositoryResponse, repositoriesResponse, tokenResponse, type GitHubAppConfig, type GitHubInstallationEvidence } from "./github-schema";
import { githubPushBinding, type GitHubPushBinding } from "./github-task-target";
import { readTaskPullSnapshot, type TaskPullIdentity, type TaskPullSnapshot } from "./github-task-pull";

export const observedPullIdentity = z.object({ id: githubId, number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), nodeId: z.string().min(1).max(200), url: z.string().max(1000) }).strict();
export type PullObservation = { version: 1; installation: GitHubInstallationEvidence; binding: GitHubPushBinding; identity: TaskPullIdentity;
  snapshot: TaskPullSnapshot; tokenExpiresAt: string; tokenRevoked: true; completedAt: string };

/** Reads only a durably attributed PR. No listing/adoption, branch requirement,
 * update, create, review or merge method. A 404 is unavailable, never deletion. */
export class GitHubPullObserver {
  readonly config: GitHubAppConfig;
  private readonly http: GitHubHttp;
  private readonly reader: GitHubReadClient;
  constructor(config: GitHubAppConfig, private readonly key: KeyObject, transport: typeof fetch = fetch) {
    this.config = githubAppConfig.parse(config); this.http = new GitHubHttp(transport); this.reader = new GitHubReadClient(this.config, key, transport);
  }
  async observe(rawBinding: GitHubPushBinding, rawIdentity: TaskPullIdentity, external?: AbortSignal): Promise<PullObservation> {
    const binding = githubPushBinding.parse(rawBinding), identity = observedPullIdentity.parse(rawIdentity);
    const fail = (code: string): never => { throw new GitHubError(code); };
    if (binding.ownerId !== this.config.accountId || identity.url !== `https://github.com/${binding.ownerLogin}/${binding.name}/pull/${identity.number}`) fail("github_pull_identity_mismatch");
    const signal = AbortSignal.any([external ?? new AbortController().signal, AbortSignal.timeout(90000)]);
    let bearer: string | undefined, failure: unknown, result: Omit<PullObservation, "tokenRevoked" | "completedAt"> | undefined;
    try {
      signal.throwIfAborted();
      const installation = await this.reader.inspectInstallation(signal);
      if (!["read", "write"].includes(installation.permissions.pull_requests ?? "")) fail("github_pull_permission_required");
      const raw = await this.http.request("POST", `/app/installations/${this.config.installationId}/access_tokens`, githubAppJwt(this.config, this.key), signal,
        { repository_ids: [Number(binding.githubRepositoryId)], permissions: { contents: "read", pull_requests: "read" } });
      const safe = tokenResponse.shape.token.safeParse((raw as { token?: unknown })?.token); if (safe.success) bearer = safe.data;
      const issued = tokenResponse.parse(raw), lifetime = Date.parse(issued.expires_at) - Date.now();
      if (lifetime < 60000 || lifetime > 3720000 || issued.permissions.contents !== "read" || issued.permissions.pull_requests !== "read"
        || Object.entries(issued.permissions).some(([name, level]) => !["contents", "pull_requests", "metadata"].includes(name) || level !== "read")) fail("github_token_scope_mismatch");
      const repository = (raw: unknown) => {
        const value = repositoryResponse.parse(raw);
        if (value.id !== binding.githubRepositoryId || value.node_id !== binding.nodeId || value.owner.id !== binding.ownerId || value.owner.login !== binding.ownerLogin
          || value.name !== binding.name || value.private !== binding.private || value.visibility !== binding.visibility || value.default_branch !== binding.defaultBranch
          || value.archived || value.disabled) fail("github_pull_repository_changed");
      };
      const listing = repositoriesResponse.parse(await this.http.request("GET", "/installation/repositories?per_page=2&page=1", bearer!, signal));
      repository(listing.repositories[0]); repository(await this.http.request("GET", `/repositories/${binding.githubRepositoryId}`, bearer!, signal));
      const snapshot = readTaskPullSnapshot(await this.http.request("GET", `/repos/${binding.ownerLogin}/${binding.name}/pulls/${identity.number}`, bearer!, signal), binding, identity);
      if (snapshot.merged && snapshot.state !== "closed") fail("github_invalid_response");
      repository(await this.http.request("GET", `/repositories/${binding.githubRepositoryId}`, bearer!, signal));
      const after = await this.reader.inspectInstallation(signal);
      if (!["read", "write"].includes(after.permissions.pull_requests ?? "")) fail("github_pull_permission_required");
      if (signal.aborted || Date.parse(issued.expires_at) < Date.now() + 5000) fail("github_request_cancelled");
      result = { version: 1, installation: after, binding, identity, snapshot, tokenExpiresAt: issued.expires_at };
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
