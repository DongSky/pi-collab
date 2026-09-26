import { createHash, type KeyObject } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { GitHubHttp } from "./github-http";
import { GitHubError } from "./github-credentials";
import { GitHubReadClient, githubAppJwt } from "./github-client";
import { githubAppConfig, githubBranch, githubId, repositoryResponse, repositoriesResponse, branchResponse, tokenResponse, type GitHubAppConfig, type GitHubInstallationEvidence } from "./github-schema";
import { githubPushBinding, type GitHubPushBinding } from "./github-task-target";
import { taskPushRef } from "./task-push-protocol";

const sha = z.string().regex(/^[a-f0-9]{40}$/).refine(value => value !== "0".repeat(40));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const taskPullSource = z.object({ taskId: z.uuid(), workspaceId: z.uuid(), headSha: sha }).strict();
export const taskPullIntent = z.object({ operationId: z.uuid(), deliveryId: z.uuid(), repositoryId: z.uuid(), taskId: z.uuid(), workspaceId: z.uuid(),
  headSha: sha, baseSha: sha, manifestHash: hash, title: z.string().trim().min(1).max(256).regex(/^[^\x00-\x1f\x7f]+$/),
  body: z.string().min(1).max(48000).refine(value => !value.includes("\0")),
}).strict().refine(value => value.headSha !== value.baseSha);
export type TaskPullIntent = z.infer<typeof taskPullIntent>;
type CreateBody = { title: string; head: string; base: string; body: string; draft: true; maintainer_can_modify: false };
export type TaskPullAttempt = { intent: TaskPullIntent; binding: GitHubPushBinding; ref: string; request: CreateBody; requestHash: string; requestBytes: number };
const digest = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const fail = (code: string): never => { throw new GitHubError(code); };
const code = (error: unknown) => error instanceof GitHubError ? error.code : error instanceof z.ZodError ? "github_invalid_response" : "github_pull_authority_unavailable";

/** Preparation does not prove SQL authority or an acknowledged delivery. The
 * durable broker must derive this input from that exact recorded delivery. */
export class PreparedTaskPull {
  #used = false;
  private constructor(private readonly value: TaskPullAttempt) {}
  static prepare(rawBinding: GitHubPushBinding, raw: TaskPullIntent) {
    const binding = githubPushBinding.parse(rawBinding), intent = taskPullIntent.parse(raw);
    const ref = taskPushRef({ taskId: intent.taskId, workspaceId: intent.workspaceId }), branch = ref.slice("refs/heads/".length);
    if (intent.repositoryId !== binding.repositoryId || branch === binding.defaultBranch || binding.integrationBranches.includes(branch)) fail("github_pull_binding_mismatch");
    const request: CreateBody = { title: intent.title, head: branch, base: binding.defaultBranch,
      body: `${intent.body}\n\n---\npi-collab draft · operation ${intent.operationId}\nDelivery: ${intent.deliveryId}\nHead: ${intent.headSha}\nBase observed: ${intent.baseSha}\nExport SHA-256: ${intent.manifestHash}\n\nThis reference records the requested versions; it does not attest CI, review, or merge eligibility.`,
      draft: true, maintainer_can_modify: false };
    const bytes = JSON.stringify(request); if (Buffer.byteLength(request.body) > 60000) fail("github_pull_body_too_large");
    return new PreparedTaskPull({ intent, binding, ref, request, requestHash: digest(bytes), requestBytes: Buffer.byteLength(bytes) });
  }
  get attempt(): TaskPullAttempt { return structuredClone(this.value); }
  consume(): TaskPullAttempt {
    if (this.#used) fail("github_pull_attempt_consumed"); this.#used = true; return this.attempt;
  }
}

const embeddedRepository = repositoryResponse.pick({ id: true, node_id: true, name: true, owner: true, private: true });
const side = z.object({ ref: githubBranch, sha, repo: embeddedRepository });
const pullIdentity = z.object({ id: githubId, node_id: z.string().min(1).max(200), number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), html_url: z.string().max(1000) });
const pullScope = pullIdentity.extend({ head: side, base: side, state: z.enum(["open", "closed"]) });
const pullResponse = pullScope.extend({ title: z.string().max(1000), body: z.string().max(100000).nullable(), draft: z.boolean(), merged: z.boolean(),
  merge_commit_sha: sha.nullable(), maintainer_can_modify: z.boolean(), updated_at: z.iso.datetime() });
export type TaskPullIdentity = { id: string; nodeId: string; number: number; url: string };
export type TaskPullSnapshot = { identity: TaskPullIdentity; headRef: string; headSha: string; baseRef: string; baseSha: string;
  titleHash: string; bodyHash: string; state: "open" | "closed"; draft: boolean; merged: boolean; mergeCommitSha: string | null;
  maintainerCanModify: boolean; updatedAt: string; observedAt: string };
export type TaskPullPreflight = { version: 1; installation: GitHubInstallationEvidence; repository: GitHubPushBinding;
  headRef: string; headSha: string; baseRef: string; baseSha: string; baseProtected: boolean; verifiedAt: string };
export type TaskPullResult = { createStarted: boolean; failure: string | null; evidence: TaskPullPreflight | null;
  credential: { status: "not_requested" | "issuance_unconfirmed" | "revoked" | "revocation_unconfirmed"; expiresAt: string | null };
  outcome: { status: "not_created"; reason: "preflight_failed" | "authority_denied" | "cancelled" | "existing_pull"; existing?: TaskPullIdentity[] }
    | { status: "rejected"; httpStatus: 403 | 422 }
    | { status: "unknown"; reason: "creation_unconfirmed" }
    | { status: "created"; pull: TaskPullIdentity; creation: TaskPullSnapshot; current: TaskPullSnapshot | null; revision: "matching" | "changed" | "unavailable" } };

function repositoryIdentity(raw: z.infer<typeof embeddedRepository>, binding: GitHubPushBinding) {
  if (raw.id !== binding.githubRepositoryId || raw.node_id !== binding.nodeId || raw.name !== binding.name || raw.owner.id !== binding.ownerId
    || raw.owner.login !== binding.ownerLogin || raw.private !== binding.private) fail("github_pull_repository_changed");
}
function scope(raw: unknown, binding: GitHubPushBinding) {
  const value = pullScope.parse(raw); repositoryIdentity(value.base.repo, binding); repositoryIdentity(value.head.repo, binding);
  const url = `https://github.com/${binding.ownerLogin}/${binding.name}/pull/${value.number}`;
  if (value.html_url !== url) fail("github_pull_identity_mismatch");
  return { value, identity: { id: value.id, nodeId: value.node_id, number: value.number, url } };
}
export function readTaskPullSnapshot(raw: unknown, binding: GitHubPushBinding, expected?: TaskPullIdentity): TaskPullSnapshot {
  const { identity } = scope(raw, binding), value = pullResponse.parse(raw);
  if (expected && (identity.id !== expected.id || identity.number !== expected.number || identity.nodeId !== expected.nodeId)) fail("github_pull_identity_mismatch");
  // Ref/SHA/state/content differences are observations, never new approvals.
  return { identity, headRef: value.head.ref, headSha: value.head.sha, baseRef: value.base.ref, baseSha: value.base.sha,
    titleHash: digest(value.title), bodyHash: digest(value.body ?? ""), state: value.state, draft: value.draft, merged: value.merged,
    mergeCommitSha: value.merge_commit_sha, maintainerCanModify: value.maintainer_can_modify, updatedAt: value.updated_at, observedAt: new Date().toISOString() };
}
function matches(value: TaskPullSnapshot, attempt: TaskPullAttempt) {
  return value.headRef === attempt.request.head && value.baseRef === attempt.request.base && value.headSha === attempt.intent.headSha && value.baseSha === attempt.intent.baseSha
    && value.titleHash === digest(attempt.request.title) && value.bodyHash === digest(attempt.request.body) && value.state === "open" && value.draft && !value.merged && !value.maintainerCanModify;
}

/** Trusted broker only. Fixed github.com routes, no caller URL/refspec and no
 * content-write, review or merge capability. SQL supplies durable admission and
 * the mandatory final authorization; this object alone is not a queue. */
export class GitHubTaskPullClient {
  readonly config: GitHubAppConfig;
  private readonly http: GitHubHttp;
  private readonly reader: GitHubReadClient;
  constructor(config: GitHubAppConfig, private readonly key: KeyObject, transport: typeof fetch = fetch) {
    this.config = Object.freeze(githubAppConfig.parse(config)); this.http = new GitHubHttp(transport); this.reader = new GitHubReadClient(this.config, key, transport);
  }
  private async observeTarget(binding: GitHubPushBinding, ref: string, headSha: string, expectedBase: string | null, bearer: string, signal: AbortSignal): Promise<TaskPullPreflight> {
    const installation = await this.reader.inspectInstallation(signal), headRef = ref.slice("refs/heads/".length);
    if (installation.permissions.pull_requests !== "write") fail("github_pull_permission_required");
    const checkRepository = (raw: unknown) => {
      const value = repositoryResponse.parse(raw); repositoryIdentity(value, binding);
      if (value.default_branch !== binding.defaultBranch || value.visibility !== binding.visibility || value.archived || value.disabled) fail("github_pull_repository_changed");
    };
    const listing = repositoriesResponse.parse(await this.http.request("GET", "/installation/repositories?per_page=2&page=1", bearer, signal)); checkRepository(listing.repositories[0]);
    checkRepository(await this.http.request("GET", `/repositories/${binding.githubRepositoryId}`, bearer, signal));
    const route = `/repos/${binding.ownerLogin}/${binding.name}`;
    const pointer = z.object({ ref: z.string(), object: z.object({ type: z.literal("commit"), sha }) });
    let capturedBase = expectedBase;
    const read = async () => {
      const head = pointer.parse(await this.http.request("GET", `${route}/git/ref/heads/${encodeURIComponent(headRef)}`, bearer, signal));
      const base = branchResponse.parse(await this.http.request("GET", `${route}/branches/${encodeURIComponent(binding.defaultBranch)}`, bearer, signal));
      capturedBase ??= base.commit.sha;
      if (head.ref !== ref || head.object.sha !== headSha || base.name !== binding.defaultBranch || base.commit.sha !== capturedBase) fail("github_pull_revision_changed");
      return base;
    };
    await read(); checkRepository(await this.http.request("GET", `/repositories/${binding.githubRepositoryId}`, bearer, signal)); const base = await read();
    return { version: 1, installation, repository: structuredClone(binding), headRef, headSha,
      baseRef: binding.defaultBranch, baseSha: base.commit.sha, baseProtected: base.protected, verifiedAt: new Date().toISOString() };
  }
  private preflight(attempt: TaskPullAttempt, bearer: string, signal: AbortSignal) {
    return this.observeTarget(attempt.binding, attempt.ref, attempt.intent.headSha, attempt.intent.baseSha, bearer, signal);
  }
  private async existing(binding: GitHubPushBinding, headRef: string, bearer: string, signal: AbortSignal): Promise<TaskPullIdentity[]> {
    const existing = z.array(pullScope).max(2).parse(await this.http.request("GET", `/repos/${binding.ownerLogin}/${binding.name}/pulls?state=open&head=${encodeURIComponent(`${binding.ownerLogin}:${headRef}`)}&base=${encodeURIComponent(binding.defaultBranch)}&per_page=2&page=1`, bearer, signal));
    return existing.map(raw => {
      const value = scope(raw, binding);
      if (value.value.head.ref !== headRef || value.value.base.ref !== binding.defaultBranch || value.value.state !== "open") fail("github_pull_identity_mismatch");
      return value.identity;
    });
  }
  /** Read-only preparation can observe a newer default baseline without another
   * push. The caller must durably bind and show these versions before dispatch;
   * an existing PR is only observed and never adopted using its mutable body. */
  async preview(rawBinding: GitHubPushBinding, rawSource: z.infer<typeof taskPullSource>, external?: AbortSignal) {
    const binding = githubPushBinding.parse(rawBinding), source = taskPullSource.parse(rawSource), ref = taskPushRef({ taskId: source.taskId, workspaceId: source.workspaceId });
    const branch = ref.slice("refs/heads/".length);
    if (binding.ownerId !== this.config.accountId || branch === binding.defaultBranch || binding.integrationBranches.includes(branch)) fail("github_pull_binding_mismatch");
    const signal = AbortSignal.any([external ?? new AbortController().signal, AbortSignal.timeout(90000)]);
    let bearer: string | undefined, failure: unknown;
    let value: { target: TaskPullPreflight; existing: TaskPullIdentity[]; tokenExpiresAt: string; tokenRevoked: true } | undefined;
    try {
      signal.throwIfAborted();
      const installation = await this.reader.inspectInstallation(signal);
      if (installation.permissions.pull_requests !== "write") fail("github_pull_permission_required");
      const rawToken = await this.http.request("POST", `/app/installations/${this.config.installationId}/access_tokens`, githubAppJwt(this.config, this.key), signal,
        { repository_ids: [Number(binding.githubRepositoryId)], permissions: { contents: "read", pull_requests: "read" } });
      const safe = tokenResponse.shape.token.safeParse((rawToken as { token?: unknown })?.token); if (safe.success) bearer = safe.data;
      const issued = tokenResponse.parse(rawToken), lifetime = Date.parse(issued.expires_at) - Date.now();
      if (lifetime < 60000 || lifetime > 3720000 || issued.permissions.contents !== "read" || issued.permissions.pull_requests !== "read"
        || Object.entries(issued.permissions).some(([name, level]) => !["contents", "pull_requests", "metadata"].includes(name) || level !== "read")) fail("github_token_scope_mismatch");
      const before = await this.observeTarget(binding, ref, source.headSha, null, bearer!, signal);
      const existing = await this.existing(binding, branch, bearer!, signal);
      const target = await this.observeTarget(binding, ref, source.headSha, before.baseSha, bearer!, signal);
      if (signal.aborted || Date.parse(issued.expires_at) < Date.now() + 5000) fail("github_request_cancelled");
      value = { target, existing, tokenExpiresAt: issued.expires_at, tokenRevoked: true };
    } catch (error) { failure = signal.aborted ? new GitHubError("github_request_cancelled") : error instanceof GitHubError ? error : new GitHubError(code(error)); }
    finally {
      if (bearer) {
        try { await this.http.request("DELETE", "/installation/token", bearer, AbortSignal.timeout(5000)); }
        catch { failure ??= new GitHubError("github_token_revocation_unconfirmed"); }
        bearer = undefined;
      }
    }
    if (failure) throw failure;
    if (!value) throw new GitHubError("github_invalid_response"); return value;
  }
  async execute(prepared: PreparedTaskPull,
    authorize: (value: { attempt: TaskPullAttempt; evidence: TaskPullPreflight; evidenceHash: string }) => Promise<boolean>, external?: AbortSignal): Promise<TaskPullResult> {
    const consumed = prepared.consume(), attempt = PreparedTaskPull.prepare(consumed.binding, consumed.intent).attempt, binding = attempt.binding;
    if (!isDeepStrictEqual(consumed, attempt)) fail("github_pull_request_mismatch");
    if (binding.ownerId !== this.config.accountId) fail("github_pull_binding_mismatch");
    const signal = AbortSignal.any([external ?? new AbortController().signal, AbortSignal.timeout(180000)]);
    const result: TaskPullResult = { createStarted: false, failure: null, evidence: null, credential: { status: "not_requested", expiresAt: null }, outcome: { status: "not_created", reason: "preflight_failed" } };
    let bearer: string | undefined;
    try {
      signal.throwIfAborted();
      const installation = await this.reader.inspectInstallation(signal);
      if (installation.permissions.pull_requests !== "write") fail("github_pull_permission_required");
      result.credential.status = "issuance_unconfirmed";
      const rawToken = await this.http.request("POST", `/app/installations/${this.config.installationId}/access_tokens`, githubAppJwt(this.config, this.key), signal,
        { repository_ids: [Number(binding.githubRepositoryId)], permissions: { contents: "read", pull_requests: "write" } });
      const safe = tokenResponse.shape.token.safeParse((rawToken as { token?: unknown })?.token); if (safe.success) bearer = safe.data;
      const issued = tokenResponse.parse(rawToken), lifetime = Date.parse(issued.expires_at) - Date.now();
      if (lifetime < 60000 || lifetime > 3720000 || issued.permissions.contents !== "read" || issued.permissions.pull_requests !== "write"
        || Object.entries(issued.permissions).some(([name, level]) => name === "contents" ? level !== "read" : name === "pull_requests" ? level !== "write" : name !== "metadata" || level !== "read")) fail("github_token_scope_mismatch");
      result.credential.expiresAt = issued.expires_at;
      result.evidence = await this.preflight(attempt, bearer!, signal);
      const route = `/repos/${binding.ownerLogin}/${binding.name}/pulls`;
      const existing = await this.existing(binding, attempt.request.head, bearer!, signal);
      if (existing.length) {
        result.outcome = { status: "not_created", reason: "existing_pull", existing }; return result;
      }
      result.evidence = await this.preflight(attempt, bearer!, signal);
      const evidence = structuredClone(result.evidence);
      if (await authorize({ attempt: structuredClone(attempt), evidence, evidenceHash: digest(JSON.stringify(evidence)) }) !== true) {
        result.outcome = { status: "not_created", reason: "authority_denied" }; return result;
      }
      if (signal.aborted) { result.outcome = { status: "not_created", reason: "cancelled" }; return result; }
      if (Date.parse(issued.expires_at) < Date.now() + 5000) fail("github_request_cancelled");
      if (digest(JSON.stringify(attempt.request)) !== attempt.requestHash || Buffer.byteLength(JSON.stringify(attempt.request)) !== attempt.requestBytes) fail("github_pull_request_mismatch");
      // GitHub has no expected-head/base parameter for creation. A positive
      // acknowledgement or documented rejection is required to settle a POST.
      result.createStarted = true; result.outcome = { status: "unknown", reason: "creation_unconfirmed" };
      const created = readTaskPullSnapshot(await this.http.request("POST", route, bearer!, signal, attempt.request), binding);
      result.outcome = { status: "created", pull: created.identity, creation: created, current: null, revision: "unavailable" };
      // Preserve positive creation evidence if subsequent read or cleanup fails.
      const current = readTaskPullSnapshot(await this.http.request("GET", `${route}/${created.identity.number}`, bearer!, signal), binding, created.identity);
      result.outcome.current = current;
      if (!matches(created, attempt) || !matches(current, attempt)) result.outcome.revision = "changed";
      await this.preflight(attempt, bearer!, signal);
      result.outcome.revision = matches(created, attempt) && matches(current, attempt) ? "matching" : "changed";
    } catch (error) {
      result.failure = signal.aborted ? "github_request_cancelled" : code(error);
      if (result.outcome.status === "unknown" && error instanceof GitHubError && [403, 422].includes(error.status ?? 0)) {
        // The documented create endpoint denial/validation responses prove
        // this POST was rejected. They never adopt a pre-existing PR.
        result.outcome = { status: "rejected", httpStatus: error.status as 403 | 422 };
      }
      if (!result.createStarted && signal.aborted) result.outcome = { status: "not_created", reason: "cancelled" };
      if (result.outcome.status === "created" && result.failure === "github_pull_revision_changed") result.outcome.revision = "changed";
    }
    finally {
      if (bearer) {
        try { await this.http.request("DELETE", "/installation/token", bearer, AbortSignal.timeout(5000)); result.credential.status = "revoked"; }
        catch { result.credential.status = "revocation_unconfirmed"; result.failure ??= "github_token_revocation_unconfirmed"; }
        bearer = undefined;
      }
    }
    return result;
  }
}
