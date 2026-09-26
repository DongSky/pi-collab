import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { createServer, createConnection, type Socket } from "node:net";
import { localConfig, applicationEnvironment, connectionString, executorConnectionString } from "../../scripts/local-config";
import { startNativeDatabase } from "../../scripts/native-database";
import { migrate } from "../../scripts/migrate";
import { provisioningAuth } from "../../lib/collab/auth";
import { database } from "../../lib/collab/database";
import { createProject } from "../../lib/collab/projects";
import { createTask } from "../../lib/collab/tasks";
import { startRun, runDetail } from "../../lib/collab/runs";
import { changeProjectMember, reassignTask } from "../../lib/collab/project-members";
import { manageRun, processRecoveries, runActionInput } from "../../lib/collab/recovery";
import { ExecutionStore, type ClaimedRun } from "../../lib/collab/execution-store";
import { executeClaim } from "../../lib/collab/executor";
import { importLocalRepository } from "../../lib/collab/repository-import";
import { NativeRuntimeBackend } from "../../lib/collab/runtime/backends";
import { inspectNativeExit } from "../../lib/collab/runtime/receipts";
import { requestSnapshot, listSnapshots, snapshotDetail, processSnapshots } from "../../lib/collab/snapshots";

const config = await localConfig(), databaseName = `pi_collab_test_${randomBytes(6).toString("hex")}`;
const native = await startNativeDatabase(config);
Object.assign(process.env, applicationEnvironment(config), { DATABASE_URL: connectionString(config, false, databaseName) });
const admin = new Pool({ connectionString: connectionString(config, true, databaseName) });
const store = new ExecutionStore(executorConnectionString(config, databaseName));
const executor = randomUUID(), organization = randomUUID(), users: string[] = [];
const root = await mkdtemp(path.join(tmpdir(), "pi-collab-recovery-")), source = path.join(root, "source"), exec = promisify(execFile);
process.env.PI_COLLAB_DATA_DIR = root;
let project: string, imported: { id: string; baseSha: string };
before(async () => {
  await migrate(config, databaseName);
  const provision = provisioningAuth(admin);
  for (let i = 0; i < 5; i++) {
    const result = await provision.api.signUpEmail({ body: { name: `Recovery user ${i}`, email: `recovery${i}@test.invalid`, password: randomBytes(20).toString("hex") } });
    users.push(result.user.id);
  }
  await admin.query("INSERT INTO collab.organizations(id,name,created_by) VALUES($1,'Recovery test',$2)", [organization, users[0]]);
  for (let i = 0; i < 4; i++) await admin.query("INSERT INTO collab.memberships(organization_id,user_id,role) VALUES($1,$2,$3)", [organization, users[i], i === 0 ? "owner" : "member"]);
  // SQL authority fixture; real MFA enrollment is covered by the browser suite.
  await admin.query('UPDATE public."user" SET "twoFactorEnabled"=true WHERE id=$1', [users[0]]);
  project = (await createProject(users[0], { organizationId: organization, name: "Recovery project", description: "" })).id;
  for (let i = 1; i < 4; i++) await admin.query("INSERT INTO collab.project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,$4)", [organization, project, users[i], i === 1 ? "developer" : i === 2 ? "reviewer" : "maintainer"]);
  await mkdir(source);
  for (const args of [["init"], ["config", "user.name", "Recovery acceptance"], ["config", "user.email", "recovery@test.invalid"]]) await exec("git", args, { cwd: source });
  await writeFile(path.join(source, "base.txt"), "unchanged\n");
  await exec("git", ["add", "."], { cwd: source }); await exec("git", ["commit", "-m", "Initial fixture"], { cwd: source });
  imported = await importLocalRepository(admin, root, { projectId: project, actorId: users[0], name: "Local recovery fixture", source });
});
after(async () => {
  await store.close(); await database().end(); globalThis.__piCollabPool = undefined; await admin.end();
  const cleanup = new Pool({ connectionString: connectionString(config, true, "postgres") });
  await cleanup.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`); await cleanup.end(); await native.stop();
  await rm(root, { recursive: true, force: true });
});
async function claimed() {
  const task = await createTask(users[1], project, { title: "Recovery acceptance", description: "", acceptance: "" });
  await startRun(users[1], task.id, { repositoryId: imported.id, baseSha: imported.baseSha, prompt: "Recovery test", expectedVersion: task.version, idempotencyKey: randomUUID() });
  const claim = await store.claim(executor, "native"); assert.ok(claim); assert.equal(claim.run.task_id, task.id); return claim;
}
async function request(claim: ClaimedRun, action: "recover" | "archive" = "recover", actor = users[0]) {
  const detail = await runDetail(users[0], claim.run.id);
  const input = { action, expectedRevision: detail.run.revision as string, idempotencyKey: randomUUID(), reason: "Verify the old writer and preserve unknown effects." };
  return { input, result: await manageRun(actor, claim.run.id, input) };
}
async function quarantine(claim: ClaimedRun) { await store.quarantine(executor, claim.run.id, claim.run.epoch, "test_outcome_unknown"); }
// Only SQL protocol tests use synthetic evidence; actual writer tests use disk/process observation.
async function resolveProtocolFixture(claim: ClaimedRun) {
  const { result } = await request(claim);
  await store.resolveRecovery(result.actionId, "stop_confirmed", "a".repeat(64));
}

test("recovery/archival are maintainer-scoped, MFA-protected, versioned and unavailable for live runs", async () => {
  for (const expectedRevision of ["broken", "1.5", "-1", "9223372036854775808"]) assert.equal(runActionInput.safeParse({ action: "recover", expectedRevision, idempotencyKey: randomUUID(), reason: "Malformed revision request" }).success, false);
  const claim = await claimed();
  for (const actor of [users[1], users[2], users[4]]) await assert.rejects(request(claim, "recover", actor), /forbidden|not_found/);
  await assert.rejects(request(claim, "recover"), /run_not_reconciling/);
  await assert.rejects(request(claim, "archive"), /workspace_not_stopped/);
  await quarantine(claim);
  await admin.query("UPDATE collab.memberships SET role='admin' WHERE organization_id=$1 AND user_id=$2", [organization, users[3]]);
  await assert.rejects(request(claim, "recover", users[3]), /mfa_required/);
  await admin.query("UPDATE collab.memberships SET role='member' WHERE organization_id=$1 AND user_id=$2", [organization, users[3]]);
  await assert.rejects(manageRun(users[0], claim.run.id, { action: "recover", expectedRevision: "1", idempotencyKey: randomUUID(), reason: "Explicit stale request" }), /stale_revision/);
  await assert.rejects(database().query("SELECT collab_worker.resolve_recovery($1,'stop_confirmed',$2)", [randomUUID(), "a".repeat(64)]), /permission/);
  await assert.rejects(database().query("UPDATE collab.run_actions SET status='resolved'"), /permission/);
  await resolveProtocolFixture(claim);
});

test("duplicate recovery requests remain durable; lost completion response cannot reopen or replay the run", async () => {
  const claim = await claimed(); await quarantine(claim);
  const detail = await runDetail(users[0], claim.run.id), input = { action: "recover" as const, expectedRevision: detail.run.revision, idempotencyKey: randomUUID(), reason: "Concurrent recovery acceptance" };
  const accepted = await Promise.all(Array.from({ length: 25 }, () => manageRun(users[0], claim.run.id, input)));
  assert.equal(new Set(accepted.map(r => r.actionId)).size, 1); assert.equal(accepted.filter(r => !r.replayed).length, 1);
  await assert.rejects(manageRun(users[0], claim.run.id, { ...input, reason: "Changed request must fail" }), /idempotency_conflict/);
  await assert.rejects(manageRun(users[0], claim.run.id, { ...input, idempotencyKey: randomUUID() }), /recovery_pending/);
  await assert.rejects(store.resolveRecovery(accepted[0].actionId, "stop_confirmed"), /invalid_recovery_evidence/);
  await Promise.all(Array.from({ length: 5 }, () => store.resolveRecovery(accepted[0].actionId, "stop_confirmed", "a".repeat(64))));
  const replay = await manageRun(users[0], claim.run.id, input); assert.equal(replay.replayed, true); assert.equal(replay.status, "resolved");
  assert.equal((await runDetail(users[0], claim.run.id)).commands[0].status, "unknown");
  assert.equal((await admin.query("SELECT 1 FROM collab.audit_events WHERE resource_id=$1 AND action='run.recovery_resolved'", [claim.run.id])).rowCount, 1);
  await assert.rejects(store.running(executor, claim.run.id, claim.run.epoch), /stale_lease/);
});

test("revocation and regrant cannot authorize an old pending recovery, and outsiders cannot read its evidence", async () => {
  const claim = await claimed(); await quarantine(claim);
  const { result } = await request(claim, "recover", users[3]);
  const version = (await admin.query("SELECT authorization_version::text AS version FROM collab.project_memberships WHERE project_id=$1 AND user_id=$2", [project, users[3]])).rows[0].version;
  const changed = await changeProjectMember(users[0], project, users[3], { role: "maintainer", active: false, expectedVersion: version });
  await changeProjectMember(users[0], project, users[3], { role: "maintainer", active: true, expectedVersion: changed.version });
  assert.equal(await store.resolveRecovery(result.actionId, "stop_confirmed", "a".repeat(64)), "revoked");
  assert.equal((await runDetail(users[0], claim.run.id)).run.status, "reconciling");
  await assert.rejects(runDetail(users[4], claim.run.id), /不存在/);
  await resolveProtocolFixture(claim);
});

test("missing receipts do not unlock a quarantined workspace or allow archival", async () => {
  const claim = await claimed(); await quarantine(claim); await request(claim);
  await processRecoveries(store, root);
  const detail = await runDetail(users[0], claim.run.id);
  assert.equal(detail.actions[0].result_code, "receipt_missing"); assert.equal(detail.workspace.status, "quarantined");
  await assert.rejects(request(claim, "archive"), /workspace_not_stopped/);
  await resolveProtocolFixture(claim);
});

test("a real Pi timeout recovers only after exit, preserves changes/unknown commands, and archives without deletion", { timeout: 30_000 }, async () => {
  const claim = await claimed();
  const outcome = await executeClaim(store, executor, claim, { dataRoot: root, backend: new NativeRuntimeBackend(), driver: async agent => {
    await agent.peer.command("bash", { command: 'node -e \'require("fs").appendFileSync("once.txt","once\\n")\'' });
    await agent.peer.command("bash", { command: "sleep 60" }, 50); return {};
  } });
  assert.equal(outcome, "reconciling");
  await request(claim); await processRecoveries(store, root);
  const detail = await runDetail(users[0], claim.run.id);
  assert.equal(detail.run.status, "cancelled"); assert.equal(detail.workspace.status, "stopped");
  assert.equal(detail.actions[0].result_code, "stop_confirmed"); assert.equal(detail.commands[0].status, "unknown");
  const once = path.join(root, "workspaces", claim.workspace.id, "checkout/once.txt"); assert.equal(await readFile(once, "utf8"), "once\n");
  const { input, result } = await request(claim, "archive");
  assert.equal(result.status, "resolved"); assert.equal((await manageRun(users[0], claim.run.id, input)).replayed, true);
  const archived = await runDetail(users[0], claim.run.id);
  assert.equal(archived.workspace.status, "archived"); assert.ok(new Date(archived.workspace.retain_until).getTime() > Date.now() + 6 * 86400_000);
  assert.equal(await readFile(once, "utf8"), "once\n"); assert.ok((await stat(path.join(root, "runtime-receipts", `${claim.workspace.id}.json`))).mode & 0o600);
  const version = (await admin.query("SELECT version FROM collab.tasks WHERE id=$1", [claim.run.task_id])).rows[0].version;
  const next = await startRun(users[1], claim.run.task_id, { repositoryId: imported.id, baseSha: imported.baseSha, prompt: "Explicit new run", expectedVersion: version, idempotencyKey: randomUUID() });
  const fresh = await store.claim(executor, "native"); assert.ok(fresh); assert.equal(fresh.run.id, next.runId); assert.notEqual(fresh.workspace.id, claim.workspace.id);
  assert.equal(await executeClaim(store, executor, fresh, { dataRoot: root, backend: new NativeRuntimeBackend(), driver: async (_agent, _claim, workspace) => {
    await assert.rejects(readFile(path.join(workspace.checkout, "once.txt")), /ENOENT/); return { kind: "fresh-workspace-test" };
  } }), "completed");
  assert.equal(await readFile(once, "utf8"), "once\n");
});

test("executor SIGKILL and expired lease cannot release a live writer; recovery never signals a persisted PID", { timeout: 35_000 }, async () => {
  const claim = await claimed();
  const child = spawn(process.execPath, ["--import", "tsx", "tests/collab/fixtures/crash-executor.ts"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  let pid: number | undefined;
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  try {
    const ready = new Promise<{ ready: boolean; pid: number }>((resolve, reject) => { child.once("message", value => resolve(value as { ready: boolean; pid: number })); child.once("exit", () => reject(new Error("Supervisor exited before fixture was ready"))); });
    child.send({ connection: executorConnectionString(config, databaseName), executor, claim, root });
    ({ pid } = await ready);
    await admin.query("UPDATE collab.workspaces SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [claim.workspace.id]);
    await store.reconcileExpired(); await request(claim); await processRecoveries(store, root);
    assert.equal((await runDetail(users[0], claim.run.id)).actions[0].result_code, "writer_present");
    assert.equal(child.exitCode, null); process.kill(pid, 0); // Observation did not kill the real writer.
    child.kill("SIGKILL"); await exited;
    // This fixture owns the process it launched. Product recovery never performs this signal.
    try { process.kill(-pid, "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    const identity = { runId: claim.run.id, executorId: executor, epoch: claim.run.epoch };
    let evidence = await inspectNativeExit(root, claim.workspace.id, identity);
    const deadline = Date.now() + 5000;
    while (!evidence.safe && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 50)); evidence = await inspectNativeExit(root, claim.workspace.id, identity); }
    assert.equal(evidence.code, "group_absent");
    const replacement = new ExecutionStore(executorConnectionString(config, databaseName));
    try { await request(claim); await processRecoveries(replacement, root); } finally { await replacement.close(); }
    const detail = await runDetail(users[0], claim.run.id); assert.equal(detail.workspace.status, "stopped"); assert.equal(detail.commands[0].status, "unknown");
    assert.equal(await readFile(path.join(root, "workspaces", claim.workspace.id, "checkout/once.txt"), "utf8"), "once\n");
    // Simulate PID reuse with a receipt now naming this unrelated test process.
    // It must remain blocked; recovery must not send it a termination signal.
    const receipt = JSON.parse(await readFile(path.join(root, "runtime-receipts", `${claim.workspace.id}.json`), "utf8"));
    const reusedWorkspace = randomUUID();
    await writeFile(path.join(root, "runtime-receipts", `${reusedWorkspace}.json`), JSON.stringify({ ...receipt, workspaceId: reusedWorkspace, state: "started", pid: process.pid }));
    assert.equal((await inspectNativeExit(root, reusedWorkspace, receipt.identity)).code, "writer_present");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    if (pid) try { process.kill(-pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
});

test("receipt validation fails closed for launch gaps, wrong identity, changed boot and malformed data", async () => {
  const workspaceId = randomUUID(), identity = { runId: randomUUID(), executorId: randomUUID(), epoch: "1" };
  const file = path.join(root, "runtime-receipts", `${workspaceId}.json`);
  const receipt = { version: 1, workspaceId, identity, bootId: "different-boot-identity", state: "launching", pid: null as number | null, updatedAt: new Date().toISOString() };
  await writeFile(file, JSON.stringify(receipt));
  assert.equal((await inspectNativeExit(root, workspaceId, identity)).code, "launch_uncertain");
  assert.equal((await inspectNativeExit(root, workspaceId, { ...identity, epoch: "2" })).code, "receipt_invalid");
  await writeFile(file, JSON.stringify({ ...receipt, state: "started", pid: process.pid }));
  assert.equal((await inspectNativeExit(root, workspaceId, identity)).code, "boot_changed");
  await writeFile(file, "{broken"); assert.equal((await inspectNativeExit(root, workspaceId, identity)).code, "receipt_invalid");
});

test("an actual control-plane network cut stops Pi and preserves recovery across a new DB connection", { timeout: 30_000 }, async () => {
  const claim = await claimed(), sockets = new Set<Socket>(); let online = true;
  const proxy = createServer(client => {
    if (!online) { client.destroy(); return; }
    const upstream = createConnection({ host: "127.0.0.1", port: config.databasePort });
    for (const socket of [client, upstream]) { sockets.add(socket); socket.on("error", () => { client.destroy(); upstream.destroy(); }); socket.on("close", () => sockets.delete(socket)); }
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const connection = new URL(executorConnectionString(config, databaseName)); connection.port = String((proxy.address() as { port: number }).port);
  const disconnected = new ExecutionStore(connection.toString());
  let ready!: () => void; const running = new Promise<void>(resolve => { ready = resolve; });
  let execution: Promise<string> | undefined;
  try {
    execution = executeClaim(disconnected, executor, claim, { dataRoot: root, backend: new NativeRuntimeBackend(), heartbeatMs: 100, driver: async agent => {
      await agent.peer.command("bash", { command: 'node -e \'require("fs").appendFileSync("once.txt","once\\n")\'' });
      ready(); await agent.peer.command("bash", { command: "sleep 60" }); return {};
    } });
    await Promise.race([running, execution.then(() => { throw new Error("Run ended before the network cut"); })]);
    online = false; for (const socket of sockets) socket.destroy();
    assert.equal(await execution, "reconciling");
    const evidence = await inspectNativeExit(root, claim.workspace.id, { runId: claim.run.id, executorId: executor, epoch: claim.run.epoch });
    assert.equal(evidence.code, "stop_confirmed");
    online = true;
    await admin.query("UPDATE collab.workspaces SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [claim.workspace.id]);
    await disconnected.reconcileExpired(); await request(claim); await processRecoveries(disconnected, root);
    const detail = await runDetail(users[0], claim.run.id); assert.equal(detail.workspace.status, "stopped"); assert.equal(detail.commands[0].status, "unknown");
    assert.equal(await readFile(path.join(root, "workspaces", claim.workspace.id, "checkout/once.txt"), "utf8"), "once\n");
  } finally {
    online = false; for (const socket of sockets) socket.destroy();
    await execution?.catch(() => {}); await disconnected.close();
    await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()));
  }
});

async function snapshotFixture() {
  const claim = await claimed();
  assert.equal(await executeClaim(store, executor, claim, { dataRoot: root, backend: new NativeRuntimeBackend(), driver: async agent => {
    await agent.peer.command("bash", { command: 'printf "staged change\\n" > base.txt; git add base.txt; printf "working change\\n" > base.txt; printf "untracked change\\n" > new.txt' }); return { kind: "snapshot-rpc-diagnostic" };
  } }), "completed");
  const detail = await runDetail(users[0], claim.run.id);
  const input = { idempotencyKey: randomUUID(), expectedRevision: detail.run.revision, note: "Preserve staged work and check the remaining acceptance criteria." };
  return { claim, input };
}

test("durable snapshot jobs enforce scope, revisions and stopped writers; duplicate requests and results are idempotent", async () => {
  const { claim, input } = await snapshotFixture();
  for (const user of [users[2], users[4]]) await assert.rejects(requestSnapshot(user, claim.run.id, input), /forbidden|not_found/);
  await assert.rejects(requestSnapshot(users[1], claim.run.id, { ...input, expectedRevision: "1" }), /stale_revision/);
  const results = await Promise.all(Array.from({ length: 20 }, () => requestSnapshot(users[1], claim.run.id, input)));
  assert.equal(new Set(results.map(result => result.snapshotId)).size, 1); assert.equal(results.filter(r => !r.replayed).length, 1);
  await assert.rejects(requestSnapshot(users[1], claim.run.id, { ...input, note: "A different request" }), /idempotency_conflict/);
  await assert.rejects(database().query("SELECT collab_worker.pending_snapshots()"), /permission/);
  await assert.rejects(database().query("UPDATE collab.snapshots SET status='ready'"), /permission/);
  await processSnapshots(store, root);
  assert.equal((await requestSnapshot(users[1], claim.run.id, input)).status, "ready");
  const snapshot = (await listSnapshots(users[2], claim.run.task_id)).snapshots[0]; assert.equal(snapshot.status, "ready");
  const { manifest, manifestHash } = await snapshotDetail(users[2], snapshot.id); assert.equal(manifest.runId, claim.run.id); assert.equal(manifest.note, input.note);
  assert.equal(await store.completeSnapshot(snapshot.id, null, null, "snapshot_failed"), "ready");
  assert.equal((await snapshotDetail(users[1], snapshot.id)).manifestHash, manifestHash);
  await assert.rejects(snapshotDetail(users[4], snapshot.id), /不存在/);
  await assert.rejects(listSnapshots(users[4], claim.run.task_id), /不存在/);
  const active = await claimed(); await assert.rejects(requestSnapshot(users[0], active.run.id, { ...input, idempotencyKey: randomUUID(), expectedRevision: "2" }), /workspace_not_stopped/);
  await store.finish(executor, active.run.id, active.run.epoch, "cancelled", {});
});

test("snapshot recovery hands exact code to a newly authorized owner using a fresh Pi workspace and independent Git history", async () => {
  const { claim, input } = await snapshotFixture(), accepted = await requestSnapshot(users[1], claim.run.id, input);
  await processSnapshots(store, root);
  const taskVersion = (await admin.query("SELECT version FROM collab.tasks WHERE id=$1", [claim.run.task_id])).rows[0].version;
  await reassignTask(users[0], claim.run.task_id, { ownerId: users[3], expectedVersion: taskVersion });
  const version = (await admin.query("SELECT version FROM collab.tasks WHERE id=$1", [claim.run.task_id])).rows[0].version;
  const restore = { repositoryId: imported.id, baseSha: imported.baseSha, prompt: "Continue from the shared snapshot", snapshotId: accepted.snapshotId, expectedVersion: version, idempotencyKey: randomUUID() };
  await assert.rejects(startRun(users[1], claim.run.task_id, restore), /forbidden/);
  const started = await startRun(users[3], claim.run.task_id, restore), replay = await startRun(users[3], claim.run.task_id, restore); assert.equal(started.runId, replay.runId);
  await assert.rejects(startRun(users[3], claim.run.task_id, { ...restore, snapshotId: undefined }), /idempotency_conflict/);
  assert.equal((await store.pool.query("SELECT collab_worker.claim($1,'native') AS result", [randomUUID()])).rows[0].result, null, "an old executor cannot claim a restoration it does not understand");
  const fresh = await store.claim(executor, "native"); assert.ok(fresh); assert.equal(fresh.run.id, started.runId); assert.notEqual(fresh.workspace.id, claim.workspace.id);
  assert.equal(await executeClaim(store, executor, fresh, { dataRoot: root, backend: new NativeRuntimeBackend(), driver: async (agent, _run, workspace) => {
    assert.equal(await readFile(path.join(workspace.checkout, "base.txt"), "utf8"), "working change\n");
    assert.equal(await readFile(path.join(workspace.checkout, "new.txt"), "utf8"), "untracked change\n");
    assert.equal((await exec("git", ["show", ":base.txt"], { cwd: workspace.checkout })).stdout, "staged change\n");
    await assert.rejects(readFile(path.join(workspace.agentDir, "models.json")), /ENOENT/);
    const result = await agent.peer.command("bash", { command: "printf 'new owner work\\n' >> new.txt" }); assert.equal((result.data as { exitCode: number }).exitCode, 0);
    return { kind: "restored-rpc-diagnostic" };
  } }), "completed");
  assert.equal(await readFile(path.join(root, "workspaces", claim.workspace.id, "checkout/new.txt"), "utf8"), "untracked change\n");
  const freshDetail = await runDetail(users[3], fresh.run.id);
  const nextSnapshot = await requestSnapshot(users[3], fresh.run.id, { ...input, expectedRevision: freshDetail.run.revision, idempotencyKey: randomUUID() });
  await processSnapshots(store, root);
  const nextManifest = (await snapshotDetail(users[3], nextSnapshot.snapshotId)).manifest;
  assert.deepEqual(nextManifest.parentSnapshot, { id: accepted.snapshotId, manifestHash: (await snapshotDetail(users[3], accepted.snapshotId)).manifestHash });
  await assert.rejects(admin.query("DELETE FROM collab.snapshots WHERE id=$1", [accepted.snapshotId]), /foreign key/);
  const other = await createTask(users[1], project, { title: "Unrelated task", description: "", acceptance: "" });
  await assert.rejects(startRun(users[1], other.id, { ...restore, expectedVersion: other.version, idempotencyKey: randomUUID() }), /snapshot_unavailable/);
  assert.equal((await admin.query("SELECT 1 FROM collab.runs WHERE task_id=$1", [other.id])).rowCount, 0);
  const originalManifest = (await snapshotDetail(users[3], accepted.snapshotId)).manifest;
  const blob = originalManifest.worktree.find(file => file.path === "base.txt")!.hash;
  await writeFile(path.join(root, "snapshots", accepted.snapshotId, "blobs", blob), "corrupted artifact");
  const currentVersion = (await admin.query("SELECT version FROM collab.tasks WHERE id=$1", [claim.run.task_id])).rows[0].version;
  await startRun(users[3], claim.run.task_id, { ...restore, expectedVersion: currentVersion, idempotencyKey: randomUUID() });
  const damaged = await store.claim(executor, "native"); assert.ok(damaged); let launched = false;
  const backend = new NativeRuntimeBackend(), originalStart = backend.start.bind(backend);
  backend.start = (...args) => { launched = true; return originalStart(...args); };
  assert.equal(await executeClaim(store, executor, damaged, { dataRoot: root, backend, driver: async () => ({}) }), "failed");
  assert.equal(launched, false);
});

test("revoked snapshot jobs never publish and a missing exit receipt cannot be promoted to a ready artifact", async () => {
  const { claim, input } = await snapshotFixture(), accepted = await requestSnapshot(users[3], claim.run.id, input);
  const version = (await admin.query("SELECT authorization_version::text AS version FROM collab.project_memberships WHERE project_id=$1 AND user_id=$2", [project, users[3]])).rows[0].version;
  const changed = await changeProjectMember(users[0], project, users[3], { role: "reviewer", active: true, expectedVersion: version });
  await processSnapshots(store, root); assert.equal((await listSnapshots(users[0], claim.run.task_id)).snapshots[0].status, "revoked");
  await assert.rejects(snapshotDetail(users[0], accepted.snapshotId), /不存在/);
  await changeProjectMember(users[0], project, users[3], { role: "maintainer", active: true, expectedVersion: changed.version });
  const absent = await claimed(); await store.finish(executor, absent.run.id, absent.run.epoch, "cancelled", {});
  const detail = await runDetail(users[0], absent.run.id); await requestSnapshot(users[0], absent.run.id, { ...input, expectedRevision: detail.run.revision, idempotencyKey: randomUUID() });
  await processSnapshots(store, root);
  assert.equal((await listSnapshots(users[0], absent.run.task_id)).snapshots[0].error_code, "snapshot_exit_unconfirmed");
});

test("environment handoff foundation: pinned npm recipe rebuilds dependencies in a fresh owner workspace and checks runtime fingerprints",async()=>{
 const {publishEnvironmentRecipe,environmentHandoff}=await import("../../lib/collab/environments");const {writeEnvironmentFixture}=await import("./fixtures/environment");
 const p=(await createProject(users[0],{organizationId:organization,name:"Environment handoff",description:""})).id;
 for(const user of [users[1],users[3]])await admin.query("INSERT INTO collab.project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,'developer')",[organization,p,user]);
 const dir=path.join(root,"environment-source");await mkdir(dir);await writeEnvironmentFixture(dir);
 for(const args of [["init"],["config","user.name","Environment fixture"],["config","user.email","environment@test.invalid"],["add","."],["commit","-m","Dependency fixture"]])await exec("git",args,{cwd:dir});
 const repo=await importLocalRepository(admin,root,{projectId:p,actorId:users[0],name:"Environment source",source:dir});
 await assert.rejects(publishEnvironmentRecipe(users[1],p,{install:"npm-ci",expectedVersion:0,reason:"Lock dependencies for environment handoff"}),/forbidden/);
 await publishEnvironmentRecipe(users[0],p,{install:"npm-ci",expectedVersion:0,reason:"Lock dependencies for environment handoff"});
 const task=await createTask(users[1],p,{title:"Environment handoff",description:"",acceptance:"Rebuild exactly the selected recipe"});
 await startRun(users[1],task.id,{repositoryId:repo.id,baseSha:repo.baseSha,expectedVersion:task.version,prompt:"Environment diagnostic only",idempotencyKey:randomUUID()});
 const a=await store.claim(executor,"native");assert.ok(a);
 const driver=async(agent:import("../../lib/collab/runtime/backends").AgentProcess)=>{const r=await agent.peer.command("bash",{command:"node -e \"require('node:assert/strict').equal(require('collab-fixture-helper'),42);require('node:assert/strict').equal(require('fs').existsSync('must-not-install-script'),false)\""});assert.equal((r.data as {exitCode:number}).exitCode,0);return {kind:"environment-fixture",modelInference:false};};
 assert.equal(await executeClaim(store,executor,a,{dataRoot:root,backend:new NativeRuntimeBackend(),driver}),"completed",JSON.stringify((await runDetail(users[1],a.run.id)).run.summary));
 const env=await environmentHandoff(users[1],a.run.id);assert.equal(env.environment.recipe.install,"npm-ci");assert.equal(env.environment.status,"ready");assert.match(env.environment.evidence.runtime.nodeHash,/^[a-f0-9]{64}$/);
 const detail=(await runDetail(users[1],a.run.id)).run,snapshot=await requestSnapshot(users[1],a.run.id,{idempotencyKey:randomUUID(),expectedRevision:detail.revision,note:"Rebuild npm dependencies before continuing"});await processSnapshots(store,root);
 await publishEnvironmentRecipe(users[0],p,{install:"none",expectedVersion:1,reason:"Change future runs without rewriting the handoff"});
 await reassignTask(users[0],task.id,{ownerId:users[3],expectedVersion:(await admin.query("SELECT version FROM collab.tasks WHERE id=$1",[task.id])).rows[0].version});
 const input={repositoryId:repo.id,baseSha:repo.baseSha,snapshotId:snapshot.snapshotId,expectedVersion:(await admin.query("SELECT version FROM collab.tasks WHERE id=$1",[task.id])).rows[0].version,prompt:"Rebuild captured environment",idempotencyKey:randomUUID()};
 await startRun(users[3],task.id,input);const b=await store.claim(executor,"native");assert.ok(b);assert.notEqual(b.workspace.id,a.workspace.id);
 assert.equal(await executeClaim(store,executor,b,{dataRoot:root,backend:new NativeRuntimeBackend(),driver}),"completed");
 const next=await environmentHandoff(users[3],b.run.id);assert.equal(next.environment.recipe.install,"npm-ci");assert.deepEqual(next.environment.evidence.dependencies,env.environment.evidence.dependencies);
 await startRun(users[3],task.id,{...input,expectedVersion:(await admin.query("SELECT version FROM collab.tasks WHERE id=$1",[task.id])).rows[0].version,idempotencyKey:randomUUID()});const c=await store.claim(executor,"native");assert.ok(c);await admin.query("UPDATE collab.run_environments SET recipe=jsonb_set(recipe,'{requiredRuntime,nodeHash}',to_jsonb($2::text)) WHERE run_id=$1",[c.run.id,"0".repeat(64)]);
 let modelStarted=false;assert.equal(await executeClaim(store,executor,c,{dataRoot:root,backend:new NativeRuntimeBackend(),driver:async()=>{modelStarted=true;return {};}}),"failed");assert.equal(modelStarted,false);assert.equal((await environmentHandoff(users[3],c.run.id)).environment.evidence.error,"environment_runtime_mismatch");
});
