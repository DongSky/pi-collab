import { createHash, type KeyObject } from "node:crypto";
import { z } from "zod";
import { GitHubReadClient, githubAppJwt } from "./github-client";
import { GitHubHttp } from "./github-http";
import { GitHubError } from "./github-credentials";
import { githubAppConfig, tokenResponse, type GitHubAppConfig } from "./github-schema";
import { githubPushBinding, inspectGitHubTaskTarget, type GitHubPushBinding, type GitHubPushObservation } from "./github-task-target";
export { githubPushBinding, type GitHubPushBinding, type GitHubPushObservation } from "./github-task-target";
import { PreparedTaskPush, taskPushIntent, taskPushRef, type TaskPushAttempt, type TaskPushOutcome, type TaskPushTransport } from "./task-push-protocol";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const attemptSchema = taskPushIntent.safeExtend({ ref: z.string(), packHash: hash, requestHash: hash, requestBytes: z.number().int().min(32).max(64 * 1024 * 1024 + 4096) }).strict();
export type GitHubPushResult = { outcome: TaskPushOutcome | null; failure: string | null; receiveStarted: boolean;
  evidence: GitHubPushObservation | null; credential: { status: "not_requested" | "issuance_unconfirmed" | "revoked" | "revocation_unconfirmed"; expiresAt: string | null } };
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const fail = (code: string): never => { throw new GitHubError(code); };
const failureCode = (error: unknown) => error instanceof GitHubError ? error.code : error instanceof z.ZodError ? "github_invalid_response" : "github_push_authority_or_preparation_unavailable";
function checkRequest(body: Uint8Array | undefined, attempt: TaskPushAttempt) {
  if (!body || body.byteLength !== attempt.requestBytes) fail("github_push_request_mismatch");
  const bytes = Buffer.from(body!), line = Buffer.from(`${attempt.expectedOld ?? "0".repeat(40)} ${attempt.newSha} ${attempt.ref}\0report-status\n`);
  const prefix = Buffer.concat([Buffer.from((line.length + 4).toString(16).padStart(4, "0")), line, Buffer.from("0000")]);
  if (!bytes.subarray(0, prefix.length).equals(prefix) || digest(bytes) !== attempt.requestHash || digest(bytes.subarray(prefix.length)) !== attempt.packHash) fail("github_push_request_mismatch");
}

/** Only the trusted durable Git broker may call this client. There is no raw
 * authenticated fetch/receive capability, token or arbitrary URL in its API.
 * This class alone does not establish SQL membership, export or retry authority. */
export class GitHubTaskPushClient {
  readonly config: GitHubAppConfig;
  private readonly http: GitHubHttp;
  private readonly reader: GitHubReadClient;
  constructor(config: GitHubAppConfig, private readonly key: KeyObject, private readonly transport: typeof fetch = fetch) {
    this.config = Object.freeze(githubAppConfig.parse(config)); this.http = new GitHubHttp(transport); this.reader = new GitHubReadClient(this.config, key, transport);
  }
  private async observation(binding: GitHubPushBinding, ref: string, bearer: string, signal: AbortSignal): Promise<GitHubPushObservation> {
    return inspectGitHubTaskTarget(this.http, binding, ref, bearer, await this.reader.inspectInstallation(signal), signal);
  }
  async execute(prepared: PreparedTaskPush, raw: GitHubPushBinding,
    authorize: (value: { attempt: TaskPushAttempt; evidence: GitHubPushObservation; evidenceHash: string }) => Promise<boolean>, external?: AbortSignal): Promise<GitHubPushResult> {
    const binding = githubPushBinding.parse(raw), attempt = attemptSchema.parse(prepared.attempt);
    const ref = taskPushRef({ taskId: attempt.taskId, workspaceId: attempt.workspaceId });
    if (attempt.repositoryId !== binding.repositoryId || attempt.ref !== ref || binding.ownerId !== this.config.accountId) fail("github_push_binding_mismatch");
    const branch = ref.slice("refs/heads/".length);
    if (branch === binding.defaultBranch || binding.integrationBranches.includes(branch)) fail("github_push_protected_destination");
    const signal = AbortSignal.any([external ?? new AbortController().signal, AbortSignal.timeout(180000)]);
    const result: GitHubPushResult = { outcome: null, failure: null, receiveStarted: false, evidence: null, credential: { status: "not_requested", expiresAt: null } };
    let bearer: string | undefined, approved = false, closed = false, advertised = false;
    try {
      const installation = await this.reader.inspectInstallation(signal);
      if (installation.permissions.contents !== "write") fail("github_contents_write_required");
      result.credential.status = "issuance_unconfirmed";
      const rawToken = await this.http.request("POST", `/app/installations/${this.config.installationId}/access_tokens`, githubAppJwt(this.config, this.key), signal,
        { repository_ids: [Number(binding.githubRepositoryId)], permissions: { contents: "write" } });
      const safe = tokenResponse.shape.token.safeParse((rawToken as { token?: unknown })?.token); if (safe.success) bearer = safe.data;
      const issued = tokenResponse.parse(rawToken), lifetime = Date.parse(issued.expires_at) - Date.now();
      if (lifetime < 60000 || lifetime > 3720000 || issued.permissions.contents !== "write"
        || Object.entries(issued.permissions).some(([name, level]) => name === "contents" ? level !== "write" : name !== "metadata" || level !== "read")) fail("github_token_scope_mismatch");
      result.credential.expiresAt = issued.expires_at;
      result.evidence = await this.observation(binding, ref, bearer!, signal);
      if (result.evidence.observedOld !== attempt.expectedOld) fail("github_push_ref_changed");
      const send: TaskPushTransport = async (kind, caller, body) => {
        if (closed || signal.aborted || caller.aborted || Date.parse(issued.expires_at) < Date.now() + 5000) fail("github_git_scope_invalid");
        if (kind === "advertise") { if (advertised || body) fail("github_git_scope_invalid"); advertised = true; }
        else if (kind === "receive") {
          if (!approved || !advertised || result.receiveStarted) fail("github_git_scope_invalid");
          checkRequest(body, attempt); result.receiveStarted = true;
        } else fail("github_git_scope_invalid");
        try {
          return await this.transport(`https://github.com/${binding.ownerLogin}/${binding.name}.git/${kind === "advertise" ? "info/refs?service=git-receive-pack" : "git-receive-pack"}`, {
            method: kind === "advertise" ? "GET" : "POST", redirect: "error", signal: AbortSignal.any([signal, caller, AbortSignal.timeout(60000)]),
            headers: { Authorization: `Basic ${Buffer.from(`x-access-token:${bearer}`).toString("base64")}`, "User-Agent": "pi-collab/0.1",
              ...(kind === "receive" ? { "Content-Type": "application/x-git-receive-pack-request" } : {}) },
            ...(body ? { body: new Uint8Array(body) } : {}),
          });
        } catch { throw new GitHubError("github_git_transport_unavailable"); }
      };
      result.outcome = await prepared.execute(send, async value => {
        const current = attemptSchema.parse(value);
        if ((Object.keys(attempt) as (keyof TaskPushAttempt)[]).some(name => current[name] !== attempt[name])) fail("github_push_request_mismatch");
        // Repeat provider identity/ref/protection checks after Git preflight,
        // then the broker must durably bind this evidence and the request hash.
        result.evidence = await this.observation(binding, ref, bearer!, signal);
        if (result.evidence.observedOld !== attempt.expectedOld) fail("github_push_ref_changed");
        if (signal.aborted || Date.parse(issued.expires_at) < Date.now() + 5000) fail("github_request_cancelled");
        const evidence = structuredClone(result.evidence);
        approved = await authorize({ attempt: Object.freeze({ ...attempt }), evidence, evidenceHash: digest(JSON.stringify(evidence)) }) === true;
        return approved;
      }, signal);
    } catch (error) { result.failure = failureCode(error); }
    finally {
      closed = true;
      if (bearer) {
        try { await this.http.request("DELETE", "/installation/token", bearer, AbortSignal.timeout(5000)); result.credential.status = "revoked"; }
        catch { result.credential.status = "revocation_unconfirmed"; result.failure ??= "github_token_revocation_unconfirmed"; }
        bearer = undefined;
      }
    }
    // A cleanup failure must never erase an acknowledged or unknown Git effect.
    return result;
  }
}
