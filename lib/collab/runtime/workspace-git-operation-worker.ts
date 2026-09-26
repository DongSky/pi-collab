import { spawn } from "node:child_process";
import { open, rename, unlink, lstat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { inspectWorkspaceGit, type WorkspaceGitLock } from "./workspace-git-view";
import { runnerEnvironment } from "./workspace";
import { ReviewGit } from "./review-git";
import { command, encodeIndex, exclusiveGit, exited, fail, locations, lockIdentity, matchingLock, nativeBootId, readControl, regular, reviewHash, syncDir, transition, type WorkspaceGitControl } from "./workspace-git-operation-common";

// This entrypoint has no database, provider credentials, network or extension
// loader. It writes only after winning the persisted launch CAS and receiving
// the parent broker's final apply message for the exact prepared state.
const [root, workspaceId, expected, mode, attemptId] = process.argv.slice(2);
z.uuid().parse(workspaceId); z.uuid().parse(attemptId); z.string().regex(/^[a-f0-9]{40}$/).parse(expected); z.enum(["execute", "recover"]).parse(mode);
if (!process.send || !process.connected || process.platform === "win32") fail("unsupported_launch");
let current: WorkspaceGitControl | null = null;
let waiter: { resolve: (value: string) => void; reject: (error: Error) => void; oid: string; name: string } | null = null;
process.on("message", raw => {
  const message = z.object({ checkpoint: z.string(), oid: z.string(), action: z.enum(["continue", "apply", "abort"]) }).strict().safeParse(raw);
  if (message.success && waiter && waiter.oid === message.data.oid && waiter.name === message.data.checkpoint) { const pending = waiter; waiter = null; pending.resolve(message.data.action); }
});
process.on("disconnect", () => { waiter?.reject(new Error("workspace_git_operation_parent_lost")); waiter = null; });
const lifetime = setTimeout(() => { try { process.kill(-process.pid, "SIGKILL"); } catch { process.exit(1); } }, 120000);
async function checkpoint(name: string) {
  if (!process.connected || !current) fail("parent_lost");
  const action = await new Promise<string>((resolve, reject) => {
    waiter = { resolve, reject, oid: current!.oid, name };
    process.send!({ checkpoint: name, control: current }, error => { if (error) { waiter = null; reject(new Error("workspace_git_operation_parent_lost")); } });
  });
  if (name === "prepared") { if (action !== "apply") fail("not_authorized"); }
  else if (action !== "continue") fail("cancelled");
}
async function change(patch: Partial<WorkspaceGitControl["state"]>) {
  current = await transition(root, workspaceId, current!.oid, { ...current!.state, ...patch });
}

/** Prepared file-ref transactions lock the checked-out branch and HEAD. Some
 * Git versions reject an explicit symref-verify HEAD alongside its referent;
 * we require/record both actual locks, then inspect the exact HEAD under them. */
async function refTransaction(checkout: string, head: string, commit: string | null) {
  const child = spawn("git", ["--git-dir=.git", "--work-tree=.", "--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.logAllRefUpdates=true", "-c", "core.fsync=committed", "-c", "core.fsyncMethod=fsync", "update-ref", "--stdin"], {
    cwd: checkout, env: { ...runnerEnvironment("/nonexistent", "/nonexistent"), GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" }, stdio: "pipe",
  });
  let buffer = "", pending: { text: string; resolve: () => void; reject: (error: Error) => void } | null = null, closed = false;
  const completion = new Promise<void>(resolve => child.once("close", () => { closed = true; pending?.reject(new Error("workspace_git_operation_ref_transaction_failed")); pending = null; resolve(); }));
  child.stderr.resume(); child.stdin.on("error", () => {}); child.once("error", () => {});
  child.stdout.on("data", (bytes: Buffer) => {
    buffer += bytes.toString("utf8"); if (buffer.length > 4096) { child.kill("SIGKILL"); return; }
    if (pending && buffer.startsWith(`${pending.text}\n`)) { buffer = buffer.slice(pending.text.length + 1); const done = pending; pending = null; done.resolve(); }
  });
  const send = (input: string, expectedLine: string) => new Promise<void>((resolve, reject) => {
    if (closed) { reject(new Error("workspace_git_operation_ref_transaction_failed")); return; }
    pending = { text: expectedLine, resolve, reject }; child.stdin.write(input);
  });
  const abort = async () => {
    // Closing stdin aborts an uncommitted transaction. Await close, including
    // its lock cleanup, before releasing our independent index lock.
    child.stdin.end(); await completion;
  };
  try {
    await send("start\n", "start: ok");
    // Address HEAD itself, so this Git transaction necessarily owns HEAD.lock.
    // Addressing only a branch could race a HEAD change and accidentally treat
    // an unrelated process's HEAD.lock as ours. The caller verifies the exact
    // symbolic target and its lock while this transaction is still prepared.
    await send(`${commit ? `update HEAD ${commit} ${head}` : `verify HEAD ${head}`}\nprepare\n`, "prepare: ok");
    return { abort, commit: async () => { await send("commit\n", "commit: ok"); child.stdin.end(); await completion; } };
  } catch (error) { await abort(); throw error; }
}

async function execute(checkout: string) {
  const request = current!.state.request, indexFile = path.join(checkout, ".git", "index.lock");
  let indexHandle: Awaited<ReturnType<typeof open>> | undefined, tx: Awaited<ReturnType<typeof refTransaction>> | undefined;
  let indexIdentity: WorkspaceGitLock | undefined;
  const releaseIndex = async () => {
    const owned = indexIdentity; indexIdentity = undefined;
    const handle = indexHandle; indexHandle = undefined; await handle?.close();
    if (owned) {
      const matches = await matchingLock(checkout, owned);
      // Retire ownership BEFORE unlink. A crash in that gap deliberately leaves
      // an unknown lock; a later cleanup cannot mistake a reused inode for ours.
      await change({ locks: current!.state.locks.filter(lock => lock.name !== "index.lock") });
      if (matches) { await unlink(indexFile); await syncDir(path.dirname(indexFile)); }
    }
  };
  try {
    await exclusiveGit(checkout);
    // A stale preview fails before any source lock/object effect.
    const view = await inspectWorkspaceGit(root, request.source);
    if (view.revision !== request.revision) fail("stale_revision");
    const plan = request.kind === "stage" ? await view.planStaging(request.revision, request.selections!) : view.planCommit(request.revision, request.identity!);
    if (plan.planHash !== request.planHash) fail("plan_changed");
    const indexBytes = "entries" in plan.manifest ? encodeIndex(plan.manifest.entries) : null;
    if (indexBytes && reviewHash(indexBytes) !== request.afterIndexHash) fail("plan_changed");
    if ("commit" in plan.manifest && plan.manifest.commit !== request.commit) fail("plan_changed");
    indexHandle = await open(indexFile, "wx", 0o600);
    await indexHandle.writeFile(`pi-collab ${request.operationId} ${attemptId}\n`); await indexHandle.sync(); await syncDir(path.dirname(indexFile));
    indexIdentity = await lockIdentity(checkout, "index.lock"); await change({ locks: [indexIdentity] }); await checkpoint("index-locked");
    const objects: { type: "blob" | "tree" | "commit"; values: Map<string, Buffer> }[] = [{ type: "tree", values: plan.trees }];
    if ("blobs" in plan) objects.push({ type: "blob", values: plan.blobs });
    if ("bytes" in plan) objects.push({ type: "commit", values: new Map([[request.commit!, plan.bytes]]) });
    for (const group of objects) for (const [oid, bytes] of group.values) {
      if ((await command(checkout, ["--git-dir=.git", "hash-object", "-w", "-t", group.type, "--stdin"], bytes)).bytes.toString().trim() !== oid) fail("invalid_object");
    }
    const reader = await ReviewGit.open(root, ["workspaces", workspaceId, "checkout", ".git"], AbortSignal.timeout(30000));
    for (const group of objects) {
      const values = await reader.objects([...group.values.keys()], group.type, 64 * 1024 * 1024);
      for (const [oid, bytes] of values) if (!bytes.equals(group.values.get(oid)!)) fail("invalid_object");
    }
    const branch = `refs/heads/task/${workspaceId}`;
    tx = await refTransaction(checkout, request.head, request.commit);
    const locks = [indexIdentity, await lockIdentity(checkout, "HEAD.lock"), await lockIdentity(checkout, `${branch}.lock`)];
    await change({ locks }); await checkpoint("refs-locked");
    if ((await inspectWorkspaceGit(root, request.source, AbortSignal.timeout(60000), locks)).revision !== request.revision) fail("stale_revision");
    await change({ phase: "prepared" }); await checkpoint("prepared");
    // This CAS records the parent's final admission BEFORE a possible effect.
    // Recovery will observe or abort it, never replay it.
    await change({ phase: "authorized" }); await checkpoint("authorized");
    if ((await inspectWorkspaceGit(root, request.source, AbortSignal.timeout(60000), locks)).revision !== request.revision) fail("stale_revision");
    if (!process.connected) fail("parent_lost");
    if (indexBytes) {
      await indexHandle.truncate(0);
      for (let offset = 0; offset < indexBytes.length;) { const written = await indexHandle.write(indexBytes, offset, indexBytes.length - offset, offset); if (!written.bytesWritten) fail("short_write"); offset += written.bytesWritten; }
      await indexHandle.sync();
      if (reviewHash(await regular(indexFile)) !== request.afterIndexHash) fail("short_write");
      if (!await matchingLock(checkout, indexIdentity)) fail("lock_changed");
      // Rename consumes this lock pathname just like unlink does. Retire the
      // recorded ownership first, so a crash after rename cannot leave a stale
      // inode claim that later matches an unrelated local Git index lock.
      await change({ locks: current!.state.locks.filter(lock => lock.name !== "index.lock") });
      await checkpoint("index-retired");
      if ((await inspectWorkspaceGit(root, request.source, AbortSignal.timeout(60000), locks)).revision !== request.revision) fail("stale_revision");
      if (!process.connected) fail("parent_lost");
      await rename(indexFile, path.join(checkout, ".git", "index")); await syncDir(path.dirname(indexFile));
    } else { await tx.commit(); tx = undefined; }
    await checkpoint("effect");
    await change({ phase: "applied" }); await checkpoint("sealed");
  } catch (error) {
    // Once admitted, any exception is an uncertain effect until reconciliation.
    // Known pre-effect failures may close only after owned locks are cleaned.
    if (!["authorized", "applied"].includes(current!.state.phase)) {
      await tx?.abort(); tx = undefined;
      await releaseIndex();
      await change({ phase: "aborted", reason: error instanceof Error && /^workspace_git_[a-z_]+$/.test(error.message) ? error.message.slice(0, 100) : "preparation_failed" });
    }
    throw error;
  } finally {
    await tx?.abort(); await releaseIndex();
    for (const name of ["index.lock", "HEAD.lock", `refs/heads/task/${workspaceId}.lock`, "packed-refs.lock"]) {
      try { await lstat(path.join(checkout, ".git", name)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      fail("locks_remaining");
    }
    await change({ locks: [], released: true });
  }
}

async function recover(checkout: string) {
  const state = current!.state, request = state.request, permitted = ["index.lock", "HEAD.lock", `refs/heads/task/${workspaceId}.lock`];
  await exclusiveGit(checkout);
  // No guessed ownership: unknown or replaced lock files retain quarantine.
  for (const name of permitted) {
    let present = true; try { await lstat(path.join(checkout, ".git", name)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") present = false; else throw error; }
    const recorded = state.locks.find(lock => lock.name === name);
    // Git may itself remove transaction locks on pipe closure before its group
    // exits. Never unlink a Git-owned HEAD/ref lock based on a recycled inode.
    if (present && (name !== "index.lock" || !recorded || !await matchingLock(checkout, recorded))) fail("unknown_lock");
    if (present && name === "index.lock") {
      const bytes = await regular(path.join(checkout, ".git", name));
      const marker = `pi-collab ${request.operationId} `;
      if (!(bytes.length < 200 && bytes.toString().startsWith(marker)) && reviewHash(bytes) !== request.afterIndexHash) fail("unknown_lock");
    }
  }
  let phase = state.phase;
  if (phase === "authorized") {
    if (request.kind === "stage") {
      const actual = reviewHash(await regular(path.join(checkout, ".git", "index")));
      phase = actual === request.afterIndexHash ? "applied" : actual === request.indexHash ? "aborted" : fail("effect_unknown");
    } else {
      const actual = (await command(checkout, ["--git-dir=.git", "rev-parse", "--verify", `refs/heads/task/${workspaceId}`])).bytes.toString().trim();
      phase = actual === request.commit ? "applied" : actual === request.head ? "aborted" : fail("effect_unknown");
    }
  } else if (phase !== "applied" && phase !== "aborted") phase = "aborted";
  await checkpoint("recovery-cleanup");
  // The old group is absent, this recovery group owns the CAS, and another
  // platform owner cannot start until THIS group exits. Inode checks alone
  // would not suffice without those three conditions.
  for (const lock of state.locks) {
    if (!permitted.includes(lock.name)) fail("invalid_lock");
    if (lock.name === "index.lock" && await matchingLock(checkout, lock)) {
      await change({ locks: current!.state.locks.filter(item => item.name !== lock.name) });
      await unlink(path.join(checkout, ".git", lock.name)); await syncDir(path.dirname(path.join(checkout, ".git", lock.name)));
    }
  }
  await change({ phase, released: true, reason: phase === "aborted" ? "reconciled_without_replay" : null }); await checkpoint("sealed");
}

try {
  const previous = await readControl(root, workspaceId);
  if (!previous || previous.oid !== expected) fail("stale_owner");
  if (mode === "execute" ? previous.state.phase !== "reserved" || previous.state.attempt !== null : !await exited(previous.state)) fail("writer_present");
  const where = await locations(root, workspaceId);
  current = await transition(root, workspaceId, expected, { ...previous.state, released: false, phase: mode === "execute" ? "running" : previous.state.phase,
    attempt: { id: attemptId, pid: process.pid, bootId: await nativeBootId(), mode: mode as "execute" | "recover" } });
  await checkpoint("claimed");
  if (mode === "execute") await execute(where.checkout); else await recover(where.checkout);
  process.send?.({ result: "settled" });
} catch {
  process.send?.({ result: "attention" }); process.exitCode = 1;
} finally { clearTimeout(lifetime); if (process.connected) process.disconnect?.(); }
