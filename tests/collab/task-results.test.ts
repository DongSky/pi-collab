import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { localConfig, applicationEnvironment, connectionString, executorConnectionString } from "../../scripts/local-config";
import { startNativeDatabase } from "../../scripts/native-database";
import { migrate } from "../../scripts/migrate";
import { provisioningAuth } from "../../lib/collab/auth";
import { asUser, database } from "../../lib/collab/database";
import { createProject } from "../../lib/collab/projects";
import { createTask, addDependency } from "../../lib/collab/tasks";
import { startRun, stopRun, runDetail } from "../../lib/collab/runs";
import { ExecutionStore, type ClaimedRun } from "../../lib/collab/execution-store";
import { executeClaim } from "../../lib/collab/executor";
import { NativeRuntimeBackend } from "../../lib/collab/runtime/backends";
import { importLocalRepository } from "../../lib/collab/repository-import";
import { requestSnapshot, processSnapshots, listSnapshots, snapshotDetail } from "../../lib/collab/snapshots";
import { createValidationProfile, requestValidation, validationDetail } from "../../lib/collab/validations";
import { executeValidation } from "../../lib/collab/validation-worker";
import { publishResult, withdrawResult, listTaskResults, runDependencies } from "../../lib/collab/task-results";
import { resultEvidence, resultEvidenceStatus } from "../../lib/collab/result-evidence";
import { discussionCommand } from "../../lib/collab/discussions";
import { reviewHash } from "../../lib/collab/runtime/review-git";
import { editTask } from "../../lib/collab/task-lifecycle";

const config = await localConfig(), databaseName = `pi_collab_test_${randomBytes(6).toString("hex")}`, native = await startNativeDatabase(config);
Object.assign(process.env, applicationEnvironment(config), { DATABASE_URL: connectionString(config, false, databaseName) });
const admin = new Pool({ connectionString: connectionString(config, true, databaseName) }), store = new ExecutionStore(executorConnectionString(config, databaseName));
const root = await mkdtemp(path.join(tmpdir(), "pi-collab-results-")), source = path.join(root, "source"), exec = promisify(execFile);
process.env.PI_COLLAB_DATA_DIR = root;
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
async function claimTask(taskId: string) { await submit(taskId); const claim = await store.claim(executor, "native"); assert.ok(claim); assert.equal(claim.run.task_id, taskId); return claim; }
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
async function finish(claim: ClaimedRun, value = "result") {
  const expected: Record<string, string> = {};
  const outcome = await executeClaim(store, executor, claim, { dataRoot: root, backend: new NativeRuntimeBackend(), driver: async (agent, _claim, workspace) => {
    for (const pin of claim.dependencies ?? []) if (pin.resultId) expected[pin.taskId] = await readFile(path.join(workspace.root, "dependencies", pin.taskId, "code.txt"), "utf8");
    const check = `const fs=require('node:fs'),a=require('node:assert/strict');a.equal(fs.readFileSync('code.txt','utf8'),${JSON.stringify(value)});for(const [id,value] of Object.entries(${JSON.stringify(expected)}))a.equal(fs.readFileSync('../dependencies/'+id+'/code.txt','utf8'),value);`;
    await agent.peer.command("bash", { command: `node -e ${shellQuote(`const fs=require('node:fs');fs.writeFileSync('code.txt',${JSON.stringify(value)});fs.writeFileSync('check.cjs',${JSON.stringify(check)});`)}` });
    await agent.peer.command("bash", { command: "node check.cjs" });
    return { kind: "real-pi-dependency-diagnostic", modelInference: false };
  } });
  assert.equal(outcome, "completed", outcome === "completed" ? undefined : JSON.stringify((await runDetail(users[1], claim.run.id)).run));
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

test("strict dependency waits for a published result even if upstream is done; publication needs no merge or task completion", { timeout: 30000 }, async () => {
  const up = await task("Strict producer"), down = await task("Strict consumer");
  await addDependency(users[1], down.id, { dependsOn: up.id, kind: "strict" });
  const waiting = await submit(down.id); assert.equal(await store.claim(executor, "native"), null);
  await admin.query("UPDATE collab.tasks SET status='done' WHERE id=$1", [up.id]); assert.equal(await store.claim(executor, "native"), null);
  await admin.query("UPDATE collab.tasks SET status='draft' WHERE id=$1", [up.id]);
  const producer = await finish(await claimTask(up.id), "strict-v1"), result = await publish(producer);
  assert.equal((await admin.query("SELECT status FROM collab.tasks WHERE id=$1", [up.id])).rows[0].status, "in_review");
  const consumer = await store.claim(executor, "native"); assert.ok(consumer); assert.equal(consumer.run.id, waiting.runId);
  assert.equal(consumer.dependencies?.[0].resultId, result.resultId);
  const consumed = await finish(consumer, "consumer"); const detail = await validationDetail(users[1], consumed.validationId);
  assert.equal(detail.validation.evidence.dependencies[0].resultId, result.resultId); await publish(consumed);
});

test("concurrent publication is immutable and idempotent; readers cannot publish, withdraw, or forge a current-result pointer", { timeout: 20000 }, async () => {
  const up = await task("Concurrent publisher"), f = await finish(await claimTask(up.id)), input = { validationId: f.validationId, expectedVersion: await version(up.id), idempotencyKey: randomUUID(), note: "Published exact validated code" };
  const results = await Promise.all(Array.from({ length: 20 }, () => publishResult(users[1], up.id, input)));
  assert.equal(new Set(results.map(r => r.resultId)).size, 1); assert.equal(results.filter(r => !r.replayed).length, 1);
  await assert.rejects(publishResult(users[1], up.id, { ...input, note: "Changed replay" }), /idempotency_conflict/);
  for (const actor of [users[2], users[3]]) await assert.rejects(publishResult(actor, up.id, input), /forbidden|not_found/);
  await assert.rejects(withdrawResult(users[2], results[0].resultId, { reason: "Observer cannot withdraw a published version" }), /forbidden/);
  await assert.rejects(asUser(users[1], db => db.query("UPDATE collab.tasks SET current_result_id=NULL WHERE id=$1", [up.id])), /permission/);
  await assert.rejects(asUser(users[1], db => db.query("UPDATE collab.tasks SET dependency_version=99 WHERE id=$1", [up.id])), /permission/);
  await assert.rejects(asUser(users[1], db => db.query("UPDATE collab.task_results SET worktree_commit=$1 WHERE id=$2", ["a".repeat(40), results[0].resultId])), /permission/);
  assert.equal((await listTaskResults(users[2], up.id)).results.length, 1); await assert.rejects(listTaskResults(users[3], up.id), /不存在/);
  const other = await task("Wrong validation target"); await assert.rejects(publishResult(users[1], other.id, { ...input, expectedVersion: other.version, idempotencyKey: randomUUID() }), /result_validation_unavailable/);
});

test("a live Pi consumer retains its own fixed input while a second Pi publishes a newer upstream version", { timeout: 30000 }, async () => {
  const up = await task("Live parallel producer"), down = await task("Live parallel consumer");
  const first = await finish(await claimTask(up.id), "parallel-v1"); const firstResult = await publish(first);
  await addDependency(users[1], down.id, { dependsOn: up.id, kind: "strict" }); const claim = await claimTask(down.id);
  let release!: () => void, ready!: () => void, rejectReady!: (error: unknown) => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>((resolve, reject) => { ready = resolve; rejectReady = reject; });
  const controller = new AbortController();
  const work = executeClaim(store, executor, claim, { dataRoot: root, backend: new NativeRuntimeBackend(), signal: controller.signal, driver: async (agent, _claim, workspace) => {
    const file = path.join(workspace.root, "dependencies", up.id, "code.txt"); assert.equal(await readFile(file, "utf8"), "parallel-v1");
    await agent.peer.command("bash", { command: `cat ../dependencies/${up.id}/code.txt` }); ready(); await gate;
    assert.equal(await readFile(file, "utf8"), "parallel-v1"); await agent.peer.command("bash", { command: `cat ../dependencies/${up.id}/code.txt` });
    return { kind: "parallel-fixed-input-diagnostic" };
  } }).then(outcome => { if (outcome !== "completed") rejectReady(new Error(outcome)); return outcome; }, error => { rejectReady(error); throw error; });
  try {
    await started; assert.equal((await runDetail(users[1], claim.run.id)).run.status, "running");
    const second = await finish(await claimTask(up.id), "parallel-v2"); await publish(second);
    const inputs = await runDependencies(users[1], claim.run.id); assert.equal(inputs.run.dependency_state, "needs_revalidation"); assert.equal(inputs.dependencies[0].result_id, firstResult.resultId);
    release(); assert.equal(await work, "completed");
  } finally { release(); controller.abort(); await work; }
});

test("new upstream versions never overwrite a running input; stale direct and transitive results require revalidation", { timeout: 45000 }, async () => {
  const up = await task("Versioned producer"), mid = await task("Intermediate"), down = await task("Transitive consumer");
  await addDependency(users[1], mid.id, { dependsOn: up.id, kind: "strict" }); await addDependency(users[1], down.id, { dependsOn: mid.id, kind: "strict" });
  const first = await finish(await claimTask(up.id), "v1"), firstResult = await publish(first);
  const middle = await finish(await claimTask(mid.id), "middle"); await publish(middle);
  const frozen = await claimTask(down.id); assert.equal(frozen.dependencies?.length, 1);
  const second = await finish(await claimTask(up.id), "v2"); await publish(second);
  const consumed = await finish(frozen, "uses-old-middle");
  assert.equal((await runDependencies(users[1], frozen.run.id)).run.dependency_state, "needs_revalidation");
  await assert.rejects(publish(consumed), /result_validation_unavailable/); await assert.rejects(publish(middle), /result_validation_unavailable/);
  assert.equal((await snapshotDetail(users[1], middle.snapshotId)).manifest.dependencies[0].resultId, firstResult.resultId);
  const blocked = await submit(down.id); assert.equal(await store.claim(executor, "native"), null); await stopRun(users[1], blocked.runId, { idempotencyKey: randomUUID() });
  const replacement = await finish(await claimTask(mid.id), "new-middle"); await publish(replacement);
  const latest = await finish(await claimTask(down.id), "uses-new-middle"); await publish(latest);
});

test("editing goals invalidates published and downstream evidence, while active work cannot be silently retargeted", { timeout: 30000 }, async () => {
  const up = await task("Editable producer"), down = await task("Consumer of original goal");
  const first = await finish(await claimTask(up.id), "old-goal"); await publish(first);
  await addDependency(users[1], down.id, { dependsOn: up.id, kind: "strict" });
  const downstream = await finish(await claimTask(down.id), "consumes-old-goal"); await publish(downstream);
  const change = { title: up.title, description: "New expected behavior", acceptance: up.acceptance, status: "draft" as const,
    reason: "User has changed the producer requirements", expectedVersion: await version(up.id), idempotencyKey: randomUUID() };
  const result = await editTask(users[1], up.id, change);
  assert.equal(result.evidenceInvalidated, true);
  assert.equal((await listTaskResults(users[2], up.id)).task.current_result_id, null);
  assert.equal((await runDependencies(users[1], downstream.claim.run.id)).run.dependency_state, "needs_revalidation");
  await assert.rejects(publish(first), /result_validation_unavailable/);
  const running = await submit(up.id);
  await assert.rejects(editTask(users[1], up.id, { ...change, expectedVersion: await version(up.id), idempotencyKey: randomUUID() }), /task_busy/);
  await stopRun(users[1], running.runId, { idempotencyKey: randomUUID() });
});

test("missing soft inputs permit work but block publication; a fresh run must actually consume the later result", { timeout: 30000 }, async () => {
  const up = await task("Soft producer"), down = await task("Soft consumer"); await addDependency(users[1], down.id, { dependsOn: up.id, kind: "soft" });
  const f = await finish(await claimTask(down.id), "mock-based"); assert.equal(f.claim.dependencies?.[0].resultId, null);
  await assert.rejects(publish(f), /result_validation_unavailable/);
  await publish(await finish(await claimTask(up.id), "real-input"));
  await assert.rejects(publish(f), /result_validation_unavailable/);
  const real = await finish(await claimTask(down.id), "uses-real"); assert.ok(real.claim.dependencies?.[0].resultId); await publish(real);
});

test("withdrawal preserves history and frozen queued input; graph changes invalidate prior evidence", { timeout: 30000 }, async () => {
  const up = await task("Withdrawable"), down = await task("Frozen before withdrawal"), extra = await task("New requirement");
  const first = await finish(await claimTask(up.id)), r = await publish(first);
  await addDependency(users[1], down.id, { dependsOn: up.id, kind: "strict" }); const waiting = await submit(down.id);
  await withdrawResult(users[1], r.resultId, { reason: "This version has an incorrect public interface" });
  assert.equal(await store.claim(executor, "native"), null);
  await publish(first); // A new version does not silently replace a withdrawn pinned version.
  assert.equal(await store.claim(executor, "native"), null);
  assert.equal((await runDependencies(users[2], waiting.runId)).dependencies[0].result_id, r.resultId);
  await stopRun(users[1], waiting.runId, { idempotencyKey: randomUUID() });
  await addDependency(users[1], up.id, { dependsOn: extra.id, kind: "soft" }); await assert.rejects(publish(first), /result_validation_unavailable/);
  const history = (await listTaskResults(users[2], up.id)).results; assert.equal(history.length, 2); assert.ok(history[1].withdrawal_reason);
});

test("old executors cannot consume tracked inputs; corrupt input artifacts fail before Pi launch and source copies cannot alter the result", { timeout: 25000 }, async () => {
  const up = await task("Integrity producer"), down = await task("Integrity consumer");
  const f = await finish(await claimTask(up.id), "original"); await publish(f); await addDependency(users[1], down.id, { dependsOn: up.id, kind: "strict" });
  await submit(down.id); assert.equal((await store.pool.query("SELECT collab_worker.claim_snapshot_aware($1,'native') AS result", [executor])).rows[0].result, null);
  const claim = await store.claim(executor, "native"); assert.ok(claim);
  const manifest = (await snapshotDetail(users[1], f.snapshotId)).manifest, blob = manifest.worktree.find(e => e.path === "code.txt")!.hash;
  const file = path.join(root, "snapshots", f.snapshotId, "blobs", blob), original = await readFile(file); await writeFile(file, "corrupt");
  let launched = false;
  assert.equal(await executeClaim(store, executor, claim, { dataRoot: root, backend: new NativeRuntimeBackend(), driver: async () => { launched = true; return {}; } }), "failed"); assert.equal(launched, false);
  await writeFile(file, original);
  const next = await claimTask(down.id);
  assert.equal(await executeClaim(store, executor, next, { dataRoot: root, backend: new NativeRuntimeBackend(), driver: async (_agent, _claim, workspace) => {
    const copy = path.join(workspace.root, "dependencies", up.id, "code.txt"); await chmod(copy, 0o600); await writeFile(copy, "tampered copy"); return {};
  } }), "completed");
  const detail = (await runDetail(users[1], next.run.id)).run;
  const request = await requestSnapshot(users[1], detail.id, { expectedRevision: detail.revision, idempotencyKey: randomUUID(), note: "Reject mutated inputs" }); await processSnapshots(store, root);
  assert.equal((await listSnapshots(users[1], down.id)).snapshots.find(s => s.id === request.snapshotId).error_code, "snapshot_dependency_mismatch");
  assert.equal((await readFile(file)).toString(), "original");
});


test("evidence package binds real result bytes, validation and discussion, excludes raw output and follows withdrawal and access revocation", { timeout: 30000 }, async () => {
  const t = await task("Reviewable evidence bundle"), f = await finish(await claimTask(t.id), "evidence-code-v1"), result = await publish(f);
  await discussionCommand(users[2], t.id, { action: "create", title: "Evidence review discussion", body: "The exact published code and command must be recorded. sk-" + "fixtureSecret".repeat(3), anchor: null, replacement: null, mentions: [], idempotencyKey: randomUUID() });
  await admin.query("SELECT collab_worker.emit($1,'run.output',$2)", [f.claim.run.id, JSON.stringify({batchId: randomUUID(), events:[{type:"tool_execution_end", toolName:"fixture_tool", isError:false, content:[{type:"text",text:"PRIVATE_RAW_OUTPUT_FIXTURE"}]}]})]);
  const bundle = await resultEvidence(users[2], result.resultId);
  assert.equal(bundle.sha256, reviewHash(JSON.stringify(bundle.payload)));
  assert.equal(bundle.payload.result.id, result.resultId);
  assert.equal(bundle.payload.captured.acceptance, "Use exact dependency versions");
  assert.equal(bundle.payload.validation.evidence.steps[0].exitCode, 0);
  assert.equal(bundle.payload.validation.evidence.steps[0].cleanupConfirmed, true);
  assert.equal(bundle.payload.code.worktreeCommit, bundle.payload.validation.evidence.worktreeCommit);
  assert.ok(bundle.payload.code.changes.find(file => file.path === "code.txt")?.lines.some(line => line.kind === "added" && line.text === "evidence-code-v1"));
  assert.equal(bundle.payload.discussions.length, 1);
  assert.ok(bundle.payload.toolSummary.length);
  assert.equal(JSON.stringify(bundle).includes("PRIVATE_RAW_OUTPUT_FIXTURE"), false);
  assert.equal(JSON.stringify(bundle).includes("fixtureSecret"), false);
  assert.ok(bundle.payload.redactions.length);
  assert.equal(JSON.stringify(bundle).includes(root), false);
  assert.equal((await resultEvidenceStatus(users[1], result.resultId)).metadataHash, bundle.payload.metadataHash);
  await assert.rejects(resultEvidence(users[3], result.resultId), /not_found/);
  await withdrawResult(users[1], result.resultId, { reason: "Withdraw the exact evidence source after review" });
  const withdrawn = await resultEvidence(users[2], result.resultId);
  assert.ok(withdrawn.payload.state.withdrawal);
  assert.notEqual(withdrawn.payload.metadataHash, bundle.payload.metadataHash);
  await admin.query("UPDATE collab.project_memberships SET active=false WHERE project_id=$1 AND user_id=$2", [project, users[2]]);
  try { await assert.rejects(resultEvidence(users[2], result.resultId), /not_found/); }
  finally { await admin.query("UPDATE collab.project_memberships SET active=true WHERE project_id=$1 AND user_id=$2", [project, users[2]]); }
});
