import { sign, type KeyObject } from "node:crypto";
import { z } from "zod";
import { GitHubError } from "./github-credentials";
import { GitHubHttp } from "./github-http";
import { githubPushBinding, inspectGitHubTaskTarget, type GitHubPushBinding, type GitHubPushObservation } from "./github-task-target";
import { taskPushRef } from "./task-push-protocol";
import { githubAppConfig, githubId, appResponse, installationResponse, repositoriesResponse, tokenResponse, branchResponse,
  type GitHubAppConfig, type GitHubInstallationEvidence, type GitHubRepositoryEvidence } from "./github-schema";

export type GitHubGitRead = (kind: "advertise" | "upload", body?: Uint8Array, compressed?: boolean, signal?: AbortSignal) => Promise<Response>;
export type GitHubReadObservation = Omit<GitHubRepositoryEvidence, "tokenRevoked">;
export function githubAppJwt(config: GitHubAppConfig, key: KeyObject, now = Date.now()) {
  if (key.type !== "private" || key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new GitHubError("github_invalid_private_key");
  const input = githubAppConfig.parse(config), time = Math.floor(now / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iat: time - 60, exp: time + 540, iss: input.appId })).toString("base64url");
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), key).toString("base64url")}`;
}
/** Only generated github.com endpoints. Transport injection is a test seam,
 * never a database/browser/CLI-provided URL or proxy setting. No redirects,
 * automatic mutation retries, response-body errors or credential-bearing logs. */
export class GitHubReadClient {
  readonly config: GitHubAppConfig;
  private readonly http: GitHubHttp;
  constructor(config: GitHubAppConfig, private readonly key: KeyObject, private readonly transport: typeof fetch = fetch) {
    this.config = githubAppConfig.parse(config); this.http = new GitHubHttp(transport);
  }
  async inspectInstallation(signal: AbortSignal = AbortSignal.timeout(30_000)): Promise<GitHubInstallationEvidence> {
    signal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    try {
      const jwt = githubAppJwt(this.config, this.key);
      const app = appResponse.parse(await this.http.request("GET", "/app", jwt, signal));
      const installation = installationResponse.parse(await this.http.request("GET", `/app/installations/${this.config.installationId}`, jwt, signal));
      if (app.id !== this.config.appId || installation.app_id !== app.id || installation.id !== this.config.installationId || installation.account.id !== this.config.accountId) throw new GitHubError("github_installation_mismatch");
      if (installation.suspended_at !== null) throw new GitHubError("github_installation_suspended");
      if (!["read", "write"].includes(installation.permissions.contents ?? "")) throw new GitHubError("github_contents_permission_required");
      return { version: 1, appId: app.id, appSlug: app.slug, installationId: installation.id, accountId: installation.account.id, accountLogin: installation.account.login,
        accountType: installation.account.type, repositorySelection: installation.repository_selection, permissions: installation.permissions, verifiedAt: new Date().toISOString() };
    } catch (error) { if (error instanceof z.ZodError) throw new GitHubError("github_invalid_response"); throw error; }
  }
  async inspectRepository(rawRepositoryId: string, external: AbortSignal = AbortSignal.timeout(30_000)): Promise<GitHubRepositoryEvidence> {
    return (await this.withRepository(rawRepositoryId, async () => undefined, external, 30_000)).evidence;
  }
  /** Trusted import broker only. The callback receives a fixed upload-pack
   * capability, never the App key/token or an arbitrary authenticated URL. */
  async readGitRepository<T>(repositoryId: string, consume: (evidence: GitHubReadObservation, read: GitHubGitRead, signal: AbortSignal) => Promise<T>, external: AbortSignal = AbortSignal.timeout(180_000)) {
    return this.withRepository(repositoryId, consume, external, 180_000);
  }
  /** Push preview uses only a read token and upload-pack. Ref/protection and
   * repository observations must stay consistent around the baseline download.
   * A future write still needs a separate credential and current final gate. */
  async readTaskPushTarget<T>(raw: GitHubPushBinding, scope: { taskId: string; workspaceId: string },
    consume: (evidence: GitHubReadObservation, read: GitHubGitRead, signal: AbortSignal) => Promise<T>, external: AbortSignal = AbortSignal.timeout(180000)) {
    const binding = githubPushBinding.parse(raw), ref = taskPushRef(scope), branch = ref.slice("refs/heads/".length);
    if (binding.ownerId !== this.config.accountId) throw new GitHubError("github_push_binding_mismatch");
    if (branch === binding.defaultBranch || binding.integrationBranches.includes(branch)) throw new GitHubError("github_push_protected_destination");
    const result = await this.withRepository(binding.githubRepositoryId, consume, external, 180000, { binding, ref });
    if (!result.target) throw new GitHubError("github_invalid_response");
    return { evidence: result.evidence, value: result.value, target: result.target };
  }
  private async withRepository<T>(rawRepositoryId: string, consume: (evidence: GitHubReadObservation, read: GitHubGitRead, signal: AbortSignal) => Promise<T>, external: AbortSignal, timeout: number,
    task?: { binding: GitHubPushBinding; ref: string }): Promise<{ evidence: GitHubRepositoryEvidence; value: T; target?: GitHubPushObservation }> {
    const repositoryId = githubId.parse(rawRepositoryId), signal = AbortSignal.any([external, AbortSignal.timeout(timeout)]);
    const installation = await this.inspectInstallation(signal);
    if (task && installation.permissions.contents !== "write") throw new GitHubError("github_contents_write_required");
    let bearer: string | undefined, failure: unknown, result: GitHubReadObservation | undefined, value: T | undefined, target: GitHubPushObservation | undefined;
    try {
      const raw = await this.http.request("POST", `/app/installations/${this.config.installationId}/access_tokens`, githubAppJwt(this.config, this.key), signal,
        { repository_ids: [Number(repositoryId)], permissions: { contents: "read" } });
      // Capture a syntactically safe token for revocation even if the remaining
      // response proves wrong scope, permissions or expiry. Never return it.
      const token = tokenResponse.shape.token.safeParse((raw as { token?: unknown })?.token); if (token.success) bearer = token.data;
      const issued = tokenResponse.parse(raw), lifetime = Date.parse(issued.expires_at) - Date.now();
      if (lifetime < 60_000 || lifetime > 3_720_000 || issued.permissions.contents !== "read" || Object.entries(issued.permissions).some(([name, level]) => !["contents", "metadata"].includes(name) || level !== "read")) throw new GitHubError("github_token_scope_mismatch");
      const listing = repositoriesResponse.parse(await this.http.request("GET", "/installation/repositories?per_page=2&page=1", issued.token, signal));
      const repository = listing.repositories[0];
      if (repository.id !== repositoryId || repository.owner.id !== installation.accountId) throw new GitHubError("github_repository_mismatch");
      if (repository.archived || repository.disabled) throw new GitHubError("github_repository_inactive");
      if (repository.visibility !== undefined && repository.private !== (repository.visibility !== "public")) throw new GitHubError("github_invalid_response");
      const branch = branchResponse.parse(await this.http.request("GET", `/repos/${repository.owner.login}/${repository.name}/branches/${encodeURIComponent(repository.default_branch)}`, issued.token, signal));
      if (branch.name !== repository.default_branch || Date.parse(issued.expires_at) < Date.now() + 5000) throw new GitHubError("github_repository_mismatch");
      result = { version: 1, installation, repositoryId, nodeId: repository.node_id, ownerId: repository.owner.id, ownerLogin: repository.owner.login, name: repository.name,
        defaultBranch: branch.name, targetSha: branch.commit.sha, visibility: repository.visibility ?? "unknown", private: repository.private, branchProtected: branch.protected,
        htmlUrl: `https://github.com/${repository.owner.login}/${repository.name}`, verifiedAt: new Date().toISOString(), tokenExpiresAt: issued.expires_at,
        capabilities: { metadataRead: true, contentsRead: true, push: false, pullRequest: false, protectedMerge: false } };
      if (task) {
        target = await inspectGitHubTaskTarget(this.http, task.binding, task.ref, issued.token, installation, signal);
        if (target.defaultSha !== result.targetSha) throw new GitHubError("github_push_baseline_changed");
      }
      const read: GitHubGitRead = async (kind, body, compressed = false, caller = signal) => {
        if (!["advertise", "upload"].includes(kind) || (kind === "advertise" && (body || compressed)) || Date.parse(issued.expires_at) < Date.now() + 5000) throw new GitHubError("github_git_scope_invalid");
        try {
          const response = await this.transport(`https://github.com/${repository.owner.login}/${repository.name}.git/${kind === "advertise" ? "info/refs?service=git-upload-pack" : "git-upload-pack"}`, {
            method: kind === "advertise" ? "GET" : "POST", redirect: "error", signal: AbortSignal.any([signal, caller, AbortSignal.timeout(60_000)]),
            headers: { Authorization: `Basic ${Buffer.from(`x-access-token:${issued.token}`).toString("base64")}`, "User-Agent": "pi-collab/0.1", "Git-Protocol": "version=2",
              ...(kind === "upload" ? { "Content-Type": "application/x-git-upload-pack-request", ...(compressed ? { "Content-Encoding": "gzip" } : {}) } : {}) },
            ...(body ? { body: new Uint8Array(body) } : {}),
          });
          if (response.status !== 200 || response.headers.get("content-type")?.split(";")[0] !== `application/x-git-upload-pack-${kind === "advertise" ? "advertisement" : "result"}`) {
            await response.body?.cancel().catch(() => {}); throw new GitHubError("github_git_response_invalid");
          }
          return response;
        } catch (error) { if (error instanceof GitHubError) throw error; throw new GitHubError(signal.aborted || caller.aborted ? "github_request_cancelled" : "github_git_transport_unavailable"); }
      };
      value = await consume(result, read, signal);
      if (task && target) {
        const after = await inspectGitHubTaskTarget(this.http, task.binding, task.ref, issued.token, await this.inspectInstallation(signal), signal);
        if (after.defaultSha !== target.defaultSha || after.observedOld !== target.observedOld) throw new GitHubError("github_push_target_changed");
        target = after;
      }
    } catch (error) { failure = error instanceof z.ZodError ? new GitHubError("github_invalid_response") : error; }
    finally {
      if (bearer) {
        try { await this.http.request("DELETE", "/installation/token", bearer, AbortSignal.timeout(5000)); }
        catch { failure ??= new GitHubError("github_token_revocation_unconfirmed"); }
        bearer = undefined;
      }
    }
    if (failure) throw failure;
    if (!result) throw new GitHubError("github_invalid_response");
    return { evidence: { ...result, tokenRevoked: true }, value: value as T, ...(target ? { target } : {}) };
  }
}
