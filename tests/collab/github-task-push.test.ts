import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { managedGit } from "../../lib/collab/git/github-pack";
import { PreparedTaskPush, taskPushRef } from "../../lib/collab/git/task-push-protocol";
import { githubPushBinding, type GitHubPushBinding } from "../../lib/collab/git/github-task-push";
import { githubPushFixture } from "./fixtures/github-push";

const deadline = () => AbortSignal.timeout(30000);
const git = async (cwd: string, args: string[], input?: string) => (await managedGit(cwd, args, deadline(), { input })).bytes.toString().trim();
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "pi-collab-github-push-")), source = path.join(root, "source"), remote = path.join(root, "source.git"), prepared = path.join(root, "prepared.git");
  await mkdir(source); await git(source, ["init", "-b", "main", "--template="]);
  await git(source, ["config", "user.name", "Push fixture"]); await git(source, ["config", "user.email", "push@test.invalid"]);
  await writeFile(path.join(source, "code.txt"), "known remote\n"); await git(source, ["add", "."]); await git(source, ["commit", "-m", "Baseline"]);
  const base = await git(source, ["rev-parse", "HEAD"]);
  await git(root, ["-c", "protocol.file.allow=always", "clone", "--bare", "--no-local", "--template=", source, remote]);
  await writeFile(path.join(source, "code.txt"), "task change\n"); await git(source, ["add", "."]); await git(source, ["commit", "-m", "Task"]);
  const next = await git(source, ["rev-parse", "HEAD"]);
  await git(root, ["-c", "protocol.file.allow=always", "clone", "--bare", "--no-local", "--template=", source, prepared]);
  const intent = { operationId: randomUUID(), repositoryId: randomUUID(), taskId: randomUUID(), workspaceId: randomUUID(), expectedOld: null as string | null, newSha: next };
  const ref = taskPushRef({ taskId: intent.taskId, workspaceId: intent.workspaceId });
  const binding: GitHubPushBinding = { repositoryId: intent.repositoryId, githubRepositoryId: "1011", nodeId: "R_fixture", ownerId: "789", ownerLogin: "example-org",
    name: "example-repo", defaultBranch: "main", private: true, visibility: "private", integrationBranches: ["main", "release"] };
  const api = await githubPushFixture(root, binding, ref);
  return { root, source, remote, prepared, base, next, intent, ref, binding, api,
    prepare: () => PreparedTaskPush.prepare(prepared, intent, deadline()),
    async close() { await api.close(); await rm(root, { recursive: true, force: true }); } };
}

test("single-repository write token reaches only exact task receive-pack; current evidence precedes the durable gate and tokens are revoked", async () => {
  const f = await fixture();
  try {
    let gates = 0;
    const result = await f.api.client.execute(await f.prepare(), f.binding, async ({ attempt, evidence, evidenceHash }) => {
      gates++; assert.equal(f.api.git.calls.receive, 0); assert.equal(f.api.git.calls.advertise, 1);
      assert.equal(attempt.ref, f.ref); assert.equal(evidence.defaultSha, f.base); assert.equal(evidence.protected, false);
      assert.equal(evidenceHash, createHash("sha256").update(JSON.stringify(evidence)).digest("hex")); return true;
    });
    assert.equal(result.outcome?.status, "acknowledged"); assert.equal(result.failure, null); assert.equal(result.receiveStarted, true);
    assert.equal(gates, 1); assert.equal(f.api.state.issued, 1); assert.equal(f.api.state.revoked, 1); assert.equal(result.credential.status, "revoked");
    assert.equal(f.api.git.calls.receive, 1); assert.equal(await git(f.remote, ["rev-parse", f.ref]), f.next); assert.equal(await git(f.remote, ["rev-parse", "main"]), f.base);
    assert.equal(f.api.containsCredential(result), false); assert.equal(await git(f.prepared, ["remote"]), "origin");
    assert.doesNotMatch(await readFile(path.join(f.prepared, "config"), "utf8"), /Authorization|github.com|ghs_|helper/);
    assert.equal(f.api.calls.filter(call => call.route.includes("/rules/branches/")).length, 2);
  } finally { await f.close(); }
});

test("existing generated branches use direct ref/type evidence and fast-forward expected-old updates", async () => {
  const f = await fixture();
  try {
    await git(f.remote, ["update-ref", f.ref, f.base]); f.intent.expectedOld = f.base;
    const result = await f.api.client.execute(await f.prepare(), f.binding, async () => true);
    assert.equal(result.evidence?.observedOld, f.base); assert.equal(result.outcome?.status, "acknowledged"); assert.equal(await git(f.remote, ["rev-parse", f.ref]), f.next);
    assert.equal(f.api.state.revoked, 1);
  } finally { await f.close(); }
});

test("default or integration destinations, incorrect local binding and unverified visibility fail before requesting credentials", async () => {
  const f = await fixture();
  try {
    const branch = f.ref.slice("refs/heads/".length);
    for (const mutation of [{ defaultBranch: branch }, { integrationBranches: [branch] }, { repositoryId: randomUUID() }, { ownerId: "999" }]) {
      await assert.rejects(f.api.client.execute(await f.prepare(), { ...f.binding, ...mutation }, async () => true), /github_push_/);
    }
    assert.equal(githubPushBinding.safeParse({ ...f.binding, visibility: "unknown" }).success, false);
    assert.equal(f.api.state.issued, 0); assert.equal(f.api.git.calls.receive, 0);
  } finally { await f.close(); }
});

test("wrong app/account, suspended or read-only installations never mint a write token", async () => {
  for (const mutation of [{ appId: 999 }, { accountId: 999 }, { suspended: true }, { installContents: "read" }]) {
    const f = await fixture(); Object.assign(f.api.state, mutation);
    try { const result = await f.api.client.execute(await f.prepare(), f.binding, async () => true);
      assert.ok(result.failure); assert.equal(result.credential.status, "not_requested"); assert.equal(f.api.state.issued, 0); assert.equal(f.api.git.calls.receive, 0);
    } finally { await f.close(); }
  }
});

test("broad tokens, extra permissions, bad expiry and multiple repository access are rejected and the received token is revoked", async () => {
  for (const mutation of [{ permissions: { contents: "write", issues: "write" } }, { permissions: { contents: "read" } }, { permissions: { contents: "write", metadata: "write" } },
    { expiresAt: new Date(0).toISOString() }, { expiresAt: new Date(Date.now() + 7200000).toISOString() }, { repositoryCount: 2 }, { repositoryId: 1012 }]) {
    const f = await fixture(); Object.assign(f.api.state, mutation);
    try { const result = await f.api.client.execute(await f.prepare(), f.binding, async () => true);
      assert.ok(result.failure); assert.equal(f.api.state.revoked, 1); assert.equal(result.credential.status, "revoked"); assert.equal(f.api.git.calls.receive, 0); assert.equal(f.api.containsCredential(result), false);
    } finally { await f.close(); }
  }
});

test("renames, transfers, privacy changes and inactive repositories invalidate prior confirmation before any Git request", async () => {
  for (const mutation of [{ owner: "renamed-org" }, { name: "renamed-repo" }, { ownerId: 990 }, { nodeId: "R_other" }, { private: false, visibility: "public" },
    { visibility: undefined }, { archived: true }, { disabled: true }, { defaultBranch: "other" }]) {
    const f = await fixture(); Object.assign(f.api.state, mutation);
    try { const result = await f.api.client.execute(await f.prepare(), f.binding, async () => true);
      assert.ok(result.failure); assert.equal(f.api.git.calls.advertise, 0); assert.equal(f.api.git.calls.receive, 0); assert.equal(f.api.state.revoked, 1);
    } finally { await f.close(); }
  }
});

test("freshly reviewed rename metadata can route the same stable repository ID without following returned clone URLs", async () => {
  const f = await fixture(); f.api.state.name = "renamed-repo";
  try {
    const result = await f.api.client.execute(await f.prepare(), { ...f.binding, name: f.api.state.name }, async () => true);
    assert.equal(result.outcome?.status, "acknowledged"); assert.equal(result.evidence?.repository.githubRepositoryId, f.binding.githubRepositoryId);
    assert.equal(f.api.git.calls.receive, 1);
  } finally { await f.close(); }
});

test("protected existing branches and active rules for absent branch names are refused without App bypass", async () => {
  for (const kind of ["protected", "new-rules", "unknown-rules", "missing-rules", "tag-object"]) {
    const f = await fixture();
    try {
      if (["protected", "tag-object"].includes(kind)) { await git(f.remote, ["update-ref", f.ref, f.base]); f.intent.expectedOld = f.base; }
      if (kind === "protected") f.api.state.protected = true;
      else if (kind === "new-rules") f.api.state.rules = [{ type: "pull_request", ruleset_source_type: "Organization" }];
      else if (kind === "unknown-rules") f.api.state.rules = [{ type: "future_rule" }];
      else if (kind === "missing-rules") f.api.state.fail = "rules-missing";
      else f.api.state.refType = "tag";
      const result = await f.api.client.execute(await f.prepare(), f.binding, async () => true);
      assert.ok(result.failure); assert.equal(f.api.git.calls.receive, 0); assert.equal(f.api.state.revoked, 1);
    } finally { await f.close(); }
  }
});

test("provider identity, ref, suspension and protection changes after Git advertisement are rechecked before SQL authorization", async () => {
  for (const change of ["name", "ref", "suspended", "rules", "privacy"]) {
    const f = await fixture(); let gates = 0;
    f.api.state.afterAdvertise = async () => {
      if (change === "name") f.api.state.name = "renamed";
      else if (change === "ref") await git(f.remote, ["update-ref", f.ref, f.base]);
      else if (change === "suspended") f.api.state.suspended = true;
      else if (change === "privacy") { f.api.state.private = false; f.api.state.visibility = "public"; }
      else f.api.state.rules = [{ type: "update" }];
    };
    try { const result = await f.api.client.execute(await f.prepare(), f.binding, async () => { gates++; return true; });
      assert.ok(result.failure); assert.equal(gates, 0); assert.equal(f.api.git.calls.receive, 0); assert.equal(f.api.state.revoked, 1);
    } finally { await f.close(); }
  }
});

test("a denied, failed or cancelled durable authorization does not send, and cleanup is independent of caller cancellation", async () => {
  for (const action of ["deny", "throw", "cancel"]) {
    const f = await fixture(), stop = new AbortController();
    try {
      const result = await f.api.client.execute(await f.prepare(), f.binding, async () => {
        if (action === "deny") return false;
        if (action === "throw") throw new Error("SQL error with fixture-sensitive details");
        stop.abort(); return true;
      }, stop.signal);
      assert.equal(result.receiveStarted, false); assert.equal(f.api.git.calls.receive, 0); assert.equal(f.api.state.revoked, 1);
      if (action === "deny") assert.equal(result.outcome?.status, "not_sent");
      assert.equal(JSON.stringify(result).includes("fixture-sensitive"), false); assert.equal(f.api.containsCredential(result), false);
    } finally { await f.close(); }
  }
});

test("an acknowledged Git effect survives a failed token revocation as separate evidence", async () => {
  const f = await fixture(); f.api.state.fail = "revoke";
  try {
    const result = await f.api.client.execute(await f.prepare(), f.binding, async () => true);
    assert.equal(result.outcome?.status, "acknowledged"); assert.equal(result.credential.status, "revocation_unconfirmed");
    assert.equal(result.failure, "github_token_revocation_unconfirmed"); assert.equal(await git(f.remote, ["rev-parse", f.ref]), f.next);
    assert.equal(f.api.git.calls.receive, 1); assert.equal(f.api.containsCredential(result), false);
  } finally { await f.close(); }
});

test("real push with lost response stays unknown even when token cleanup succeeds; no automatic mutation retry", async () => {
  const f = await fixture(); f.api.git.state.loseReply = true;
  try {
    const result = await f.api.client.execute(await f.prepare(), f.binding, async () => true);
    assert.equal(result.outcome?.status, "unknown"); assert.equal(result.credential.status, "revoked");
    assert.equal(result.receiveStarted, true); assert.equal(await git(f.remote, ["rev-parse", f.ref]), f.next); assert.equal(f.api.git.calls.receive, 1);
  } finally { await f.close(); }
});

test("unknown token issuance, API redirects, rate limits and oversized rules responses never trigger receive or disclose bodies", async () => {
  for (const failure of ["token-cut", "redirect", "rate", "rules-large", "repository-missing"]) {
    const f = await fixture(); f.api.state.fail = failure;
    try {
      const result = await f.api.client.execute(await f.prepare(), f.binding, async () => true);
      assert.ok(result.failure); assert.equal(f.api.git.calls.receive, 0); assert.equal(f.api.containsCredential(result), false);
      assert.ok(f.api.state.issued <= 1); if (failure === "token-cut") assert.equal(result.credential.status, "issuance_unconfirmed");
    } finally { await f.close(); }
  }
});

test("a competing remote update after final authorization is rejected by the real receiver without overwriting that update", async () => {
  const f = await fixture();
  try {
    const result = await f.api.client.execute(await f.prepare(), f.binding, async () => {
      // Provider/ref checks just observed absence. Another actor creates the
      // branch while the final gate is being recorded, before receive-pack.
      await git(f.remote, ["update-ref", f.ref, f.base]); return true;
    });
    assert.equal(result.outcome?.status, "rejected"); assert.equal(result.receiveStarted, true);
    assert.equal(await git(f.remote, ["rev-parse", f.ref]), f.base); assert.equal(f.api.git.calls.receive, 1);
    assert.equal(result.credential.status, "revoked");
  } finally { await f.close(); }
});

test("changed prepared authorization identity or send bytes cannot cross the fixed authenticated capability", async () => {
  for (const change of ["identity", "command", "pack", "length"]) {
    const f = await fixture(); let gates = 0;
    try {
      const prepared = await f.prepare(), execute = prepared.execute.bind(prepared);
      prepared.execute = (transport, authorize, signal) => execute(async (kind, caller, body) => {
        if (kind !== "receive" || !body) return transport(kind, caller, body);
        const altered = new Uint8Array(body);
        if (change === "command") altered[5] ^= 1;
        if (change === "pack") altered[altered.length - 1] ^= 1;
        return transport(kind, caller, change === "length" ? altered.subarray(1) : altered);
      }, attempt => authorize(change === "identity" ? { ...attempt, operationId: randomUUID() } : attempt), signal);
      const result = await f.api.client.execute(prepared, f.binding, async () => { gates++; return true; });
      assert.equal(result.receiveStarted, false); assert.equal(f.api.git.calls.receive, 0); assert.equal(f.api.state.revoked, 1);
      assert.equal(gates, change === "identity" ? 0 : 1); assert.notEqual(result.outcome?.status, "acknowledged");
      if (change === "identity") assert.equal(result.failure, "github_push_request_mismatch");
      assert.equal(f.api.containsCredential(result), false);
    } finally { await f.close(); }
  }
});

test("a lost Git response and failed revocation retain both unknown outcomes with no receive retry", async () => {
  const f = await fixture(); f.api.git.state.loseReply = true; f.api.state.fail = "revoke";
  try {
    const result = await f.api.client.execute(await f.prepare(), f.binding, async () => true);
    assert.equal(result.outcome?.status, "unknown"); assert.equal(result.credential.status, "revocation_unconfirmed");
    assert.equal(result.receiveStarted, true); assert.equal(result.failure, "github_token_revocation_unconfirmed");
    assert.equal(await git(f.remote, ["rev-parse", f.ref]), f.next); assert.equal(f.api.git.calls.receive, 1);
    assert.equal(f.api.containsCredential(result), false);
  } finally { await f.close(); }
});

test("reusing an in-memory preparation cannot send twice and still cleans up its newly issued token", async () => {
  const f = await fixture();
  try {
    const prepared = await f.prepare(); let gates = 0;
    const authorize = async () => { gates++; return true; };
    assert.equal((await f.api.client.execute(prepared, f.binding, authorize)).outcome?.status, "acknowledged");
    const result = await f.api.client.execute(prepared, f.binding, authorize);
    assert.equal(result.receiveStarted, false); assert.ok(result.failure); assert.equal(result.credential.status, "revoked");
    assert.equal(gates, 1); assert.equal(f.api.git.calls.receive, 1);
    // SQL admission must provide durable idempotency before token issuance;
    // this internal client only guarantees no second receive from this object.
    assert.equal(f.api.state.issued, 2); assert.equal(f.api.state.revoked, 2);
  } finally { await f.close(); }
});
