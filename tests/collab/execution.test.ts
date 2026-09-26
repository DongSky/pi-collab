import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { localConfig, applicationEnvironment, connectionString, executorConnectionString } from "../../scripts/local-config";
import { startNativeDatabase } from "../../scripts/native-database";
import { migrate } from "../../scripts/migrate";
import { provisioningAuth } from "../../lib/collab/auth";
import { asUser, database } from "../../lib/collab/database";
import { createProject } from "../../lib/collab/projects";
import { createTask } from "../../lib/collab/tasks";
import { startRun, stopRun, runDetail, runFeed } from "../../lib/collab/runs";
import { changeMember } from "../../lib/collab/onboarding";
import { ExecutionStore, type ClaimedRun } from "../../lib/collab/execution-store";
import { executeClaim, type RunDriver } from "../../lib/collab/executor";
import { importLocalRepository } from "../../lib/collab/repository-import";
import { NativeRuntimeBackend } from "../../lib/collab/runtime/backends";
import { publicRpcEvent } from "../../lib/collab/runtime/public-events";

const config = await localConfig(), databaseName = `pi_collab_test_${randomBytes(6).toString("hex")}`;
const native = await startNativeDatabase(config);
Object.assign(process.env, applicationEnvironment(config), { DATABASE_URL: connectionString(config, false, databaseName) });
const admin = new Pool({ connectionString: connectionString(config, true, databaseName) });
const store = new ExecutionStore(executorConnectionString(config, databaseName));
const executor = randomUUID(), otherExecutor = randomUUID(), organization = randomUUID();
const users: string[] = [];
let project: string, repository: string;
const baseSha = "a".repeat(40);
const root = await mkdtemp(path.join(tmpdir(), "pi-collab-executor-"));
const source = path.join(root, "source"), exec = promisify(execFile);
let imported: { id: string; baseSha: string };
const input = (version = 1) => ({ repositoryId: repository, baseSha, prompt: "Implement the assigned task", expectedVersion: version, idempotencyKey: randomUUID() });
async function queued(owner = users[1]) {
  const task = await createTask(owner, project, { title: "Queue acceptance", description: "", acceptance: "" });
  return { task, accepted: await startRun(owner, task.id, input(task.version)) };
}
async function claim(): Promise<ClaimedRun> { const result = await store.claim(executor, "native"); assert.ok(result); return result; }
async function finish(run: ClaimedRun) {
  if ((await store.inspect(executor, run.run.id, run.run.epoch))?.status === "starting") await store.running(executor, run.run.id, run.run.epoch);
  await store.finish(executor, run.run.id, run.run.epoch, "completed", { exitCode: 0, source: "protocol-test" });
}

before(async () => {
  await migrate(config, databaseName);
  const provision = provisioningAuth(admin);
  for (let i = 0; i < 8; i++) {
    const result = await provision.api.signUpEmail({ body: { name: `Queue user ${i}`, email: `queue${i}@test.invalid`, password: randomBytes(20).toString("hex") } });
    users.push(result.user.id);
  }
  await admin.query("INSERT INTO collab.organizations(id,name,created_by) VALUES($1,'Queue test',$2)", [organization, users[0]]);
  for (let i = 0; i < 7; i++) await admin.query("INSERT INTO collab.memberships(organization_id,user_id,role) VALUES($1,$2,$3)", [organization, users[i], i === 0 ? "owner" : "member"]);
  await admin.query('UPDATE public."user" SET "twoFactorEnabled"=true WHERE id=$1', [users[0]]);
  project = (await createProject(users[0], { organizationId: organization, name: "Queue project", description: "" })).id;
  for (let i = 1; i < 7; i++) await admin.query("INSERT INTO collab.project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,$4)", [organization, project, users[i], i === 6 ? "reviewer" : "developer"]);
  repository = randomUUID();
  await admin.query("INSERT INTO collab.repositories(id,organization_id,project_id,name,provider,base_sha,default_branch) VALUES($1,$2,$3,'Fixture','local',$4,'main')", [repository, organization, project, baseSha]);
  await mkdir(source);
  for (const args of [["init"], ["config", "user.name", "Executor acceptance"], ["config", "user.email", "executor@test.invalid"]]) await exec("git", args, { cwd: source });
  await writeFile(path.join(source, "shared.txt"), "original\n");
  await exec("git", ["add", "shared.txt"], { cwd: source }); await exec("git", ["commit", "-m", "Initial fixture"], { cwd: source });
  imported = await importLocalRepository(admin, root, { projectId: project, actorId: users[0], name: "Local fixture", source });
});
after(async () => {
  await store.close(); await database().end(); globalThis.__piCollabPool = undefined; await admin.end();
  const cleanup = new Pool({ connectionString: connectionString(config, true, "postgres") });
  await cleanup.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`); await cleanup.end(); await native.stop();
  await rm(root, { recursive: true, force: true });
});

test("executor is a separate restricted role; browser role cannot dispatch and neither can bypass state transitions", async () => {
  const role = (await store.pool.query("SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user")).rows[0];
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false });
  await assert.rejects(store.pool.query('SELECT * FROM public."user"'), /permission/);
  await assert.rejects(store.pool.query("SELECT * FROM collab.runs"), /permission/);
  await assert.rejects(database().query("SELECT collab_worker.claim($1,'native')", [executor]), /permission/);
  await assert.rejects(database().query("UPDATE collab.runs SET status='completed'"), /permission/);
});

test("100 identical concurrent starts durably accept one run, workspace and command; changed payload cannot reuse key", async () => {
  const task = await createTask(users[1], project, { title: "Duplicate start", description: "", acceptance: "" }), request = input(task.version);
  const results = await Promise.all(Array.from({ length: 100 }, () => startRun(users[1], task.id, request)));
  assert.equal(new Set(results.map(result => result.runId)).size, 1);
  assert.equal(new Set(results.map(result => result.commandId)).size, 1);
  assert.equal(results.filter(result => !result.replayed).length, 1);
  for (const table of ["runs", "workspaces"]) assert.equal((await admin.query(`SELECT * FROM collab.${table} WHERE task_id=$1`, [task.id])).rowCount, 1);
  await assert.rejects(startRun(users[1], task.id, { ...request, prompt: "Different instruction" }), /idempotency_conflict/);
  await assert.rejects(startRun(users[1], task.id, input(task.version)), /stale_revision/);
  await assert.rejects(startRun(users[1], task.id, input(task.version + 1)), /task_busy/);
  const replay = await startRun(users[1], task.id, request); assert.equal(replay.runId, results[0].runId);
  await stopRun(users[1], replay.runId, { idempotencyKey: randomUUID() });
});

test("run admission rejects observers, another developer's task, inaccessible IDs and unregistered bases", async () => {
  const task = await createTask(users[1], project, { title: "Authorized task", description: "", acceptance: "" });
  await assert.rejects(startRun(users[6], task.id, input()), /forbidden/);
  await assert.rejects(startRun(users[2], task.id, input()), /forbidden/);
  await assert.rejects(startRun(users[7], task.id, input()), /not_found/);
  await assert.rejects(startRun(users[1], task.id, { ...input(), baseSha: "b".repeat(40) }), /repository_revision_unavailable/);
  await assert.rejects(startRun(users[1], task.id, { ...input(), repositoryId: randomUUID() }), /repository_revision_unavailable/);
  assert.equal((await admin.query("SELECT * FROM collab.workspaces WHERE task_id=$1", [task.id])).rowCount, 0);
});

test("competing executors claim a run once and stale/wrong ownership cannot advance it", async () => {
  const { accepted } = await queued();
  const results = await Promise.all([store.claim(executor, "native"), store.claim(otherExecutor, "native")]);
  assert.equal(results.filter(Boolean).length, 1);
  const winner = results[0] ? executor : otherExecutor, loser = results[0] ? otherExecutor : executor;
  const run = results.find(Boolean)!; assert.equal(run.run.id, accepted.runId);
  await assert.rejects(store.running(loser, run.run.id, run.run.epoch), /stale_lease/);
  await assert.rejects(store.running(winner, run.run.id, "0"), /stale_lease/);
  await store.running(winner, run.run.id, run.run.epoch);
  const batch = randomUUID(), seq = await store.output(winner, run.run.id, run.run.epoch, batch, [{ type: "text", text: "persisted" }]);
  assert.equal(await store.output(winner, run.run.id, run.run.epoch, batch, [{ type: "text", text: "persisted" }]), seq);
  await assert.rejects(store.output(winner, run.run.id, run.run.epoch, batch, [{ type: "text", text: "changed" }]), /idempotency_conflict/);
  await store.finish(winner, run.run.id, run.run.epoch, "completed", { verifiedBy: "test" });
  const detail = await runDetail(users[1], run.run.id);
  assert.equal(detail.run.status, "completed"); assert.equal(detail.commands[0].status, "succeeded");
  await assert.rejects(store.output(winner, run.run.id, run.run.epoch, randomUUID(), []), /stale_lease/);
});

test("admission quotas are atomic across executors, with capacity shared fairly among members", async () => {
  const requests = [];
  for (let i = 0; i < 9; i++) requests.push(await queued(users[1 + Math.floor(i / 2)]));
  const attempts = await Promise.all(Array.from({ length: 12 }, () => store.claim(executor, "native")));
  const active = attempts.filter(Boolean) as ClaimedRun[];
  assert.equal(active.length, 8);
  for (const user of users) assert.ok(active.filter(run => run.run.requested_by === user).length <= 2);
  assert.equal(new Set(active.map(run => run.run.requested_by)).size, 5);
  await finish(active[0]);
  const next = await claim(); assert.ok(requests.some(request => request.accepted.runId === next.run.id));
  await Promise.all([...active.slice(1), next].map(finish));
});

test("stop requests are idempotent; running work must confirm cancellation before its workspace is released", async () => {
  const { accepted } = await queued(), run = await claim();
  await store.running(executor, run.run.id, run.run.epoch);
  const key = { idempotencyKey: randomUUID() };
  const stopped = await stopRun(users[1], accepted.runId, key), replay = await stopRun(users[1], accepted.runId, key);
  assert.equal(stopped.commandId, replay.commandId);
  assert.equal((await store.heartbeat(executor, run.run.id, run.run.epoch)).canExecute, false);
  await assert.rejects(store.finish(executor, run.run.id, run.run.epoch, "completed", {}), /run_not_executable/);
  await assert.rejects(store.output(executor, run.run.id, run.run.epoch, randomUUID(), []), /run_not_executable/);
  await store.finish(executor, run.run.id, run.run.epoch, "cancelled", { processExited: true });
  const detail = await runDetail(users[1], run.run.id);
  assert.equal(detail.workspace.status, "stopped");
  assert.equal(detail.commands.find(command => command.kind === "stop").status, "succeeded");
});

test("membership changes cancel queued runs and stop active ones even when the browser stays connected", async () => {
  const first = await queued(users[2]), second = await queued(users[2]), active = await claim();
  await store.running(executor, active.run.id, active.run.epoch);
  await changeMember(users[0], organization, users[2], { role: "member", active: false });
  assert.equal((await runDetail(users[0], first.accepted.runId)).run.status, "stopping");
  assert.equal((await runDetail(users[0], second.accepted.runId)).run.status, "cancelled");
  assert.equal((await store.heartbeat(executor, active.run.id, active.run.epoch)).canExecute, false);
  await assert.rejects(store.output(executor, active.run.id, active.run.epoch, randomUUID(), []), /run_not_executable/);
  await assert.rejects(runDetail(users[2], active.run.id), /不存在/);
  await store.finish(executor, active.run.id, active.run.epoch, "cancelled", { processExited: true });
  await changeMember(users[0], organization, users[2], { role: "member", active: true });
  assert.equal((await runDetail(users[2], active.run.id)).run.status, "cancelled");
});

test("per-project event cursors cannot skip a late-committing transaction; reconnect and snapshot recovery remain authorized", async () => {
  await queued(users[1]); await queued(users[2]); const a = await claim(), b = await claim();
  await store.running(executor, a.run.id, a.run.epoch); await store.running(executor, b.run.id, b.run.epoch);
  const head = (await admin.query("SELECT event_sequence FROM collab.projects WHERE id=$1", [project])).rows[0].event_sequence;
  const transaction = await admin.connect();
  try {
    await transaction.query("BEGIN");
    const first = (await transaction.query("SELECT collab_worker.emit($1,'test.held','{}') AS sequence", [a.run.id])).rows[0].sequence;
    const second = store.output(executor, b.run.id, b.run.epoch, randomUUID(), [{ type: "persisted" }]);
    assert.equal((await runFeed(users[1], project, head)).events.length, 0);
    await transaction.query("COMMIT");
    const secondSequence = await second;
    assert.equal(BigInt(secondSequence), BigInt(first) + BigInt(1));
    const feed = await runFeed(users[1], project, head);
    assert.deepEqual(feed.events.map(event => event.sequence), [first, secondSequence]);
    assert.equal(feed.cursor, secondSequence);
    assert.equal((await runFeed(users[1], project, feed.cursor)).events.length, 0);
    assert.equal((await runFeed(users[1], project, "999999")).reset, true);
    await assert.rejects(runFeed(users[7], project, "0"), /not found/);
    await assert.rejects(asUser(users[7], db => db.query("UPDATE collab.run_events SET payload='{}'")), /permission/);
  } finally { await transaction.query("ROLLBACK"); transaction.release(); }
  await finish(a); await finish(b);
});

test("two database-owned runs drive real Pi processes concurrently without cross-writing workspaces", { timeout: 30_000 }, async () => {
  for (const user of [users[1], users[2]]) {
    const task = await createTask(user, project, { title: "Native pipeline", description: "", acceptance: "" });
    await startRun(user, task.id, { ...input(task.version), repositoryId: imported.id, baseSha: imported.baseSha });
  }
  const runs = [await claim(), await claim()];
  const driver: RunDriver = async (agent, run) => {
    const result = await agent.peer.command("bash", { command: `node -e 'const fs=require("fs");const start=Date.now();setTimeout(()=>{fs.writeFileSync("shared.txt","${run.run.id}");process.stdout.write(JSON.stringify({start,end:Date.now()}));},600);'` });
    return { kind: "rpc-diagnostic", ...JSON.parse((result.data as { output: string }).output) };
  };
  const results = await Promise.all(runs.map(run => executeClaim(store, executor, run, { dataRoot: root, backend: new NativeRuntimeBackend(), driver, heartbeatMs: 100 })));
  assert.deepEqual(results, ["completed", "completed"]);
  const intervals: { start: number; end: number }[] = [];
  for (const run of runs) {
    const detail = await runDetail(users[0], run.run.id);
    assert.equal(detail.run.status, "completed"); intervals.push(detail.run.summary);
    assert.equal(await readFile(path.join(root, "workspaces", run.workspace.id, "checkout/shared.txt"), "utf8"), run.run.id);
  }
  assert.ok(Math.max(...intervals.map(interval => interval.start)) < Math.min(...intervals.map(interval => interval.end)));
  assert.equal(await readFile(path.join(source, "shared.txt"), "utf8"), "original\n");
});

test("numeric child exit codes persist failures before launch and after stopping a real Pi process", { timeout: 30_000 }, async () => {
  for (const beforeLaunch of [true, false]) {
    const task = await createTask(users[1], project, { title: "Numeric process failure", description: "", acceptance: "" });
    await startRun(users[1], task.id, { ...input(task.version), repositoryId: imported.id, baseSha: imported.baseSha });
    const run = await claim(); let pid: number | undefined;
    const fail = async (): Promise<never> => {
      await exec(process.execPath, ["-e", "process.stderr.write('child-exit-fixture'); process.exit(23)"]);
      throw new Error("Expected child process failure");
    };
    const outcome = await executeClaim(store, executor, run, {
      dataRoot: root,
      backend: beforeLaunch ? { isolation: "trusted-local-process", start: fail } : new NativeRuntimeBackend(),
      driver: async agent => { pid = agent.peer.pid; return fail(); },
    });
    assert.equal(outcome, "failed");
    const detail = await runDetail(users[1], run.run.id);
    assert.equal(detail.run.status, "failed");
    assert.equal(detail.workspace.status, "stopped");
    assert.equal(detail.run.summary.reason, "execution_failed");
    assert.match(detail.run.summary.error, /child-exit-fixture/);
    assert.doesNotMatch(detail.run.summary.error, /startsWith/);
    if (!beforeLaunch) {
      assert.ok(pid);
      assert.throws(() => process.kill(-pid!, 0), (failure: NodeJS.ErrnoException) => failure.code === "ESRCH");
    }
  }
});

test("a model error racing a user stop records cancellation and keeps the diagnostic", { timeout: 30_000 }, async () => {
  const task = await createTask(users[1], project, { title: "Gateway stop race", description: "", acceptance: "" });
  await startRun(users[1], task.id, { ...input(task.version), repositoryId: imported.id, baseSha: imported.baseSha });
  const run = await claim(); let pid: number | undefined;
  const error = 'pi-collab API error (403): {"code":"model_access_denied"}';
  const outcome = await executeClaim(store, executor, run, {
    dataRoot: root, backend: new NativeRuntimeBackend(), heartbeatMs: 60_000,
    driver: async agent => {
      pid = agent.peer.pid;
      await stopRun(users[1], run.run.id, { idempotencyKey: randomUUID() });
      // The revoked gateway response reaches Pi before its heartbeat timer.
      throw new Error(error);
    },
  });
  assert.equal(outcome, "cancelled");
  const detail = await runDetail(users[1], run.run.id);
  assert.equal(detail.run.stop_reason, "user_requested");
  assert.equal(detail.run.summary.reason, "authorization_or_stop");
  assert.equal(detail.run.summary.error, error);
  assert.equal(detail.workspace.status, "stopped");
  assert.ok(pid);
  assert.throws(() => process.kill(-pid!, 0), (failure: NodeJS.ErrnoException) => failure.code === "ESRCH");
});

test("revoking a member stops their real Pi process and ordinary shell descendant before acknowledging cancellation", { timeout: 30_000 }, async () => {
  const task = await createTask(users[2], project, { title: "Revoked writer", description: "", acceptance: "" });
  await startRun(users[2], task.id, { ...input(task.version), repositoryId: imported.id, baseSha: imported.baseSha });
  const run = await claim(); let pid: number | undefined;
  const driver: RunDriver = async agent => {
    pid = agent.peer.pid;
    await agent.peer.command("bash", { command: 'node -e \'const fs=require("fs");fs.writeFileSync("ready","1");setTimeout(()=>fs.writeFileSync("must-not-exist","1"),10000);\'' });
    return { kind: "rpc-diagnostic" };
  };
  const result = executeClaim(store, executor, run, { dataRoot: root, backend: new NativeRuntimeBackend(), driver, heartbeatMs: 50 });
  const ready = path.join(root, "workspaces", run.workspace.id, "checkout/ready");
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { await access(ready); break; } catch {}
    assert.ok(Date.now() < deadline, "writer must actually start before revocation");
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  await changeMember(users[0], organization, users[2], { role: "member", active: false });
  assert.equal(await result, "cancelled");
  assert.equal((await runDetail(users[0], run.run.id)).workspace.status, "stopped");
  assert.ok(pid);
  assert.throws(() => process.kill(-pid!, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
  await assert.rejects(access(path.join(root, "workspaces", run.workspace.id, "checkout/must-not-exist")));
  await changeMember(users[0], organization, users[2], { role: "member", active: true });
});

test("a lost terminal database response is reconciled without running the tool a second time", { timeout: 30_000 }, async () => {
  const task = await createTask(users[1], project, { title: "Terminal response loss", description: "", acceptance: "" });
  await startRun(users[1], task.id, { ...input(task.version), repositoryId: imported.id, baseSha: imported.baseSha });
  const run = await claim(), original = store.finish.bind(store);
  store.finish = async (...args) => { await original(...args); throw new Error("Simulated response loss after commit"); };
  try {
    const driver: RunDriver = async agent => { await agent.peer.command("bash", { command: 'node -e \'require("fs").appendFileSync("once.txt","once\\n")\'' }); return { kind: "rpc-diagnostic" }; };
    assert.equal(await executeClaim(store, executor, run, { dataRoot: root, backend: new NativeRuntimeBackend(), driver }), "completed");
    assert.equal(await readFile(path.join(root, "workspaces", run.workspace.id, "checkout/once.txt"), "utf8"), "once\n");
  } finally { store.finish = original; }
});

test("collaboration events exclude system/private thinking and bound visible content", () => {
  assert.equal(publicRpcEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "private" } }), null);
  assert.equal(publicRpcEvent({ type: "message_end", message: { role: "system", content: [{ type: "text", text: "hidden" }] } }), null);
  const event = publicRpcEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "private" }, ...Array.from({ length: 50 }, () => ({ type: "text", text: "a".repeat(100_000) }))] } });
  assert.equal(JSON.stringify(event).includes("private"), false);
  assert.ok(Buffer.byteLength(JSON.stringify(event)) < 64_000);
});

test("RPC timeout quarantines an actual workspace rather than retrying an uncertain tool", { timeout: 30_000 }, async () => {
  const task = await createTask(users[1], project, { title: "RPC timeout", description: "", acceptance: "" });
  await startRun(users[1], task.id, { ...input(task.version), repositoryId: imported.id, baseSha: imported.baseSha });
  const run = await claim();
  const driver: RunDriver = async agent => { await agent.peer.command("bash", { command: 'node -e \'setTimeout(()=>{},10000)\'' }, 100); return {}; };
  assert.equal(await executeClaim(store, executor, run, { dataRoot: root, backend: new NativeRuntimeBackend(), driver }), "reconciling");
  const detail = await runDetail(users[1], run.run.id);
  assert.equal(detail.workspace.status, "quarantined"); assert.equal(detail.commands[0].status, "unknown");
});

test("expired execution is quarantined, never retried automatically, and every old-epoch callback is rejected", async () => {
  const { task, accepted } = await queued(), run = await claim();
  await store.running(executor, run.run.id, run.run.epoch);
  await admin.query("UPDATE collab.workspaces SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [run.workspace.id]);
  await assert.rejects(store.heartbeat(executor, run.run.id, run.run.epoch), /stale_lease/);
  assert.equal(await store.reconcileExpired(), 1);
  assert.equal(await store.reconcileExpired(), 0);
  assert.equal(await store.claim(otherExecutor, "native"), null);
  const detail = await runDetail(users[1], accepted.runId);
  assert.equal(detail.run.status, "reconciling"); assert.equal(detail.workspace.status, "quarantined"); assert.equal(detail.commands[0].status, "unknown");
  for (const action of [() => store.running(executor, run.run.id, run.run.epoch), () => store.output(executor, run.run.id, run.run.epoch, randomUUID(), []), () => store.finish(executor, run.run.id, run.run.epoch, "completed", {})]) await assert.rejects(action(), /stale_lease/);
  const version = (await admin.query("SELECT version FROM collab.tasks WHERE id=$1", [task.id])).rows[0].version;
  await assert.rejects(startRun(users[1], task.id, input(version)), /task_busy/);
});
