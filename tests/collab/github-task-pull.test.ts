import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { managedGit } from "../../lib/collab/git/github-pack";
import { PreparedTaskPush, taskPushRef } from "../../lib/collab/git/task-push-protocol";
import { PreparedTaskPull, taskPullIntent, type TaskPullIntent } from "../../lib/collab/git/github-task-pull";
import { githubPushFixture } from "./fixtures/github-push";
import { githubPullFixture } from "./fixtures/github-pull";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const git = async (cwd: string, args: string[]) => (await managedGit(cwd, args, AbortSignal.timeout(30000))).bytes.toString().trim();
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "pi-collab-task-pull-")), source = path.join(root, "source"), remote = path.join(root, "source.git");
  await mkdir(source); await git(source, ["init", "--template=", "-b", "main"]); await git(source, ["config", "user.name", "PR fixture"]); await git(source, ["config", "user.email", "pull@test.invalid"]);
  await writeFile(path.join(source, "code.txt"), "base\n"); await git(source, ["add", "."]); await git(source, ["commit", "-m", "Baseline"]); const baseSha = await git(source, ["rev-parse", "HEAD"]);
  await git(root, ["-c", "protocol.file.allow=always", "clone", "--bare", "--no-local", "--template=", source, "source.git"]);
  await writeFile(path.join(source, "code.txt"), "task change\n"); await git(source, ["add", "."]); await git(source, ["commit", "-m", "Task"]); const headSha = await git(source, ["rev-parse", "HEAD"]);
  await git(root, ["-c", "protocol.file.allow=always", "clone", "--bare", "--no-local", "--template=", source, "prepared.git"]);
  const push = { operationId: randomUUID(), repositoryId: randomUUID(), taskId: randomUUID(), workspaceId: randomUUID(), expectedOld: null, newSha: headSha };
  const binding = { repositoryId: push.repositoryId, githubRepositoryId: "1011", nodeId: "R_fixture", ownerId: "789", ownerLogin: "example-org", name: "example-repo",
    defaultBranch: "main", private: true, visibility: "private" as const, integrationBranches: ["main"] };
  const ref = taskPushRef({ taskId: push.taskId, workspaceId: push.workspaceId }), writer = await githubPushFixture(root, binding, ref);
  try { assert.equal((await writer.client.execute(await PreparedTaskPush.prepare(path.join(root, "prepared.git"), push, AbortSignal.timeout(30000)), binding, async () => true)).outcome?.status, "acknowledged"); }
  finally { await writer.close(); }
  const intent: TaskPullIntent = { operationId: randomUUID(), deliveryId: push.operationId, repositoryId: push.repositoryId, taskId: push.taskId, workspaceId: push.workspaceId,
    headSha, baseSha, manifestHash: hash("fixture manifest reference; durable SQL authority is tested separately"), title: "A reviewed task change", body: "Goal: change the fixture.\nScope: code.txt.\nTests: no CI attestation.\nRisks: draft review required." };
  const prepared = PreparedTaskPull.prepare(binding, intent), api = await githubPullFixture(root, prepared.attempt);
  return { root, source, remote, ref, binding, intent, prepared, api, async close() { await api.close(); await rm(root, { recursive: true, force: true }); } };
}

test("acknowledged real Git history yields one exact draft REST request, scoped PR-only write permission and independently revoked token", async () => {
  const f = await fixture();
  try {
    let gates = 0;
    const result = await f.api.client.execute(f.prepared, async ({ attempt, evidence, evidenceHash }) => {
      gates++; assert.equal(f.api.state.creates, 0); assert.deepEqual(attempt, f.prepared.attempt);
      assert.equal(attempt.requestHash, hash(JSON.stringify(attempt.request))); assert.equal(attempt.requestBytes, Buffer.byteLength(JSON.stringify(attempt.request)));
      assert.equal(attempt.intent.deliveryId, f.intent.deliveryId); assert.equal(evidence.headSha, f.intent.headSha); assert.equal(evidence.baseSha, f.intent.baseSha);
      assert.equal(evidenceHash, hash(JSON.stringify(evidence))); return true;
    });
    assert.equal(result.outcome.status, "created"); if (result.outcome.status !== "created") return;
    assert.equal(result.outcome.revision, "matching"); assert.equal(result.outcome.current?.draft, true); assert.equal(result.outcome.current?.merged, false);
    assert.equal(result.outcome.pull.url, "https://github.com/example-org/example-repo/pull/17"); assert.equal(result.outcome.creation.bodyHash, hash(f.prepared.attempt.request.body));
    assert.equal(gates, 1); assert.equal(f.api.state.creates, 1); assert.equal(f.api.state.issued, 1); assert.equal(f.api.state.revoked, 1);
    assert.equal(result.failure, null); assert.equal(f.api.containsCredential(result), false);
    assert.equal(await git(f.remote, ["rev-parse", f.ref]), f.intent.headSha); assert.equal(await git(f.remote, ["rev-parse", "main"]), f.intent.baseSha);
    assert.equal(f.api.calls.some(c => /merge|reviews|git-receive-pack/.test(c.route)), false);
    assert.deepEqual(f.api.calls.find(c => c.route.endsWith("access_tokens"))?.body, { repository_ids: [1011], permissions: { contents: "read", pull_requests: "write" } });
  } finally { await f.close(); }
});

test("generated head, exact request and immutable caller copies prevent arbitrary ref or payload substitution; consumption precedes credentials", async () => {
  const f = await fixture();
  try {
    for (const patch of [{ title: "bad\nheader" }, { head: "main" }, { headSha: "0".repeat(40) }, { baseSha: f.intent.headSha }, { body: "\0" }])
      assert.equal(taskPullIntent.safeParse({ ...f.intent, ...patch }).success, false);
    assert.throws(() => PreparedTaskPull.prepare({ ...f.binding, defaultBranch: f.prepared.attempt.request.head }, f.intent), /binding_mismatch/);
    assert.throws(() => PreparedTaskPull.prepare(f.binding, { ...f.intent, repositoryId: randomUUID() }), /binding_mismatch/);
    const copy = f.prepared.attempt; copy.request.head = "main"; copy.request.body = "changed"; copy.intent.headSha = f.intent.baseSha;
    const first = await f.api.client.execute(f.prepared, async value => { value.attempt.request.head = "main"; value.evidence.repository.name = "changed"; return true; });
    assert.equal(first.outcome.status, "created"); assert.equal(f.api.created[0].body, f.prepared.attempt.request.body);
    await assert.rejects(f.api.client.execute(f.prepared, async () => true), /attempt_consumed/); assert.equal(f.api.state.issued, 1); assert.equal(f.api.state.creates, 1);
  } finally { await f.close(); }
});

test("a tampered prepared capability is refused before credentials", async () => {
  const f = await fixture();
  try {
    const attempt = f.prepared.attempt; attempt.request.head = "main"; attempt.requestHash = hash(JSON.stringify(attempt.request));
    f.prepared.consume = () => attempt;
    await assert.rejects(f.api.client.execute(f.prepared, async () => true), /request_mismatch/); assert.equal(f.api.state.issued, 0); assert.equal(f.api.state.creates, 0);
  } finally { await f.close(); }
});

test("missing PR permission, wrong installation and suspension cannot mint a token; unsafe token grants are revoked without creation", async () => {
  for (const patch of [{ installPulls: "read" }, { appId: 987 }, { accountId: 987 }, { suspended: true },
    { permissions: { contents: "write", pull_requests: "write" } }, { permissions: { contents: "read", pull_requests: "write", issues: "write" } },
    { permissions: { contents: "read", pull_requests: "read" } }, { expiresAt: new Date(0).toISOString() }, { repositoryCount: 2 }]) {
    const f = await fixture(); Object.assign(f.api.state, patch);
    try {
      const result = await f.api.client.execute(f.prepared, async () => true); assert.equal(result.createStarted, false); assert.ok(result.failure);
      assert.equal(f.api.state.creates, 0); assert.equal(f.api.state.revoked, f.api.state.issued); assert.equal(f.api.containsCredential(result), false);
    } finally { await f.close(); }
  }
});

test("identity, visibility, current head and base changes refuse creation; a read-only contents installation can create a draft without Git writes", async () => {
  for (const change of ["owner", "privacy", "default", "node", "archived", "head", "base", "tag", "read_only"]) {
    const f = await fixture();
    try {
      if (change === "owner") f.api.state.ownerId = 990;
      if (change === "privacy") { f.api.state.private = false; f.api.state.visibility = "public"; }
      if (change === "default") f.api.state.defaultBranch = "other";
      if (change === "node") f.api.state.nodeId = "R_wrong";
      if (change === "archived") f.api.state.archived = true;
      if (change === "head") await git(f.remote, ["update-ref", f.ref, f.intent.baseSha]);
      if (change === "base") await git(f.remote, ["update-ref", "refs/heads/main", f.intent.headSha]);
      if (change === "tag") f.api.state.refType = "tag";
      if (change === "read_only") f.api.state.installContents = "read";
      const result = await f.api.client.execute(f.prepared, async () => true);
      assert.equal(result.createStarted, change === "read_only"); assert.equal(f.api.state.creates, change === "read_only" ? 1 : 0); assert.equal(f.api.state.revoked, 1);
      if (change === "read_only") { assert.equal(result.outcome.status, "created"); assert.equal(result.failure, null); }
    } finally { await f.close(); }
  }
});

test("an existing PR is observed, never adopted as this operation or silently edited; changes after listing are rechecked before authority", async () => {
  for (const change of ["existing", "head", "permission"]) {
    const f = await fixture(); let gates = 0;
    try {
      if (change === "existing") f.api.state.existing = true;
      f.api.state.afterList = async () => {
        if (change === "head") await git(f.remote, ["update-ref", f.ref, f.intent.baseSha]);
        if (change === "permission") f.api.state.installPulls = "read";
      };
      const result = await f.api.client.execute(f.prepared, async () => { gates++; return true; });
      assert.equal(result.outcome.status, "not_created"); assert.equal(gates, 0); assert.equal(f.api.state.creates, 0); assert.equal(f.api.state.revoked, 1);
      if (change === "existing" && result.outcome.status === "not_created") { assert.equal(result.outcome.reason, "existing_pull"); assert.equal(result.outcome.existing?.[0].number, 16); }
    } finally { await f.close(); }
  }
});

test("denied, failed and cancelled final authorization never create or leak the caller error", async () => {
  for (const change of ["deny", "throw", "cancel"]) {
    const f = await fixture(), stop = new AbortController();
    try {
      const result = await f.api.client.execute(f.prepared, async () => {
        if (change === "deny") return false; if (change === "throw") throw new Error("private SQL details must not escape"); stop.abort(); return true;
      }, stop.signal);
      assert.equal(result.createStarted, false); assert.equal(f.api.state.creates, 0); assert.equal(f.api.state.revoked, 1); assert.equal(JSON.stringify(result).includes("private SQL"), false);
    } finally { await f.close(); }
  }
});

test("the creation API cannot CAS head or base; a change after authorization remains a created but drifted draft and is never repaired automatically", async () => {
  for (const ref of ["head", "base"]) {
    const f = await fixture();
    try {
      // Keep an actual nonempty PR diff after either race; replacing head with
      // base (or vice versa) would normally get a no-commits 422 from GitHub.
      await git(f.source, ["checkout", "-b", "raced-ref", f.intent.baseSha]);
      await writeFile(path.join(f.source, "concurrent.txt"), "separate concurrent work\n");
      await git(f.source, ["add", "."]); await git(f.source, ["commit", "-m", "Concurrent upstream change"]);
      const racedSha = await git(f.source, ["rev-parse", "HEAD"]);
      await git(f.remote, ["-c", "protocol.file.allow=always", "fetch", f.source, "raced-ref"]);
      const result = await f.api.client.execute(f.prepared, async () => {
        await git(f.remote, ["update-ref", ref === "head" ? f.ref : "refs/heads/main", racedSha]); return true;
      });
      assert.equal(result.outcome.status, "created"); if (result.outcome.status !== "created") continue;
      assert.equal(result.outcome.revision, "changed"); assert.equal(result.outcome.current?.headSha, ref === "head" ? racedSha : f.intent.headSha);
      assert.equal(result.outcome.current?.baseSha, ref === "base" ? racedSha : f.intent.baseSha); assert.equal(result.failure, "github_pull_revision_changed");
      assert.ok(await git(f.remote, ["diff", "--name-only", `main...${f.ref}`]));
      assert.equal(f.api.state.creates, 1); assert.equal(f.api.created.length, 1); assert.equal(f.api.state.revoked, 1);
    } finally { await f.close(); }
  }
});

test("external PR metadata, readiness or target changes are stale observations, never CI/approval or merge claims", async () => {
  for (const patch of [{ title: "Externally changed" }, { body: "Externally changed" }, { draft: false }, { state: "closed" }, { merged: true }, { maintainer_can_modify: true }]) {
    const f = await fixture(); f.api.state.mutateRead = patch;
    try {
      const result = await f.api.client.execute(f.prepared, async () => true); assert.equal(result.outcome.status, "created");
      if (result.outcome.status === "created") assert.equal(result.outcome.revision, "changed");
      assert.equal(f.api.state.creates, 1); assert.equal(f.api.state.revoked, 1); assert.equal(f.api.containsCredential(result), false);
    } finally { await f.close(); }
  }
});

test("created evidence survives failed post-read or cleanup, while malformed creation and ambiguous HTTP failures remain unknown", async () => {
  for (const failure of ["read-cut", "read-large", "revoke", "create-cut", "create-cut-revoke", "validation", "create-forbidden", "create-redirect", "foreign-url", "wrong-number"]) {
    const f = await fixture(); f.api.state.fail = failure;
    if (failure === "foreign-url") f.api.state.mutateCreate = { html_url: "https://untrusted.invalid/pull/17" };
    if (failure === "wrong-number") f.api.state.mutateCreate = { number: Number.MAX_SAFE_INTEGER + 1 };
    try {
      const result = await f.api.client.execute(f.prepared, async () => true);
      assert.equal(result.outcome.status, ["read-cut", "read-large", "revoke"].includes(failure) ? "created" : ["validation", "create-forbidden"].includes(failure) ? "rejected" : "unknown");
      if (result.outcome.status === "rejected") { assert.equal(result.outcome.httpStatus, failure === "validation" ? 422 : 403); assert.equal(f.api.created.length, 0); }
      if (result.outcome.status === "created") assert.equal(result.outcome.revision, failure === "revoke" ? "matching" : "unavailable");
      assert.equal(result.createStarted, true); assert.equal(f.api.state.creates, 1); assert.ok(result.failure); assert.equal(f.api.containsCredential(result), false);
      assert.equal(result.credential.status, failure.includes("revoke") ? "revocation_unconfirmed" : "revoked");
    } finally { await f.close(); }
  }
});

test("a cancelled unknown request can create a PR after token revocation; neither cancellation nor absence at that moment grants retry", async () => {
  const f = await fixture(), stop = new AbortController(); let reached!: () => void, release!: () => void, finished!: () => void;
  const received = new Promise<void>(resolve => { reached = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; }), created = new Promise<void>(resolve => { finished = resolve; });
  let running: ReturnType<typeof f.api.client.execute> | undefined;
  try {
    f.api.state.beforeCreate = async () => { reached(); await barrier; }; f.api.state.afterCreate = async () => finished();
    running = f.api.client.execute(f.prepared, async () => true, stop.signal); await received; stop.abort(); const result = await running;
    assert.equal(result.outcome.status, "unknown"); assert.equal(result.credential.status, "revoked"); assert.equal(f.api.created.length, 0);
    await assert.rejects(f.api.client.execute(f.prepared, async () => true), /attempt_consumed/); assert.equal(f.api.state.creates, 1);
    release(); await created; assert.equal(f.api.created.length, 1); assert.equal(f.api.created[0].draft, true);
  } finally { release(); stop.abort(); await running; await f.close(); }
});

test("unconfirmed token issuance and redirects fail before PR creation without credential-bearing error text", async () => {
  for (const failure of ["token-cut", "redirect", "repository-missing"]) {
    const f = await fixture(); f.api.state.fail = failure;
    try {
      const result = await f.api.client.execute(f.prepared, async () => true); assert.equal(result.outcome.status, "not_created");
      assert.equal(f.api.state.creates, 0); assert.equal(f.api.containsCredential(result), false); assert.ok(result.failure);
      if (failure === "token-cut") assert.equal(result.credential.status, "issuance_unconfirmed");
    } finally { await f.close(); }
  }
});

test("read-only PR preparation observes a newer default commit without another push, then the separately confirmed versions can create a draft", async () => {
  const f = await fixture(), reader = await githubPullFixture(f.root, f.prepared.attempt, "preview");
  try {
    await git(f.source, ["checkout", "-b", "new-baseline", f.intent.baseSha]); await writeFile(path.join(f.source, "upstream.txt"), "separate upstream work\n");
    await git(f.source, ["add", "."]); await git(f.source, ["commit", "-m", "New upstream baseline"]); const nextBase = await git(f.source, ["rev-parse", "HEAD"]);
    await git(f.remote, ["-c", "protocol.file.allow=always", "fetch", f.source, "new-baseline:main"]);
    const preview = await reader.client.preview(f.binding, { taskId: f.intent.taskId, workspaceId: f.intent.workspaceId, headSha: f.intent.headSha });
    assert.equal(preview.target.baseSha, nextBase); assert.equal(preview.target.headSha, f.intent.headSha); assert.equal(preview.tokenRevoked, true); assert.deepEqual(preview.existing, []);
    assert.equal(reader.state.issued, 1); assert.equal(reader.state.revoked, 1); assert.equal(reader.state.creates, 0);
    const prepared = PreparedTaskPull.prepare(f.binding, { ...f.intent, operationId: randomUUID(), baseSha: preview.target.baseSha }), writer = await githubPullFixture(f.root, prepared.attempt);
    try {
      const result = await writer.client.execute(prepared, async () => true); assert.equal(result.outcome.status, "created");
      if (result.outcome.status === "created") { assert.equal(result.outcome.revision, "matching"); assert.equal(result.outcome.creation.baseSha, nextBase); }
      assert.equal(await git(f.remote, ["rev-parse", f.ref]), f.intent.headSha);
    } finally { await writer.close(); }
  } finally { await reader.close(); await f.close(); }
});

test("read-only PR preparation refuses late version changes, overbroad tokens and failed cleanup; existing PRs stay observations", async () => {
  for (const change of ["base", "head", "scope", "cleanup", "existing", "cancel"]) {
    const f = await fixture(), reader = await githubPullFixture(f.root, f.prepared.attempt, "preview"), stop = new AbortController();
    try {
      if (change === "scope") reader.state.permissions.pull_requests = "write";
      if (change === "cleanup") reader.state.fail = "revoke";
      if (change === "existing") reader.state.existing = true;
      reader.state.afterList = async () => {
        if (change === "base") await git(f.remote, ["update-ref", "refs/heads/main", f.intent.headSha]);
        if (change === "head") await git(f.remote, ["update-ref", f.ref, f.intent.baseSha]);
        if (change === "cancel") stop.abort();
      };
      const work = reader.client.preview(f.binding, { taskId: f.intent.taskId, workspaceId: f.intent.workspaceId, headSha: f.intent.headSha }, stop.signal);
      if (change === "existing") assert.equal((await work).existing[0].number, 16);
      else await assert.rejects(work, /github_/);
      assert.equal(reader.state.creates, 0); assert.equal(reader.state.revoked, change === "cleanup" ? 0 : 1);
    } finally { await reader.close(); await f.close(); }
  }
});
