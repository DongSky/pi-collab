import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile, symlink, readFile, readdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { taskPushFixture } from "./fixtures/task-push";
import { managedGit } from "../../lib/collab/git/github-pack";
import { PreparedTaskPush, taskPushIntent, taskPushRef, observeTaskPush, type TaskPushIntent, type TaskPushTransport } from "../../lib/collab/git/task-push-protocol";

const signal = () => AbortSignal.timeout(30000);
const git = async (directory: string, args: string[]) => (await managedGit(directory, args, signal())).bytes.toString("utf8").trim();
const pkt = (line: string) => Buffer.from((Buffer.byteLength(line) + 4).toString(16).padStart(4, "0") + line);
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "pi-collab-task-push-"));
  const source = path.join(root, "source"), remote = path.join(root, "source.git"), prepared = path.join(root, "prepared.git");
  await git(root, ["init", "--initial-branch=main", "--template=", source]);
  await git(source, ["config", "user.name", "Push fixture"]); await git(source, ["config", "user.email", "push@test.invalid"]);
  for (const content of ["first commit\n", "second commit\n"]) {
    await writeFile(path.join(source, "code.txt"), content); await git(source, ["add", "code.txt"]); await git(source, ["commit", "-m", content.trim()]);
  }
  const baseline = await git(source, ["rev-parse", "HEAD"]);
  await git(root, ["-c", "protocol.file.allow=always", "clone", "--bare", "--no-local", "--template=", source, remote]);
  await writeFile(path.join(source, "code.txt"), "task branch edit\n");
  await git(source, ["add", "code.txt"]); await git(source, ["commit", "-m", "Task draft"]);
  const next = await git(source, ["rev-parse", "HEAD"]);
  await git(root, ["-c", "protocol.file.allow=always", "clone", "--bare", "--no-local", "--template=", source, prepared]);
  const http = await taskPushFixture(root);
  const intent: TaskPushIntent = { operationId: randomUUID(), repositoryId: randomUUID(), taskId: randomUUID(), workspaceId: randomUUID(), expectedOld: null, newSha: next };
  const ref = taskPushRef({ taskId: intent.taskId, workspaceId: intent.workspaceId });
  return { root, source, remote, prepared, baseline, next, http, intent, ref,
    async close() { await http.close(); await rm(root, { recursive: true, force: true }); } };
}

test("actual receive-pack creates only its generated task branch, preserves original history and confirms exact request bytes before send", async () => {
  const f = await fixture();
  try {
    const push = await PreparedTaskPush.prepare(f.prepared, f.intent, signal()); let gates = 0;
    const result = await push.execute(f.http.transport, async attempt => {
      gates++; assert.equal(f.http.calls.receive, 0); assert.equal(attempt.operationId, f.intent.operationId);
      assert.equal(attempt.ref, f.ref); assert.equal(Object.isFrozen(attempt), true); return true;
    }, signal());
    assert.equal(result.status, "acknowledged"); assert.equal(gates, 1); assert.equal(f.http.calls.receive, 1);
    assert.equal(await git(f.remote, ["rev-parse", f.ref]), f.next); assert.equal(await git(f.remote, ["rev-parse", "refs/heads/main"]), f.baseline);
    assert.equal(await git(f.remote, ["rev-list", "--count", f.ref]), "3");
    assert.equal((await git(f.remote, ["for-each-ref", "--format=%(refname)"])).split("\n").length, 2);
    const body = f.http.requests[0], end = parseInt(body.subarray(0, 4).toString(), 16);
    assert.equal(body.subarray(4, end).toString(), `${"0".repeat(40)} ${f.next} ${f.ref}\0report-status\n`);
    assert.equal(body.subarray(end, end + 8).toString(), "0000PACK");
    assert.equal(createHash("sha256").update(body).digest("hex"), push.attempt.requestHash);
    await assert.rejects(push.execute(f.http.transport, async () => true, signal()), /attempt_consumed/);
    assert.equal(f.http.calls.receive, 1);
  } finally { await f.close(); }
});

test("existing task branch updates are fast-forward only and preserve the expected-old remote CAS", async () => {
  const f = await fixture();
  try {
    await git(f.remote, ["update-ref", f.ref, f.baseline]);
    const intent = { ...f.intent, expectedOld: f.baseline };
    const push = await PreparedTaskPush.prepare(f.prepared, intent, signal());
    assert.equal((await push.execute(f.http.transport, async () => true, signal())).status, "acknowledged");
    assert.equal(await git(f.remote, ["rev-parse", f.ref]), f.next);
    await assert.rejects(PreparedTaskPush.prepare(f.prepared, { ...intent, expectedOld: f.next, newSha: f.baseline }, signal()), /non_fast_forward/);
    assert.equal(f.http.calls.receive, 1);
  } finally { await f.close(); }
});

test("two actual competing Git receives with the same expected old value can apply only one distinct commit", async () => {
  const f = await fixture();
  try {
    await git(f.remote, ["update-ref", f.ref, f.baseline]);
    const tree = await git(f.prepared, ["rev-parse", `${f.next}^{tree}`]);
    const alternate = (await managedGit(f.prepared, ["commit-tree", tree, "-p", f.baseline], signal(), {
      input: "Competing draft\n", environment: { GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@test.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@test.invalid" },
    })).bytes.toString().trim();
    const intents = [{ ...f.intent, expectedOld: f.baseline }, { ...f.intent, operationId: randomUUID(), expectedOld: f.baseline, newSha: alternate }];
    const pushes = await Promise.all(intents.map(intent => PreparedTaskPush.prepare(f.prepared, intent, signal())));
    let arrivals = 0, release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
    f.http.state.beforeReceive = async () => { if (++arrivals === 2) release(); await barrier; };
    const outcomes = await Promise.all(pushes.map(push => push.execute(f.http.transport, async () => true, signal())));
    assert.deepEqual(outcomes.map(outcome => outcome.status).sort(), ["acknowledged", "rejected"]);
    assert.ok([f.next, alternate].includes(await git(f.remote, ["rev-parse", f.ref])));
    assert.equal(f.http.calls.receive, 2); assert.equal(await git(f.remote, ["rev-parse", "main"]), f.baseline);
  } finally { await f.close(); }
});

test("stale remote state, denied final authority and cancellation before send have no receive side effect", async () => {
  const f = await fixture();
  try {
    await git(f.remote, ["update-ref", f.ref, f.baseline]);
    let gates = 0;
    const stale = await PreparedTaskPush.prepare(f.prepared, f.intent, signal());
    assert.deepEqual(await stale.execute(f.http.transport, async () => { gates++; return true; }, signal()), { status: "not_sent", reason: "remote_changed" });
    assert.equal(gates, 0);
    const intent = { ...f.intent, expectedOld: f.baseline };
    const denied = await PreparedTaskPush.prepare(f.prepared, intent, signal());
    assert.deepEqual(await denied.execute(f.http.transport, async () => false, signal()), { status: "not_sent", reason: "authority_denied" });
    const cancelled = await PreparedTaskPush.prepare(f.prepared, intent, signal()), stop = new AbortController();
    assert.deepEqual(await cancelled.execute(f.http.transport, async () => { stop.abort(); return true; }, stop.signal), { status: "not_sent", reason: "cancelled" });
    const failed = await PreparedTaskPush.prepare(f.prepared, intent, signal());
    await assert.rejects(failed.execute(f.http.transport, async () => { throw new Error("durable gate unavailable"); }, signal()), /durable gate unavailable/);
    assert.equal(f.http.calls.receive, 0); assert.equal(await git(f.remote, ["rev-parse", f.ref]), f.baseline);
  } finally { await f.close(); }
});

test("a real committed push with a dropped HTTP response remains unknown and observation never sends again", async () => {
  const f = await fixture();
  try {
    f.http.state.loseReply = true;
    const push = await PreparedTaskPush.prepare(f.prepared, f.intent, signal());
    assert.deepEqual(await push.execute(f.http.transport, async () => true, signal()), { status: "unknown", reason: "response_unconfirmed" });
    assert.equal(await git(f.remote, ["rev-parse", f.ref]), f.next);
    const observation = await observeTaskPush(f.intent, f.http.transport, signal());
    assert.equal(observation.relation, "at_desired"); assert.equal(observation.observedSha, f.next); assert.equal("status" in observation, false);
    await assert.rejects(push.execute(f.http.transport, async () => true, signal()), /attempt_consumed/);
    assert.equal(f.http.calls.receive, 1);
    // Observing a moved-back ref cannot turn an old unknown into an abort.
    await git(f.remote, ["update-ref", f.ref, f.baseline]);
    assert.equal((await observeTaskPush({ ...f.intent, expectedOld: f.baseline }, f.http.transport, signal())).relation, "at_expected");
    assert.equal(f.http.calls.receive, 1);
  } finally { await f.close(); }
});

test("an unknown in-flight receive can still apply after a read observes the old remote state", async () => {
  const f = await fixture(); let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  try {
    let accepted!: () => void, completed!: () => void;
    const waiting = new Promise<void>(resolve => { accepted = resolve; }), finished = new Promise<void>(resolve => { completed = resolve; });
    f.http.state.beforeReceive = async () => { accepted(); await barrier; }; f.http.state.afterReceive = completed;
    const push = await PreparedTaskPush.prepare(f.prepared, f.intent, signal()), stop = new AbortController();
    const running = push.execute(f.http.transport, async () => true, stop.signal);
    await waiting; stop.abort();
    assert.deepEqual(await running, { status: "unknown", reason: "response_unconfirmed" });
    assert.equal((await observeTaskPush(f.intent, f.http.transport, signal())).relation, "at_expected");
    release(); await finished;
    assert.equal((await observeTaskPush(f.intent, f.http.transport, signal())).relation, "at_desired");
    assert.equal(f.http.calls.receive, 1); assert.equal(await git(f.remote, ["rev-parse", f.ref]), f.next);
  } finally { release(); await f.close(); }
});

test("source branch changes after preparation cannot alter the exact submitted commit or pack", async () => {
  const f = await fixture();
  try {
    const push = await PreparedTaskPush.prepare(f.prepared, f.intent, signal());
    await git(f.prepared, ["update-ref", "refs/heads/main", f.baseline]);
    assert.equal((await push.execute(f.http.transport, async () => true, signal())).status, "acknowledged");
    assert.equal(await git(f.remote, ["rev-parse", f.ref]), f.next);
  } finally { await f.close(); }
});

test("an empty remote accepts a new task branch using its capabilities pseudo-ref", async () => {
  const f = await fixture();
  try {
    await git(f.remote, ["update-ref", "-d", "refs/heads/main"]);
    const push = await PreparedTaskPush.prepare(f.prepared, f.intent, signal());
    assert.equal((await observeTaskPush(f.intent, f.http.transport, signal())).relation, "at_expected");
    assert.equal((await push.execute(f.http.transport, async () => true, signal())).status, "acknowledged");
    assert.equal(await git(f.remote, ["for-each-ref", "--format=%(refname)"]), f.ref);
  } finally { await f.close(); }
});

test("grafts, alternate object stores, symlink metadata and corrupt objects cannot establish a push source", async () => {
  const f = await fixture();
  try {
    const graft = path.join(f.prepared, "info/grafts"), alternates = path.join(f.prepared, "objects/info/alternates"), linked = path.join(f.prepared, "linked");
    await mkdir(path.dirname(graft), { recursive: true }); await mkdir(path.dirname(alternates), { recursive: true });
    await writeFile(graft, `${f.baseline} ${f.next}\n`);
    await assert.rejects(PreparedTaskPush.prepare(f.prepared, { ...f.intent, expectedOld: f.next, newSha: f.baseline }, signal()), /source_invalid/);
    await rm(graft); await writeFile(alternates, path.join(f.remote, "objects") + "\n");
    await assert.rejects(PreparedTaskPush.prepare(f.prepared, f.intent, signal())); await rm(alternates);
    await symlink(f.remote, linked); await assert.rejects(PreparedTaskPush.prepare(f.prepared, f.intent, signal())); await rm(linked);
    const packs = await readdir(path.join(f.prepared, "objects/pack"));
    const pack = path.join(f.prepared, "objects/pack", packs.find(name => name.endsWith(".pack"))!);
    const bytes = await readFile(pack); bytes[20] ^= 255; await chmod(pack, 0o600); await writeFile(pack, bytes);
    await assert.rejects(PreparedTaskPush.prepare(f.prepared, f.intent, signal())); assert.equal(f.http.calls.receive, 0);
  } finally { await f.close(); }
});

test("no arbitrary branch, deletion, refspec, equal SHA, wrong object type or non-bare source enters preparation", async () => {
  const f = await fixture();
  try {
    for (const mutation of [{ ref: "refs/heads/main" }, { force: true }, { remote: "ext::bad" }, { taskId: "../../main" }, { newSha: "0".repeat(40) }, { expectedOld: f.next }]) {
      assert.equal(taskPushIntent.safeParse({ ...f.intent, ...mutation }).success, false);
    }
    const blob = await git(f.prepared, ["rev-parse", `${f.next}:code.txt`]);
    await assert.rejects(PreparedTaskPush.prepare(f.prepared, { ...f.intent, newSha: blob }, signal()), /commit_required/);
    await assert.rejects(PreparedTaskPush.prepare(f.source, f.intent, signal())); assert.equal(f.http.calls.receive, 0);
  } finally { await f.close(); }
});

test("invalid/unsupported advertisements are rejected before the authority gate or a receive request", async () => {
  const f = await fixture();
  try {
    for (const rows of [
      [pkt("# service=git-receive-pack\n"), Buffer.from("0000"), pkt(`${f.baseline} ${f.ref}\0report-status object-format=sha256\n`), Buffer.from("0000")],
      [pkt("# service=git-receive-pack\n"), Buffer.from("0000"), pkt(`${f.baseline} ${f.ref}\0report-status-v2\n`), Buffer.from("0000")],
      [pkt("# service=git-receive-pack\n"), Buffer.from("0000"), pkt(`${f.baseline} ${f.ref}\0report-status\n`), pkt(`${f.next} ${f.ref}\n`), Buffer.from("0000")],
      [Buffer.from("0001")],
    ]) {
      const push = await PreparedTaskPush.prepare(f.prepared, f.intent, signal()); let calls = 0, gates = 0;
      const transport: TaskPushTransport = async kind => { assert.equal(kind, "advertise"); calls++; return new Response(Buffer.concat(rows), { headers: { "Content-Type": "application/x-git-receive-pack-advertisement" } }); };
      await assert.rejects(push.execute(transport, async () => { gates++; return true; }, signal()), /task_push_/);
      assert.equal(calls, 1); assert.equal(gates, 0);
    }
  } finally { await f.close(); }
});

test("malformed, excessive, redirected or mismatched receive reports remain unknown without leaking raw remote errors", async () => {
  const f = await fixture();
  try {
    for (const response of [
      () => new Response("private remote error", { status: 500 }),
      () => new Response(null, { status: 302, headers: { Location: "https://untrusted.invalid" } }),
      () => new Response(Buffer.concat([pkt("unpack ok\n"), pkt("ok refs/heads/main\n"), Buffer.from("0000")]), { headers: { "Content-Type": "application/x-git-receive-pack-result" } }),
      () => new Response(Buffer.concat([pkt("unpack ok\n"), pkt(`ok ${f.ref}\n`)]), { headers: { "Content-Type": "application/x-git-receive-pack-result" } }),
      () => new Response(Buffer.alloc(65537), { headers: { "Content-Type": "application/x-git-receive-pack-result" } }),
    ]) {
      let received = 0;
      const transport: TaskPushTransport = (kind, stop, body) => kind === "advertise" ? f.http.transport(kind, stop, body) : (received++, Promise.resolve(response()));
      const push = await PreparedTaskPush.prepare(f.prepared, f.intent, signal());
      assert.deepEqual(await push.execute(transport, async () => true, signal()), { status: "unknown", reason: "response_unconfirmed" });
      assert.equal(received, 1);
    }
    assert.equal(f.http.calls.receive, 0);
  } finally { await f.close(); }
});
