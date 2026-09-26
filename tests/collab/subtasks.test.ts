import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
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
import { startRun, stopRun, runDetail } from "../../lib/collab/runs";
import { ExecutionStore, type ClaimedRun } from "../../lib/collab/execution-store";
import { executeClaim } from "../../lib/collab/executor";
import { runtimeBackend } from "../../lib/collab/runtime/backends";
import { importLocalRepository } from "../../lib/collab/repository-import";
import { requestSnapshot, processSnapshots, listSnapshots } from "../../lib/collab/snapshots";
import { createValidationProfile, requestValidation } from "../../lib/collab/validations";
import { executeValidation } from "../../lib/collab/validation-worker";
import { publishResult } from "../../lib/collab/task-results";
import { configureCapacity } from "../../lib/collab/capacity";
import { proposeSubtask, decideSubtask, subtaskContext, actOnSubtasks, configureSubtasks } from "../../lib/collab/subtasks";
import { coordinate } from "../../lib/collab/coordination-server";
import { editTask } from "../../lib/collab/task-lifecycle";

const config = await localConfig(), databaseName = `pi_collab_test_${randomBytes(6).toString("hex")}`, native = await startNativeDatabase(config);
Object.assign(process.env, applicationEnvironment(config), { DATABASE_URL: connectionString(config, false, databaseName) });
const admin = new Pool({ connectionString: connectionString(config, true, databaseName) }), store = new ExecutionStore(executorConnectionString(config, databaseName));
const root = await mkdtemp(path.join(tmpdir(), "pi-collab-subtasks-")), source = path.join(root, "source"), exec = promisify(execFile);
process.env.PI_COLLAB_DATA_DIR = root;
const runtime = process.env.PI_COLLAB_RUNTIME === "docker" ? "docker" : "native";
const organization = randomUUID(), executor = randomUUID(), users: string[] = [];
let project: string, repository: { id: string; baseSha: string }, profileId: string;
before(async () => {
  await migrate(config, databaseName); const provision = provisioningAuth(admin);
  for (let i = 0; i < 4; i++) users.push((await provision.api.signUpEmail({ body: { name: `Result user ${i}`, email: `result${i}@test.invalid`, password: randomBytes(20).toString("hex") } })).user.id);
  await admin.query("INSERT INTO collab.organizations(id,name,created_by) VALUES($1,'Result test',$2)", [organization, users[0]]);
  for (let i = 0; i < 3; i++) await admin.query("INSERT INTO collab.memberships(organization_id,user_id,role) VALUES($1,$2,$3)", [organization, users[i], i === 0 ? "owner" : "member"]);
  await admin.query('UPDATE public."user" SET "twoFactorEnabled"=true WHERE id=$1', [users[0]]);
  project = (await createProject(users[0], { organizationId: organization, name: "Immutable results", description: "" })).id;
  for (let i = 1; i < 3; i++) await admin.query("INSERT INTO collab.project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,$4)", [organization, project, users[i], i === 1 ? "developer" : "reviewer"]);
  await mkdir(source); for (const args of [["init"], ["config", "user.name", "Result acceptance"], ["config", "user.email", "result@test.invalid"]]) await exec("git", args, { cwd: source });
  await writeFile(path.join(source, "code.txt"), "baseline\n"); await exec("git", ["add", "."], { cwd: source }); await exec("git", ["commit", "-m", "Baseline"], { cwd: source });
  repository = await importLocalRepository(admin, root, { projectId: project, actorId: users[0], source, name: "Result source" });
  profileId = (await createValidationProfile(users[0], project, { repositoryId: repository.id, name: "Verify code and pinned input bytes", idempotencyKey: randomUUID(), config: { version: 1, steps: [{ tool: "node", args: ["check.cjs"], timeoutSeconds: 10 }] } })).profileId;
});
after(async () => {
  await store.close(); await database().end(); globalThis.__piCollabPool = undefined; await admin.end();
  const cleanup = new Pool({ connectionString: connectionString(config, true, "postgres") }); await cleanup.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`); await cleanup.end(); await native.stop(); await rm(root, { recursive: true, force: true });
});
const task = (title: string) => createTask(users[1], project, { title, description: "", acceptance: "Use exact dependency versions" });
const version = async (taskId: string) => (await admin.query("SELECT version FROM collab.tasks WHERE id=$1", [taskId])).rows[0].version as number;
async function submit(taskId: string) { return startRun(users[1], taskId, { repositoryId: repository.id, baseSha: repository.baseSha, prompt: "Result acceptance diagnostic", expectedVersion: await version(taskId), idempotencyKey: randomUUID() }); }
async function claimTask(taskId: string) { await submit(taskId); const claim = await store.claim(executor, runtime); assert.ok(claim); assert.equal(claim.run.task_id, taskId); return claim; }
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
async function finish(claim: ClaimedRun, value = "result") {
  const expected: Record<string, string> = {};
  assert.equal(await executeClaim(store, executor, claim, { dataRoot: root, backend: runtimeBackend(runtime), driver: async (agent, _claim, workspace) => {
    for (const pin of claim.dependencies ?? []) if (pin.resultId) expected[pin.taskId] = await readFile(path.join(workspace.root, "dependencies", pin.taskId, "code.txt"), "utf8");
    const check = `const fs=require('node:fs'),a=require('node:assert/strict');a.equal(fs.readFileSync('code.txt','utf8'),${JSON.stringify(value)});for(const [id,value] of Object.entries(${JSON.stringify(expected)}))a.equal(fs.readFileSync('../dependencies/'+id+'/code.txt','utf8'),value);`;
    await agent.peer.command("bash", { command: `node -e ${shellQuote(`const fs=require('node:fs');fs.writeFileSync('code.txt',${JSON.stringify(value)});fs.writeFileSync('check.cjs',${JSON.stringify(check)});`)}` });
    await agent.peer.command("bash", { command: "node check.cjs" });
    return { kind: "real-pi-dependency-diagnostic", modelInference: false };
  } }), "completed");
  const r = (await runDetail(users[1], claim.run.id)).run;
  const requested = await requestSnapshot(users[1], r.id, { expectedRevision: r.revision, idempotencyKey: randomUUID(), note: "Pinned result for downstream" });
  await processSnapshots(store, root);
  const snapshot = (await listSnapshots(users[1], claim.run.task_id)).snapshots.find(s => s.id === requested.snapshotId);
  assert.equal(snapshot.status, "ready", JSON.stringify(snapshot));
  const v = await requestValidation(users[1], requested.snapshotId, { profileId, idempotencyKey: randomUUID() });
  if (claim.dependencies?.length) assert.equal((await store.pool.query("SELECT collab_worker.claim_validation($1) AS result", [randomUUID()])).rows[0].result, null);
  const validation = await store.claimValidation(executor); assert.ok(validation); assert.equal(validation.id, v.validationId);
  assert.equal(await executeValidation(store, validation, root), "passed");
  return { taskId: claim.run.task_id, claim, snapshotId: requested.snapshotId as string, validationId: v.validationId as string };
}
async function publish(f: { taskId: string; validationId: string }, key = randomUUID()) {
  return publishResult(users[1], f.taskId, { validationId: f.validationId, expectedVersion: await version(f.taskId), idempotencyKey: key, note: "Immutable code for consumers; integration still required" });
}


const proposal = (title = "Independent child") => ({ title, description: "Work alongside parent", acceptance: "Publish a checked immutable result", prompt: "Edit only the child workspace", idempotencyKey: randomUUID() });
const decision = () => ({ decision: "accept" as const, expectedVersion: 1, acknowledge: true, reason: "Confirm isolated child execution and usage", idempotencyKey: randomUUID() });
const policy = (concurrentChildren = 1, depth = 3) => ({ concurrentChildren, depth, descendants: 16, reason: "Bound this tree while parent remains live", idempotencyKey: randomUUID() });
afterEach(async () => {
  for (const r of (await admin.query("SELECT id,epoch::text,status FROM collab.runs WHERE status IN ('queued','starting','running','waiting_input','stopping')")).rows) {
    if (r.status === "queued") await stopRun(users[0], r.id, { idempotencyKey: randomUUID() });
    else await store.finish(executor, r.id, r.epoch, "cancelled", {});
  }
});

test("parent and child run real Pi concurrently; fixed results return and become next-parent dependency without file collisions", { timeout: 90000 }, async () => {
  const parent = await task("Parent with controlled children"), claim = await claimTask(parent.id);
  await configureCapacity(users[0], project, { expectedVersion: 0, idempotencyKey: randomUUID(), reason: "Allow three runs to test the separate child quota", projectRuns: 8, memberRuns: 4, dailyTokens: 10000000, dailyUsd: null, prices: [] });
  await configureSubtasks(users[0], project, { ...policy(), expectedVersion: 0 });
  let release!: () => void, ready!: () => void, reject!: (e: unknown) => void, parentPath = "";
  const gate = new Promise<void>(r => { release = r; }), started = new Promise<void>((a,b) => { ready = a; reject = b; });
  const running = executeClaim(store, executor, claim, { dataRoot: root, backend: runtimeBackend(runtime), driver: async (agent, _c, workspace) => {
    parentPath = path.join(workspace.checkout, "code.txt");
    await agent.peer.command("bash", { command: "printf parent-live > code.txt" }); ready(); await gate;
    assert.equal(await readFile(parentPath, "utf8"), "parent-live"); return { modelInference: false };
  } }).then(r => { if (r !== "completed") reject(new Error(r)); return r; }, e => { reject(e); throw e; });
  try {
    await started;
    const request = proposal(), proposed = await coordinate(store, executor, claim.run.id, claim.run.epoch, "propose_subtask", request);
    assert.equal((await coordinate(store, executor, claim.run.id, claim.run.epoch, "propose_subtask", request)).id, proposed.id);
    assert.equal((await subtaskContext(users[1], parent.id)).proposals[0].sourceKind, "agent");
    const confirm = decision(), accepted = await decideSubtask(users[1], proposed.id, confirm);
    assert.equal((await decideSubtask(users[1], proposed.id, confirm)).runId, accepted.runId);
    const child = await store.claim(executor, runtime); assert.ok(child); assert.equal(child.run.id, accepted.runId);
    assert.notEqual(child.workspace.id, claim.workspace.id); assert.equal(child.workspace.base_sha, claim.workspace.base_sha);
    const second = await proposeSubtask(users[1], claim.run.id, proposal("Queued sibling"));
    const sibling = await decideSubtask(users[1], second.id, decision()); assert.equal(await store.claim(executor, runtime), null);
    assert.equal((await subtaskContext(users[1], parent.id)).children.find(c => c.taskId === sibling.taskId)!.run!.quotaAvailable, false);
    const checked = await finish(child, "child-result"), result = await publish(checked);
    assert.equal(await readFile(parentPath, "utf8"), "parent-live");
    const context = await coordinate(store, executor, claim.run.id, claim.run.epoch, "get_context", {});
    assert.equal(context.subtasks.children.find((c: { taskId: string }) => c.taskId === accepted.taskId).result.id, result.resultId);
    const adoption = { action: "adopt", childTaskId: accepted.taskId, resultId: result.resultId, expectedVersion: await version(parent.id), reason: "Use the returned immutable child result", idempotencyKey: randomUUID() };
    await assert.rejects(actOnSubtasks(users[1], parent.id, adoption), /task_busy/);
    const siblingClaim = await store.claim(executor, runtime); assert.ok(siblingClaim); assert.equal(siblingClaim.run.id, sibling.runId);
    await finish(siblingClaim, "sibling-result");
    release(); assert.equal(await running, "completed");
    await actOnSubtasks(users[1], parent.id, { ...adoption, expectedVersion: await version(parent.id) });
    const consumer = await claimTask(parent.id); assert.equal(consumer.dependencies?.[0].resultId, result.resultId);
    await finish(consumer, "parent-consumed-child");
    assert.equal((await subtaskContext(users[2], accepted.taskId)).parent?.taskId, parent.id);
  } finally { release(); await running; }
});

test("proposals survive normal run completion, reject changed goals and never authorize a different principal", { timeout: 60000 }, async () => {
  const parent = await task("Lifecycle parent"), c = await claimTask(parent.id);
  const p = await proposeSubtask(users[1], c.run.id, proposal());
  await finish(c); // Completion increments the general task version.
  for (const actor of [users[2], users[3]]) await assert.rejects(decideSubtask(actor, p.id, decision()), /forbidden|not_found/);
  await assert.rejects(decideSubtask(users[0], p.id, decision()), /subtask_principal_required/);
  const accepted = await decideSubtask(users[1], p.id, decision()); assert.ok(accepted.runId);
  await assert.rejects(asUser(users[1], db => db.query("DELETE FROM collab.subtasks")), /permission/);
  await assert.rejects(subtaskContext(users[3], parent.id), /not_found/);
  const stale = await proposeSubtask(users[1], c.run.id, proposal("Old goal"));
  await editTask(users[1], parent.id, { title: "Changed parent goal", description: "", acceptance: "Changed acceptance", status: "draft", expectedVersion: await version(parent.id), idempotencyKey: randomUUID(), reason: "Human changed the planned objective" });
  await assert.rejects(decideSubtask(users[1], stale.id, decision()), /subtask_source_unavailable/);
});

test("depth limit and recursive stop cover queued descendants and pending proposals", async () => {
  const t = await task("Tree root"), r = await submit(t.id);
  await configureSubtasks(users[0], project, { ...policy(1,1), expectedVersion: (await subtaskContext(users[0], t.id)).policy.version });
  const p = await proposeSubtask(users[1], r.runId, proposal()), child = await decideSubtask(users[1], p.id, decision());
  const nested = await proposeSubtask(users[1], child.runId, proposal("Too deep"));
  await assert.rejects(decideSubtask(users[1], nested.id, decision()), /subtask_limit/);
  const stop = { action: "stop", reason: "Stop all descendants but preserve the parent", idempotencyKey: randomUUID() };
  await actOnSubtasks(users[1], t.id, stop); await actOnSubtasks(users[1], t.id, stop);
  assert.equal((await runDetail(users[1], r.runId)).run.status, "queued");
  assert.equal((await runDetail(users[1], child.runId)).run.status, "cancelled");
  assert.equal((await subtaskContext(users[1], child.taskId)).proposals[0].status, "rejected");
});
