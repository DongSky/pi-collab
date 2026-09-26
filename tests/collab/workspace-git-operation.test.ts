import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm, link, lstat, chmod, rename } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createWorkspace, runnerEnvironment } from "../../lib/collab/runtime/workspace";
import { beginNativeReceipt } from "../../lib/collab/runtime/receipts";
import { NativeRuntimeBackend } from "../../lib/collab/runtime/backends";
import { inspectWorkspaceGit } from "../../lib/collab/runtime/workspace-git-view";
import { cancelReservedWorkspaceGit, launchWorkspaceGitOperation, observeWorkspaceGitOperation, reserveWorkspaceGit, reserveWorkspaceGitRecovery, type WorkspaceGitAdmission, type WorkspaceGitReservation } from "../../lib/collab/runtime/workspace-git-operation";
import { readControl, transition } from "../../lib/collab/runtime/workspace-git-operation-common";

const exec = promisify(execFile);
const git = async (cwd: string, args: string[]) => (await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.autocrlf=false", ...args], { cwd, env: runnerEnvironment("/nonexistent", "/nonexistent"), timeout: 10000 })).stdout.trim();
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "pi-collab-git-operation-")), original = path.join(root, "original"); await mkdir(original);
  await git(original, ["init", "-b", "main"]); await git(original, ["config", "user.name", "Operation fixture"]); await git(original, ["config", "user.email", "fixture@invalid"]);
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`), base = lines.join("\r\n");
  await writeFile(path.join(original, "code.txt"), base); await writeFile(path.join(original, "other.txt"), "original\n");
  await git(original, ["add", "."]); await git(original, ["commit", "-m", "Base"]);
  const workspace = await createWorkspace(root, randomUUID(), original), source = { workspaceId: workspace.id, identity: { runId: randomUUID(), executorId: randomUUID(), epoch: "1" } };
  await (await beginNativeReceipt(workspace, source.identity)).stopped();
  lines[2] = "choose first change"; lines[36] = "leave second change";
  await writeFile(path.join(workspace.checkout, "code.txt"), lines.join("\r\n"));
  const view = await inspectWorkspaceGit(root, source), diff = await view.file("working", "code.txt");
  const admission: WorkspaceGitAdmission = { operationId: randomUUID(), source, revision: view.revision, kind: "stage", selections: [{ path: "code.txt", direction: "stage", hunks: [diff.hunks[0].id] }] };
  return { root, original, workspace, source, admission, lines, base, git: (args: string[]) => git(workspace.checkout, args), close: () => rm(root, { recursive: true, force: true }) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function using(run: (f: Fixture) => Promise<void>) { const f = await fixture(); try { await run(f); } finally { await f.close(); } }
const authorize = async (_prepared: unknown, apply: () => Promise<unknown>) => { await apply(); };
const run = (reservation: WorkspaceGitReservation) => launchWorkspaceGitOperation(reservation, { authorize }).done;
async function recovery(f: Fixture) {
  const deadline = Date.now() + 4000;
  while (!(await observeWorkspaceGitOperation(f.root, f.workspace.id))!.writerExited && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  return reserveWorkspaceGitRecovery(f.root, f.workspace.id);
}
async function commitAdmission(f: Fixture): Promise<WorkspaceGitAdmission> {
  const view = await inspectWorkspaceGit(f.root, f.source), operationId = randomUUID();
  return { kind: "commit", operationId, source: f.source, revision: view.revision, identity: { operationId, actorId: "fixture-member", displayName: "确认成员", requestedAt: "2026-09-23T00:00:00.000Z", message: "Confirm exact staged code" } };
}

test("native stage writes only selected bytes; exact commit advances its task branch while index and working draft survive", () => using(async f => {
  const oldHead = await f.git(["rev-parse", "HEAD"]), originalIndex = await readFile(path.join(f.workspace.checkout, ".git/index"));
  const result = await run(await reserveWorkspaceGit(f.root, f.admission)); assert.equal(result?.state.phase, "applied"); assert.equal(result?.settled, true);
  const expected = f.base.split("\r\n"); expected[2] = f.lines[2];
  assert.equal(await f.git(["show", ":code.txt"]), expected.join("\r\n")); assert.equal(await readFile(path.join(f.workspace.checkout, "code.txt"), "utf8"), f.lines.join("\r\n"));
  assert.equal(await f.git(["rev-parse", "HEAD"]), oldHead); assert.notDeepEqual(await readFile(path.join(f.workspace.checkout, ".git/index")), originalIndex);
  const admission = await commitAdmission(f), index = await readFile(path.join(f.workspace.checkout, ".git/index"));
  const committed = await run(await reserveWorkspaceGit(f.root, admission)); assert.equal(committed?.state.phase, "applied");
  assert.equal(await f.git(["rev-parse", "HEAD"]), committed?.state.request.commit); assert.equal(await f.git(["show", "HEAD:code.txt"]), expected.join("\r\n"));
  assert.deepEqual(await readFile(path.join(f.workspace.checkout, ".git/index")), index); assert.equal(await f.git(["rev-list", "--count", `${oldHead}..HEAD`]), "1");
  assert.equal(await git(f.original, ["rev-parse", "HEAD"]), oldHead);
  assert.ok((await f.git(["cat-file", "commit", "HEAD"])).includes("pi-collab-member"));
  assert.equal((await inspectWorkspaceGit(f.root, f.source)).summary().files.find(file => file.path === "code.txt")?.staged, false);
}));

test("one durable owner wins competing reservations; cancellation fences delayed and duplicated native starts", () => using(async f => {
  const requests = await Promise.allSettled([reserveWorkspaceGit(f.root, f.admission), reserveWorkspaceGit(f.root, { ...f.admission, operationId: randomUUID() })]);
  assert.equal(requests.filter(r => r.status === "fulfilled").length, 1);
  const reservation = requests.find(r => r.status === "fulfilled")!.value;
  const before = await readFile(path.join(f.workspace.checkout, ".git/index"));
  await cancelReservedWorkspaceGit(reservation); const late = await run(reservation); assert.equal(late?.state.phase, "aborted");
  assert.deepEqual(await readFile(path.join(f.workspace.checkout, ".git/index")), before);
  const next = await reserveWorkspaceGit(f.root, { ...f.admission, operationId: randomUUID() });
  const first = launchWorkspaceGitOperation(next, { authorize }), second = launchWorkspaceGitOperation(next, { authorize }); await Promise.all([first.done, second.done]);
  assert.equal((await observeWorkspaceGitOperation(f.root, f.workspace.id))?.state.phase, "applied");
  await assert.rejects(cancelReservedWorkspaceGit(reservation), /stale_owner/);
}));

test("denied final admission, stale drafts and shared metadata cannot write the index", () => using(async f => {
  const before = await readFile(path.join(f.workspace.checkout, ".git/index"));
  const denied = await launchWorkspaceGitOperation(await reserveWorkspaceGit(f.root, f.admission), { authorize: async () => {} }).done;
  assert.equal(denied?.state.phase, "aborted"); assert.deepEqual(await readFile(path.join(f.workspace.checkout, ".git/index")), before);
  const next = await reserveWorkspaceGit(f.root, { ...f.admission, operationId: randomUUID() });
  await writeFile(path.join(f.workspace.checkout, "code.txt"), "external edit\n");
  const stale = await run(next); assert.equal(stale?.state.phase, "aborted"); assert.match(stale!.state.reason!, /stale_revision/);
  assert.deepEqual(await readFile(path.join(f.workspace.checkout, ".git/index")), before);
  const view = await inspectWorkspaceGit(f.root, f.source), shared = await reserveWorkspaceGit(f.root, { ...f.admission, operationId: randomUUID(), revision: view.revision, kind: "stage", selections: [{ path: "code.txt", direction: "stage", hunks: "file" }] });
  await link(path.join(f.workspace.checkout, ".git/index"), path.join(f.root, "shared-index"));
  assert.equal((await run(shared))?.state.phase, "aborted"); assert.deepEqual(await readFile(path.join(f.workspace.checkout, ".git/index")), before);
}));

test("prepared native locks reject competing Git and live recovery; edits while waiting invalidate the final effect", () => using(async f => {
  const result = await launchWorkspaceGitOperation(await reserveWorkspaceGit(f.root, f.admission), { authorize,
    checkpoint: async event => {
      if (event.checkpoint === "index-retired") { await writeFile(path.join(f.workspace.checkout, "code.txt"), "changed after prepared\n"); return; }
      if (event.checkpoint !== "prepared") return;
      await assert.rejects(f.git(["add", "code.txt"])); await assert.rejects(f.git(["checkout", "--detach"]));
      await assert.rejects(f.git(["symbolic-ref", "HEAD", "refs/heads/main"]));
      await assert.rejects(reserveWorkspaceGitRecovery(f.root, f.workspace.id), /writer_present/);
      await assert.rejects(reserveWorkspaceGit(f.root, { ...f.admission, operationId: randomUUID() }), /occupied/);
    },
  }).done;
  assert.equal(result?.state.phase, "authorized");
  const restored = await run(await recovery(f)); assert.equal(restored?.state.phase, "aborted");
  assert.equal(await f.git(["show", ":code.txt"]), f.base);
}));

test("a killed stage writer is observed after its actual index rename and never applies twice", () => using(async f => {
  const reservation = await reserveWorkspaceGit(f.root, f.admission);
  const handle = launchWorkspaceGitOperation(reservation, { authorize, checkpoint: async (event, child) => {
    if (event.checkpoint === "effect") process.kill(child.pid, "SIGKILL"); // Git aborts its verify transaction on pipe close.
  } });
  const crashed = await handle.done; assert.equal(crashed?.state.phase, "authorized");
  const index = await readFile(path.join(f.workspace.checkout, ".git/index"));
  const reconciled = await run(await recovery(f)); assert.equal(reconciled?.state.phase, "applied"); assert.equal(reconciled?.settled, true);
  assert.deepEqual(await readFile(path.join(f.workspace.checkout, ".git/index")), index);
  await run(reservation); assert.deepEqual(await readFile(path.join(f.workspace.checkout, ".git/index")), index);
}));

test("a killed commit writer is reconciled from the exact branch SHA and preserves the confirmed index", () => using(async f => {
  await run(await reserveWorkspaceGit(f.root, f.admission)); const admission = await commitAdmission(f), before = await f.git(["rev-parse", "HEAD"]);
  const reservation = await reserveWorkspaceGit(f.root, admission), index = await readFile(path.join(f.workspace.checkout, ".git/index"));
  await launchWorkspaceGitOperation(reservation, { authorize, checkpoint: async (event, child) => { if (event.checkpoint === "effect") child.stop(); } }).done;
  const result = await run(await recovery(f)); assert.equal(result?.state.phase, "applied"); assert.equal(result?.settled, true);
  assert.equal(await f.git(["rev-list", "--count", `${before}..HEAD`]), "1"); assert.deepEqual(await readFile(path.join(f.workspace.checkout, ".git/index")), index);
}));

test("unadmitted crashed preparation is aborted; a stale cleanup cannot overwrite a newer durable owner", () => using(async f => {
  const reservation = await reserveWorkspaceGit(f.root, f.admission);
  await launchWorkspaceGitOperation(reservation, { authorize, checkpoint: async (event, child) => { if (event.checkpoint === "index-locked") child.stop(); } }).done;
  const old = await readControl(f.root, f.workspace.id); assert.equal(old?.state.phase, "running");
  const repaired = await run(await recovery(f)); assert.equal(repaired?.state.phase, "aborted");
  await assert.rejects(lstat(path.join(f.workspace.checkout, ".git/index.lock")), /ENOENT/);
  const next = await reserveWorkspaceGit(f.root, { ...f.admission, operationId: randomUUID() });
  await assert.rejects(transition(f.root, f.workspace.id, old!.oid, { ...old!.state, phase: "aborted" }));
  assert.equal((await readControl(f.root, f.workspace.id))?.oid, next.oid); await cancelReservedWorkspaceGit(next);
}));

test("unknown/replaced locks retain quarantine without deleting other users' locks", () => using(async f => {
  await launchWorkspaceGitOperation(await reserveWorkspaceGit(f.root, f.admission), { authorize, checkpoint: async (event, child) => { if (event.checkpoint === "index-locked") child.stop(); } }).done;
  const file = path.join(f.workspace.checkout, ".git/index.lock"); await rm(file); await writeFile(file, "external Git writer\n");
  const result = await run(await recovery(f)); assert.equal(result?.settled, false); assert.equal(await readFile(file, "utf8"), "external Git writer\n");
  await assert.rejects(reserveWorkspaceGit(f.root, { ...f.admission, operationId: randomUUID() }), /occupied/);
}));

test("whole-file stage and unstage preserve binary bytes, executable mode, deletion and unrelated drafts", () => using(async f => {
  const bytes = Buffer.from([0, 255, 128, 10]); await writeFile(path.join(f.workspace.checkout, "binary.bin"), bytes);
  await writeFile(path.join(f.workspace.checkout, "script.sh"), "#!/bin/sh\nexit 0\n"); await chmod(path.join(f.workspace.checkout, "script.sh"), 0o755);
  await rm(path.join(f.workspace.checkout, "other.txt"));
  let view = await inspectWorkspaceGit(f.root, f.source);
  const selection = ["binary.bin", "script.sh", "other.txt"].map(file => ({ path: file, direction: "stage" as const, hunks: "file" as const }));
  const result = await run(await reserveWorkspaceGit(f.root, { kind: "stage", operationId: randomUUID(), source: f.source, revision: view.revision, selections: selection }));
  assert.equal(result?.state.phase, "applied");
  const binary = await exec("git", ["show", ":binary.bin"], { cwd: f.workspace.checkout, env: runnerEnvironment("/nonexistent", "/nonexistent"), encoding: "buffer" }); assert.deepEqual(binary.stdout, bytes);
  assert.match(await f.git(["ls-files", "--stage", "script.sh"]), /^100755 /); await assert.rejects(f.git(["show", ":other.txt"]));
  assert.equal(await f.git(["show", ":code.txt"]), f.base);
  view = await inspectWorkspaceGit(f.root, f.source);
  assert.equal((await run(await reserveWorkspaceGit(f.root, { kind: "stage", operationId: randomUUID(), source: f.source, revision: view.revision,
    selections: selection.map(item => ({ ...item, direction: "unstage" })) })))?.state.phase, "applied");
  assert.equal(await f.git(["diff", "--cached", "--name-only"]), ""); assert.deepEqual(await readFile(path.join(f.workspace.checkout, "binary.bin")), bytes);
  await assert.rejects(readFile(path.join(f.workspace.checkout, "other.txt")), /ENOENT/);
}));

test("recovery itself has a fenced process owner; another cleanup cannot run until that group exits", () => using(async f => {
  await launchWorkspaceGitOperation(await reserveWorkspaceGit(f.root, f.admission), { authorize, checkpoint: async (event, child) => { if (event.checkpoint === "index-locked") child.stop(); } }).done;
  const reserved = await recovery(f);
  await launchWorkspaceGitOperation(reserved, { authorize, checkpoint: async (event, child) => {
    if (event.checkpoint !== "recovery-cleanup") return;
    await assert.rejects(reserveWorkspaceGitRecovery(f.root, f.workspace.id), /writer_present/);
    await assert.rejects(reserveWorkspaceGit(f.root, { ...f.admission, operationId: randomUUID() }), /occupied/);
    child.stop();
  } }).done;
  assert.equal((await observeWorkspaceGitOperation(f.root, f.workspace.id))?.settled, false);
  assert.equal((await run(await recovery(f)))?.settled, true);
  // Even an old recovery descriptor cannot claim the new state again.
  assert.equal((await run(reserved))?.state.phase, "aborted");
}));

test("unexpected post-effect index changes stay unknown and are never overwritten during recovery", () => using(async f => {
  await launchWorkspaceGitOperation(await reserveWorkspaceGit(f.root, f.admission), { authorize, checkpoint: async (event, child) => { if (event.checkpoint === "effect") process.kill(child.pid, "SIGKILL"); } }).done;
  const reserved = await recovery(f);
  await writeFile(path.join(f.workspace.checkout, "other.txt"), "external staged work\n"); await f.git(["add", "other.txt"]);
  const index = await readFile(path.join(f.workspace.checkout, ".git/index")), result = await run(reserved);
  assert.equal(result?.state.phase, "authorized"); assert.equal(result?.settled, false); assert.deepEqual(await readFile(path.join(f.workspace.checkout, ".git/index")), index);
}));

test("applied evidence survives later local commits but unreleased/foreign locks cannot be reported as settled", () => using(async f => {
  await run(await reserveWorkspaceGit(f.root, f.admission)); const admission = await commitAdmission(f);
  await launchWorkspaceGitOperation(await reserveWorkspaceGit(f.root, admission), { authorize, checkpoint: async (event, child) => { if (event.checkpoint === "sealed") child.stop(); } }).done;
  const control = await readControl(f.root, f.workspace.id); assert.equal(control?.state.phase, "applied"); assert.equal(control?.state.released, false);
  const file = path.join(f.workspace.checkout, ".git/HEAD.lock"); await writeFile(file, "external lock\n");
  const blocked = await run(await recovery(f)); assert.equal(blocked?.settled, false); assert.equal(await readFile(file, "utf8"), "external lock\n");
  await assert.rejects(reserveWorkspaceGit(f.root, { ...f.admission, operationId: randomUUID() }), /occupied/);
  await rm(file); assert.equal((await run(await recovery(f)))?.settled, true);
  await f.git(["add", "code.txt"]); await f.git(["commit", "-m", "Later normal Git commit"]); const tip = await f.git(["rev-parse", "HEAD"]);
  const observed = await run(await recovery(f)); assert.equal(observed?.state.phase, "applied"); assert.equal(await f.git(["rev-parse", "HEAD"]), tip);
  // IDs are permanently consumed, even after another successful operation.
  const latest = await inspectWorkspaceGit(f.root, f.source);
  await writeFile(path.join(f.workspace.checkout, "other.txt"), "new draft\n"); const fresh = await inspectWorkspaceGit(f.root, f.source);
  assert.notEqual(latest.revision, fresh.revision);
  await assert.rejects(reserveWorkspaceGit(f.root, { ...f.admission, revision: fresh.revision, kind: "stage", selections: [{ path: "other.txt", direction: "stage", hunks: "file" }] }));
}));

test("SIGKILL of an entire prepared Git group leaves ref locks quarantined, never guessed as owned cleanup", () => using(async f => {
  await launchWorkspaceGitOperation(await reserveWorkspaceGit(f.root, f.admission), { authorize, checkpoint: async (event, child) => { if (event.checkpoint === "prepared") child.stop(); } }).done;
  // A killed Git may be reaped late by the OS. Recovery remains unavailable
  // until every member of the recorded process group is actually absent.
  let reserved: WorkspaceGitReservation;
  try { reserved = await recovery(f); } catch (error) { assert.match(String(error), /writer_present/); assert.equal((await observeWorkspaceGitOperation(f.root, f.workspace.id))?.settled, false); return; }
  const headLock = path.join(f.workspace.checkout, ".git/HEAD.lock"), before = await readFile(headLock);
  const result = await run(reserved); assert.equal(result?.settled, false); assert.deepEqual(await readFile(headLock), before);
}));

test("switching HEAD to another branch with the same SHA before ref locking never writes that branch", () => using(async f => {
  await run(await reserveWorkspaceGit(f.root, f.admission));
  const admission = await commitAdmission(f), reservation = await reserveWorkspaceGit(f.root, admission), before = await f.git(["rev-parse", "HEAD"]);
  const result = await launchWorkspaceGitOperation(reservation, { authorize, checkpoint: async event => {
    if (event.checkpoint === "index-locked") await f.git(["symbolic-ref", "HEAD", "refs/heads/main"]);
  } }).done;
  assert.equal(result?.state.phase, "aborted"); assert.equal(await f.git(["rev-parse", "main"]), before); assert.equal(await f.git(["rev-parse", f.workspace.branch]), before);
}));

test("a real Pi tool draft is staged and committed after confirmed native exit without external inference", () => using(async f => {
  const workspace = await createWorkspace(f.root, randomUUID(), f.original), source = { workspaceId: workspace.id, identity: { runId: randomUUID(), executorId: randomUUID(), epoch: "1" } };
  const agent = await new NativeRuntimeBackend().start(workspace, undefined, source.identity);
  try { await agent.peer.command("bash", { command: "printf 'real Pi draft\\n' > code.txt" }); }
  finally { await agent.stop(); }
  let view = await inspectWorkspaceGit(f.root, source);
  const staged = await run(await reserveWorkspaceGit(f.root, { kind: "stage", source, operationId: randomUUID(), revision: view.revision, selections: [{ path: "code.txt", direction: "stage", hunks: "file" }] }));
  assert.equal(staged?.settled, true); view = await inspectWorkspaceGit(f.root, source); const operationId = randomUUID();
  const committed = await run(await reserveWorkspaceGit(f.root, { kind: "commit", source, operationId, revision: view.revision,
    identity: { operationId, actorId: "native-pi-member", displayName: "本机成员", requestedAt: "2026-09-23T00:00:00.000Z", message: "Confirm the actual Pi draft" } }));
  assert.equal(committed?.settled, true); assert.equal(await git(workspace.checkout, ["show", "HEAD:code.txt"]), "real Pi draft");
  assert.equal(await git(workspace.checkout, ["status", "--porcelain"]), "");
}));

test("retired index locks cannot be cleaned after a rename gap or when a later local writer reuses the exact old inode", async () => {
  for (const checkpoint of ["index-retired", "effect"]) await using(async f => {
    await launchWorkspaceGitOperation(await reserveWorkspaceGit(f.root, f.admission), { authorize, checkpoint: async (event, child) => {
      if (event.checkpoint === checkpoint) process.kill(child.pid, "SIGKILL");
    } }).done;
    const reservation = await recovery(f), index = path.join(f.workspace.checkout, ".git/index"), lock = `${index}.lock`;
    const control = await readControl(f.root, f.workspace.id); assert.ok(!control!.state.locks.some(item => item.name === "index.lock"));
    if (checkpoint === "effect") {
      // Retain exactly the inode and approved bytes of the old consumed lock,
      // now owned by an independent local writer. Inode/hash checks alone fail.
      const bytes = await readFile(index); await rename(index, lock); await writeFile(index, bytes);
    }
    const lockBefore = await readFile(lock), sourceBefore = await readFile(index), result = await run(reservation);
    assert.equal(result?.settled, false); assert.deepEqual(await readFile(lock), lockBefore); assert.deepEqual(await readFile(index), sourceBefore);
  });
});
