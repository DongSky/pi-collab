import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { requestPromotion } from "../../lib/collab/promotions";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
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
import { startRun, runDetail } from "../../lib/collab/runs";
import { ExecutionStore, type ClaimedRun } from "../../lib/collab/execution-store";
import { executeClaim } from "../../lib/collab/executor";
import { runtimeBackend } from "../../lib/collab/runtime/backends";
import { importLocalRepository } from "../../lib/collab/repository-import";
import { requestSnapshot, processSnapshots, snapshotDetail } from "../../lib/collab/snapshots";
import { createValidationProfile, requestValidation } from "../../lib/collab/validations";
import { executeValidation } from "../../lib/collab/validation-worker";
import { publishResult, withdrawResult } from "../../lib/collab/task-results";
import { requestIntegration, integrationDetail } from "../../lib/collab/integrations";
import { executeIntegration } from "../../lib/collab/integration-worker";
import { publishIntegrationPolicy, submitIntegrationReview } from "../../lib/collab/integration-reviews";
import { createResolutionTask, resolutionDetail } from "../../lib/collab/resolutions";
import { assertResolutionMarkersAbsent } from "../../lib/collab/runtime/resolution-markers";
import { changeProjectMember, reassignTask } from "../../lib/collab/project-members";

const runtime = process.env.PI_COLLAB_TEST_DOCKER === "1" ? "docker" : "native";
process.env.PI_COLLAB_RUNTIME = runtime;
const config = await localConfig(), dbName = `pi_collab_test_${randomBytes(6).toString("hex")}`, native = await startNativeDatabase(config);
Object.assign(process.env, applicationEnvironment(config), { DATABASE_URL: connectionString(config, false, dbName) });
const admin = new Pool({ connectionString: connectionString(config, true, dbName) }), store = new ExecutionStore(executorConnectionString(config, dbName));
const root = await mkdtemp(path.join(tmpdir(), "pi-collab-resolution-tasks-")), source = path.join(root, "source"), exec = promisify(execFile);
const organization = randomUUID(), executor = randomUUID(), users: string[] = [];
process.env.PI_COLLAB_DATA_DIR = root;
let project: string, repository: { id: string; baseSha: string; defaultBranch: string }, basic: string, required: string, policyId: string | null = null, policyVersion = 0;
before(async () => {
  await migrate(config, dbName); const auth = provisioningAuth(admin);
  for (let i = 0; i < 5; i++) users.push((await auth.api.signUpEmail({ body: { name: `Repair ${i}`, email: `repair${i}@test.invalid`, password: randomBytes(20).toString("hex") } })).user.id);
  await admin.query("INSERT INTO collab.organizations(id,name,created_by) VALUES($1,'Repair acceptance',$2)", [organization, users[0]]);
  for (let i = 0; i < 4; i++) await admin.query("INSERT INTO collab.memberships(organization_id,user_id,role) VALUES($1,$2,$3)", [organization, users[i], i === 0 ? "owner" : "member"]);
  await admin.query('UPDATE public."user" SET "twoFactorEnabled"=true WHERE id=$1', [users[0]]);
  project = (await createProject(users[0], { organizationId: organization, name: "Conflict repair", description: "" })).id;
  for (let i = 1; i < 4; i++) await admin.query("INSERT INTO collab.project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,$4)", [organization, project, users[i], i === 3 ? "reviewer" : "developer"]);
  await mkdir(source);
  for (const args of [["init"], ["config", "user.name", "Repair test"], ["config", "user.email", "repair@test.invalid"]]) await exec("git", args, { cwd: source });
  await writeFile(path.join(source, "code.txt"), "baseline\n"); await exec("git", ["add", "."], { cwd: source }); await exec("git", ["commit", "-m", "Baseline"], { cwd: source });
  repository = await importLocalRepository(admin, root, { projectId: project, actorId: users[0], source, name: "Repair repository" });
  basic = await profile("require('node:assert/strict').equal(require('node:fs').readFileSync('code.txt','utf8'),'baseline\\n')");
  required = await profile("const a=require('node:assert/strict'),fs=require('node:fs');a.equal(fs.readFileSync('shared.txt','utf8'),'resolved\\n');a.equal(fs.readFileSync('a.txt','utf8'),'a');a.equal(fs.readFileSync('b.txt','utf8'),'b')");
});
after(async () => {
  await store.close(); await database().end(); globalThis.__piCollabPool = undefined; await admin.end();
  const cleanup = new Pool({ connectionString: connectionString(config, true, "postgres") }); await cleanup.query(`DROP DATABASE "${dbName}" WITH (FORCE)`); await cleanup.end(); await native.stop(); await rm(root, { recursive: true, force: true });
});
const version = async (task: string) => (await admin.query("SELECT version FROM collab.tasks WHERE id=$1", [task])).rows[0].version as number;
async function profile(script: string) { return (await createValidationProfile(users[0], project, { repositoryId: repository.id, name: "Repair checks", idempotencyKey: randomUUID(), config: { version: 1, steps: [{ tool: "node", args: ["-e", script], timeoutSeconds: 10 }] } })).profileId as string; }
async function policy() { const p = await publishIntegrationPolicy(users[0], project, { repositoryId: repository.id, profileId: required, requiredApprovals: 2, reviewerApprovals: true, expectedVersion: policyVersion, reason: "Require repaired content and independent human review", idempotencyKey: randomUUID() }); policyId = p.policyId; policyVersion = p.version; }
const task = (title: string, user = users[1]) => createTask(user, project, { title, description: "", acceptance: "Keep every pinned input" });
async function submit(taskId: string, user = users[1], snapshotId?: string) {
  return startRun(user, taskId, { repositoryId: repository.id, baseSha: repository.baseSha, prompt: "Repair diagnostic; no model inference", expectedVersion: await version(taskId), idempotencyKey: randomUUID(), ...(snapshotId ? { snapshotId } : {}) });
}
async function claim(taskId: string, user = users[1], snapshotId?: string) { const accepted = await submit(taskId, user, snapshotId); const c = await store.claim(executor, runtime); assert.ok(c); assert.equal(c.run.id, accepted.runId); return c; }
async function run(c: ClaimedRun, files: Record<string, string>, script = "") {
  const outcome = await executeClaim(store, executor, c, { dataRoot: root, backend: runtimeBackend(runtime), heartbeatMs: 50, driver: async agent => {
    const code = `const fs=require('node:fs');for(const [p,v] of Object.entries(${JSON.stringify(files)}))fs.writeFileSync(p,v);${script}`;
    const result = await agent.peer.command("bash", { command: `node -e '${code.replaceAll("'", "'\\''")}'` }); assert.equal((result.data as { exitCode: number }).exitCode, 0);
    return { kind: "real-pi-repair-diagnostic", modelInference: false };
  } });
  const detail = outcome === "completed" ? undefined : (await admin.query("SELECT status,stop_reason FROM collab.runs WHERE id=$1", [c.run.id])).rows[0];
  assert.equal(outcome, "completed", detail ? JSON.stringify(detail) : undefined);
}
async function snapshot(c: ClaimedRun) {
  const r = (await runDetail(c.run.requested_by, c.run.id)).run;
  return requestSnapshot(c.run.requested_by, r.id, { expectedRevision: r.revision, idempotencyKey: randomUUID(), note: "Fixed repaired source and conflict decisions" });
}
async function validate(snapshotId: string, user = users[1], profileId = basic) {
  const v = await requestValidation(user, snapshotId, { profileId, idempotencyKey: randomUUID() }), c = await store.claimValidation(executor); assert.ok(c); assert.equal(c.id, v.validationId);
  assert.equal(await executeValidation(store, c, root), "passed"); return v.validationId as string;
}
async function publish(c: ClaimedRun, snapshotId: string, validationId: string, acknowledgeResolution = false) {
  const result = await publishResult(c.run.requested_by, c.run.task_id, { validationId, expectedVersion: await version(c.run.task_id), idempotencyKey: randomUUID(), note: "Reviewed every text, binary, rename and deletion choice against all pinned inputs", acknowledgeResolution });
  return { ...result, claim: c, snapshotId, validationId };
}
async function result(title: string, files: Record<string, string>, dependency?: string) {
  const t = await task(title); if (dependency) await addDependency(users[1], t.id, { dependsOn: dependency, kind: "strict" }); const c = await claim(t.id); await run(c, files);
  const s = await snapshot(c); await processSnapshots(store, root); return publish(c, s.snapshotId, await validate(s.snapshotId));
}
async function integration(ids: string[], outcome: string = "conflicted", user = users[1]) {
  const accepted = await requestIntegration(user, project, { repositoryId: repository.id, targetSha: repository.baseSha, resultIds: ids, profileId: required, expectedPolicyId: policyId, idempotencyKey: randomUUID() });
  const c = await store.claimIntegration(executor); assert.ok(c); assert.equal(c.id, accepted.integrationId); assert.equal(await executeIntegration(store, c, root), outcome); return c;
}
async function parent() { const a = await result("Conflict source A", { "shared.txt": "left\n", "a.txt": "a" }), b = await result("Conflict source B", { "shared.txt": "right\n", "b.txt": "b" }); return { a, b, candidate: await integration([a.resultId, b.resultId]) }; }
const creation = (ownerId = users[2]) => ({ ownerId, title: "Resolve complete pinned combination", reason: "Combine both authors and account for every conflict choice", idempotencyKey: randomUUID() });
async function repair(parentId: string) {
  const t = await createResolutionTask(users[2], parentId, creation()), c = await claim(t.taskId, users[2]); await run(c, { "shared.txt": "resolved\n" });
  const s = await snapshot(c); await processSnapshots(store, root); return publish(c, s.snapshotId, await validate(s.snapshotId, users[2], required), true);
}
async function until(predicate: () => Promise<boolean>) { const end = Date.now() + 10000; while (!await predicate()) { if (Date.now() > end) throw new Error("Repair timeout"); await new Promise(resolve => setTimeout(resolve, 20)); } }

test("only current governed conflicts admit an idempotent, scoped, assigned repair with a frozen source graph", async () => {
  const ungoverned = await parent(); await assert.rejects(createResolutionTask(users[2], ungoverned.candidate.id, creation()), /resolution_source_unavailable/);
  await policy(); const p = await parent(), input = creation();
  for (const user of [users[3], users[4]]) await assert.rejects(createResolutionTask(user, p.candidate.id, input), /forbidden|not_found/);
  await assert.rejects(createResolutionTask(users[1], p.candidate.id, input), /forbidden/);
  await assert.rejects(createResolutionTask(users[0], p.candidate.id, creation(users[3])), /invalid_owner/);
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => createResolutionTask(users[2], p.candidate.id, input))); assert.equal(new Set(concurrent.map(r => r.taskId)).size, 1);
  const id = concurrent[0].taskId;
  await assert.rejects(createResolutionTask(users[2], p.candidate.id, { ...input, reason: "Changed repair instructions under the same request key" }), /idempotency_conflict/);
  await assert.rejects(createResolutionTask(users[2], p.candidate.id, creation()), /resolution_exists/);
  const detail = (await resolutionDetail(users[3], id)).resolution; assert.equal(detail.input.policyId, policyId); assert.equal(detail.input.sources.length, 2);
  await assert.rejects(resolutionDetail(users[4], id), /不存在/);
  assert.equal((await asUser(users[4], db => db.query("SELECT * FROM collab.resolution_tasks"))).rowCount, 0);
  for (const sql of ["UPDATE collab.resolution_tasks SET input='{}'", "DELETE FROM collab.resolution_tasks", "SELECT collab_worker.resolution_input($1)"]) await assert.rejects(asUser(users[2], db => db.query(sql, sql.includes("$1") ? [randomUUID()] : undefined)), /permission/);
  const other = await task("Cannot change pinned graph"); await assert.rejects(addDependency(users[2], id, { dependsOn: other.id, kind: "strict" }), /resolution_dependencies_fixed/);
  await assert.rejects(admin.query("DELETE FROM collab.task_dependencies WHERE task_id=$1", [id]), /resolution_dependencies_fixed/);
  assert.equal((await admin.query("SELECT count(*)::int AS count FROM collab.task_dependencies WHERE task_id=$1", [id])).rows[0].count, 2);
  await reassignTask(users[0], id, { ownerId: users[1], expectedVersion: await version(id) });
  assert.equal((await createResolutionTask(users[2], p.candidate.id, input)).taskId, id);
});

test("new worker protocol starts a complete real Pi repair and carries exact provenance through snapshot, validation and publication", async () => {
  const p = await parent(), t = await createResolutionTask(users[2], p.candidate.id, creation()); const op = await submit(t.taskId, users[2]);
  for (const name of ["claim", "claim_snapshot_aware", "claim_result_aware", "claim_contract_aware"]) {
    assert.equal((await store.pool.query(`SELECT collab_worker.${name}($1,'native') AS result`, [executor])).rows[0].result, null);
  }
  const c = await store.claim(executor, runtime); assert.ok(c?.resolution); assert.equal(c.run.id, op.runId); assert.equal(c.resolution.integrationId, p.candidate.id); assert.equal(c.dependencies?.length, 2);
  await run(c, { "shared.txt": "resolved\n" }, "require('node:assert/strict').equal(JSON.parse(fs.readFileSync('../resolution.json','utf8')).sources.length,2)");
  const s = await snapshot(c);
  for (const name of ["pending_snapshots", "pending_snapshots_with_results", "pending_snapshots_with_contracts"]) assert.deepEqual((await store.pool.query(`SELECT collab_worker.${name}() AS result`)).rows[0].result, []);
  await processSnapshots(store, root);
  const manifest = (await snapshotDetail(users[3], s.snapshotId)).manifest; assert.equal(manifest.resolution?.integrationId, p.candidate.id);
  await assert.rejects(requestValidation(users[2], s.snapshotId, { profileId: basic, idempotencyKey: randomUUID() }), /resolution_validation_required/);
  const v = await requestValidation(users[2], s.snapshotId, { profileId: required, idempotencyKey: randomUUID() });
  for (const name of ["claim_validation", "claim_validation_with_results", "claim_validation_with_contracts"]) assert.equal((await store.pool.query(`SELECT collab_worker.${name}($1) AS result`, [executor])).rows[0].result, null);
  const vc = await store.claimValidation(executor); assert.ok(vc?.resolution); assert.equal(vc.id, v.validationId);
  await assert.rejects(store.finishValidation(vc, "passed", { resolution: null } as never, null), /invalid_validation/);
  assert.equal(await executeValidation(store, vc, root), "passed");
  const input = { validationId: vc.id, expectedVersion: await version(t.taskId), idempotencyKey: randomUUID(), note: "Human checked all conflict choices in this repaired snapshot" };
  await assert.rejects(publishResult(users[2], t.taskId, input), /resolution_acknowledgement_required/);
  const published = await publishResult(users[2], t.taskId, { ...input, acknowledgeResolution: true });
  const replays = await Promise.all(Array.from({ length: 5 }, () => publishResult(users[2], t.taskId, { ...input, acknowledgeResolution: true }))); assert.ok(replays.every(r => r.resultId === published.resultId && r.replayed));
  assert.equal((await admin.query("SELECT count(*)::int AS count FROM collab.resolution_publications WHERE result_id=$1", [published.resultId])).rows[0].count, 1);
  const combined = await integration([published.resultId], "checked", users[2]); assert.deepEqual(combined.sources.map(source => source.resultId), [published.resultId]); assert.deepEqual(combined.sources[0].dependencyResultIds, []);
  const detail = (await integrationDetail(users[3], combined.id)).integration; assert.equal(detail.runtime,runtime); assert.equal(detail.evidence.validation.environment.policy,runtime === "docker" ? "container-fixed-validation-v1" : "native-trusted-v1"); assert.equal(detail.review_state.reviewSatisfied, false);
  for (const contributor of [users[1], users[2]]) await assert.rejects(submitIntegrationReview(contributor, combined.id, { revisionHash: detail.review_state.revisionHash, expectedVersion: 0, decision: "approve", note: "Original authors remain contributors after repair publication", idempotencyKey: randomUUID() }), /integration_self_approval/);
  for (const reviewer of [users[0], users[3]]) await submitIntegrationReview(reviewer, combined.id, { revisionHash: detail.review_state.revisionHash, expectedVersion: 0, decision: "approve", note: "Reviewed repaired combination and mandatory check evidence", idempotencyKey: randomUUID() });
  assert.equal((await integrationDetail(users[3], combined.id)).integration.review_state.reviewSatisfied, true);
  assert.equal(await readFile(path.join(root, "workspaces", p.a.claim.workspace.id, "checkout/shared.txt"), "utf8"), "left\n");
  assert.equal((await exec("git", ["rev-parse", "HEAD"], { cwd: source })).stdout.trim(), repository.baseSha);
});

test("repair replacement remaps downstream dependencies, rejects overlap and supports nested repair provenance", async () => {
  const p = await parent(), fixed = await repair(p.candidate.id);
  const downstream = await result("Downstream of original A", { "tail.txt": "preserved" }, p.a.claim.run.task_id);
  const combined = await integration([fixed.resultId, downstream.resultId], "checked");
  assert.deepEqual(combined.sources.map(s => s.resultId), [fixed.resultId, downstream.resultId]); assert.deepEqual(combined.sources[1].dependencyResultIds, [fixed.resultId]);
  const request = (ids: string[]) => requestIntegration(users[2], project, { repositoryId: repository.id, targetSha: repository.baseSha, resultIds: ids, profileId: required, expectedPolicyId: policyId, idempotencyKey: randomUUID() });
  await assert.rejects(request([fixed.resultId, p.a.resultId]), /resolution_overlap/);
  const rivalParent = await integration([p.a.resultId, p.b.resultId]), rival = await repair(rivalParent.id); await assert.rejects(request([fixed.resultId, rival.resultId]), /resolution_overlap/);
  const next = await result("New conflicting change", { "shared.txt": "another choice\n" }, p.a.claim.run.task_id);
  const nestedParent = await integration([fixed.resultId, next.resultId]), nested = await repair(nestedParent.id);
  const final = await integration([nested.resultId, downstream.resultId], "checked", users[2]); assert.deepEqual(final.sources.map(s => s.resultId), [nested.resultId, downstream.resultId]);
  const detail = (await integrationDetail(users[3], final.id)).integration;
  await assert.rejects(submitIntegrationReview(users[1], final.id, { revisionHash: detail.review_state.revisionHash, expectedVersion: 0, decision: "approve", note: "Nested repairs cannot wash away original authorship", idempotencyKey: randomUUID() }), /integration_self_approval/);
  await assert.rejects(request([nested.resultId, fixed.resultId]), /resolution_overlap/);
  await withdrawResult(users[1], p.a.resultId, { reason: "Original source withdrawal invalidates nested repairs" });
  assert.equal((await integrationDetail(users[3], final.id)).integration.input_state, "stale"); await assert.rejects(request([nested.resultId]), /integration_source_unavailable/);
});

test("unresolved markers fail before any check runs, while repaired snapshots resume in another fresh workspace", async () => {
  const p = await parent(), t = await createResolutionTask(users[2], p.candidate.id, creation()), c = await claim(t.taskId, users[2]); await run(c, {});
  const s = await snapshot(c); await processSnapshots(store, root); await requestValidation(users[2], s.snapshotId, { profileId: required, idempotencyKey: randomUUID() });
  const v = await store.claimValidation(executor); assert.ok(v); assert.equal(await executeValidation(store, v, root), "failed");
  await assert.rejects(readFile(path.join(root, "validation-executions", v.id, "evidence.json")), /ENOENT/);
  const resumed = await claim(t.taskId, users[2], s.snapshotId); assert.notEqual(resumed.workspace.id, c.workspace.id); await run(resumed, { "shared.txt": "resolved\n" });
  const next = await snapshot(resumed); await processSnapshots(store, root); const fixed = await publish(resumed, next.snapshotId, await validate(next.snapshotId, users[2], required), true);
  assert.equal((await snapshotDetail(users[3], next.snapshotId)).manifest.parentSnapshot?.id, s.snapshotId); await integration([fixed.resultId], "checked");
  for (const encoding of ["utf8", "utf16le"] as const) assert.throws(() => assertResolutionMarkersAbsent([Buffer.from("<<<<<<< ours\nleft\n=======\nright\n>>>>>>> theirs\n", encoding)]), /snapshot_resolution_markers_present/);
  assert.throws(() => assertResolutionMarkersAbsent([Buffer.from("<<<<<<< ours\n", "utf16le").swap16()]), /snapshot_resolution_markers_present/);
  assert.throws(() => assertResolutionMarkersAbsent([Buffer.concat([Buffer.from("<<<<<<< ours\n", "utf16le"), Buffer.from([1])])]), /snapshot_resolution_markers_present/);
});

test("ordinary downstream consumers also require workers that can read repair snapshots", async () => {
  await policy();
  const p = await parent(), repairTask = await createResolutionTask(users[2], p.candidate.id, creation()), consumer = await task("Consume repaired source");
  await addDependency(users[1], consumer.id, { dependsOn: repairTask.taskId, kind: "strict" }); await submit(consumer.id);
  assert.equal(await store.claim(executor, runtime), null);
  const repairRun = await claim(repairTask.taskId, users[2]); await run(repairRun, { "shared.txt": "resolved\n" });
  const repairSnapshot = await snapshot(repairRun); await processSnapshots(store, root);
  const fixed = await publish(repairRun, repairSnapshot.snapshotId, await validate(repairSnapshot.snapshotId, users[2], required), true);
  // The consumer queued before the repair existed: its strict input is still
  // null until dispatch. Older workers must inspect the now-available input.
  assert.equal((await store.pool.query("SELECT collab_worker.claim_contract_aware($1,'native') AS result", [executor])).rows[0].result, null);
  const c = await store.claim(executor, runtime); assert.ok(c); assert.equal(c.resolution, null);
  await run(c, { "consumer.txt": "uses repaired code" }, `require('node:assert/strict').equal(fs.readFileSync('../dependencies/${fixed.claim.run.task_id}/shared.txt','utf8'),'resolved\\n')`);
  const saved = await snapshot(c);
  for (const name of ["pending_snapshots_with_results", "pending_snapshots_with_contracts"]) assert.deepEqual((await store.pool.query(`SELECT collab_worker.${name}() AS result`)).rows[0].result, []);
  await processSnapshots(store, root); const v = await requestValidation(users[1], saved.snapshotId, { profileId: basic, idempotencyKey: randomUUID() });
  assert.equal((await store.pool.query("SELECT collab_worker.claim_validation_with_contracts($1) AS result", [executor])).rows[0].result, null);
  const claimed = await store.claimValidation(executor); assert.ok(claimed); assert.equal(claimed.id, v.validationId); assert.equal(await executeValidation(store, claimed, root), "passed");
  const result = await publish(c, saved.snapshotId, v.validationId);
  const accepted = await requestIntegration(users[1], project, { repositoryId: repository.id, targetSha: repository.baseSha, resultIds: [result.resultId], profileId: required, expectedPolicyId: policyId, idempotencyKey: randomUUID() });
  assert.equal((await store.pool.query("SELECT collab_worker.claim_integration($1) AS result", [executor])).rows[0].result, null);
  const combined = await store.claimIntegration(executor); assert.ok(combined); assert.equal(combined.id, accepted.integrationId); assert.equal(await executeIntegration(store, combined, root), "checked");
  assert.deepEqual(combined.sources.map(source => source.resultId), [fixed.resultId, result.resultId]);
});

test("tampering with repair inputs is prevented by containers or blocks native capture", async () => {
  await policy();
  const p = await parent(), t = await createResolutionTask(users[2], p.candidate.id, creation()), c = await claim(t.taskId, users[2]);
  // Provenance is prepared during executeClaim. Docker mounts it read-only;
  // native mode instead detects changed bytes before admitting a snapshot.
  const mutation = "fs.chmodSync('../resolution.json',0o600);fs.writeFileSync('../resolution.json','{}')";
  await run(c, { "shared.txt": "resolved\n" }, runtime === "docker"
    ? `const original=fs.readFileSync('../resolution.json','utf8');let denied=false;try{${mutation}}catch(e){require('node:assert/strict').ok(['EROFS','EPERM','EACCES'].includes(e.code));denied=true;}require('node:assert/strict').ok(denied);require('node:assert/strict').equal(fs.readFileSync('../resolution.json','utf8'),original);`
    : mutation);
  const s = await snapshot(c); await processSnapshots(store, root);
  assert.equal((await admin.query("SELECT status FROM collab.snapshots WHERE id=$1", [s.snapshotId])).rows[0].status, runtime === "docker" ? "ready" : "failed");
});

test("source withdrawal during a real Pi repair stops it; queued and later starts cannot silently adopt a new input", async () => {
  await policy();
  const p = await parent(), t = await createResolutionTask(users[2], p.candidate.id, creation()), c = await claim(t.taskId, users[2]);
  const work = executeClaim(store, executor, c, { dataRoot: root, backend: runtimeBackend(runtime), heartbeatMs: 30, driver: async agent => {
    await agent.peer.command("bash", { command: "node -e 'require(\"node:fs\").writeFileSync(\"started.txt\",\"yes\");setTimeout(()=>{},30000)'" }); return { kind: "stopped-repair" };
  } });
  await until(async () => { try { return (await readFile(path.join(root, "workspaces", c.workspace.id, "checkout", "started.txt"), "utf8")) === "yes"; } catch { return false; } });
  await withdrawResult(users[1], p.a.resultId, { reason: "Withdraw original code while the repair agent is active" }); assert.equal(await work, "cancelled");
  await assert.rejects(submit(t.taskId, users[2]), /resolution_source_unavailable/);
  const q = await parent(), queued = await createResolutionTask(users[2], q.candidate.id, creation()); await submit(queued.taskId, users[2]);
  await policy(); assert.equal(await store.claim(executor, runtime), null);
  assert.equal((await admin.query("SELECT status FROM collab.runs WHERE task_id=$1", [queued.taskId])).rows[0].status, "cancelled");
  await assert.rejects(submit(queued.taskId, users[2]), /resolution_source_unavailable/);
});

test("publication rechecks parent authority, target and policy even after successful repair validation", async () => {
  await policy();
  for (const change of ["requester", "target", "policy"] as const) {
    const p = await parent(), t = await createResolutionTask(users[2], p.candidate.id, creation()), c = await claim(t.taskId, users[2]);
    await run(c, { "shared.txt": "resolved\n" }); const s = await snapshot(c); await processSnapshots(store, root);
    const checked = await validate(s.snapshotId, users[2], required);
    if (change === "requester") {
      for (const active of [false, true]) {
        const member = (await admin.query("SELECT authorization_version::text AS version FROM collab.project_memberships WHERE project_id=$1 AND user_id=$2", [project, users[1]])).rows[0];
        await changeProjectMember(users[0], project, users[1], { role: "developer", active, expectedVersion: member.version });
      }
    } else if (change === "target") await admin.query("UPDATE collab.repositories SET base_sha=$2 WHERE id=$1", [repository.id, "f".repeat(40)]);
    else await policy();
    try {
      assert.notEqual((await resolutionDetail(users[2], t.taskId)).resolution.input_state, "current");
      await assert.rejects(publish(c, s.snapshotId, checked, true), /result_validation_unavailable/);
      await assert.rejects(submit(t.taskId, users[2]), change === "target" ? /repository_revision_unavailable/ : /resolution_source_unavailable/);
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM collab.resolution_publications WHERE task_id=$1", [t.taskId])).rows[0].n, 0);
    } finally {
      if (change === "target") await admin.query("UPDATE collab.repositories SET base_sha=$2 WHERE id=$1", [repository.id, repository.baseSha]);
    }
  }
});

test("repair reassignment cancels old queued control without changing its pinned sources", async () => {
  await policy(); const p = await parent(), t = await createResolutionTask(users[2], p.candidate.id, creation());
  const old = await submit(t.taskId, users[2]);
  await reassignTask(users[0], t.taskId, { ownerId: users[1], expectedVersion: await version(t.taskId) });
  assert.equal(await store.claim(executor, runtime), null);
  assert.equal((await runDetail(users[1], old.runId)).run.status, "cancelled");
  await assert.rejects(submit(t.taskId, users[2]), /forbidden/);
  const c = await claim(t.taskId, users[1]); assert.equal(c.resolution?.integrationId, p.candidate.id); await run(c, { "shared.txt": "resolved\n" });
});

test("a successful check command cannot mutate repair provenance and publish its result", async () => {
  const original = required;
  required = await profile("const fs=require('node:fs');fs.chmodSync('../resolution.json',0o600);fs.writeFileSync('../resolution.json','{}')");
  try {
    await policy(); const p = await parent(), t = await createResolutionTask(users[2], p.candidate.id, creation()), c = await claim(t.taskId, users[2]);
    await run(c, { "shared.txt": "resolved\n" }); const s = await snapshot(c); await processSnapshots(store, root);
    await requestValidation(users[2], s.snapshotId, { profileId: required, idempotencyKey: randomUUID() });
    const v = await store.claimValidation(executor); assert.ok(v); assert.equal(await executeValidation(store, v, root), "failed");
    const evidence = (await admin.query("SELECT evidence FROM collab.validations WHERE id=$1", [v.id])).rows[0].evidence;
    if (runtime === "docker") {
      assert.equal(evidence.steps[0].exitCode, 1);
      assert.equal(evidence.steps[0].error, "validation_nonzero_exit");
    } else {
      assert.equal(evidence.steps[0].exitCode, 0);
      assert.equal(evidence.steps[0].error, "validation_source_changed");
    }
    assert.equal(evidence.steps[0].sourceUnchanged, runtime === "docker");
    await assert.rejects(publish(c, s.snapshotId, v.id, true), /result_validation_unavailable/);
  } finally { required = original; }
});


test("the actual container executor drains snapshots, validations, repaired integrations and reviewed promotions", { skip: process.env.PI_COLLAB_TEST_DAEMON !== "1", timeout: 90000 }, async () => {
  assert.equal(runtime, "docker"); await policy();
  const p = await parent(), t = await createResolutionTask(users[2], p.candidate.id, creation()), c = await claim(t.taskId, users[2]);
  await run(c, { "shared.txt": "resolved\n" }); const saved = await snapshot(c);
  const worker = spawn(process.execPath, ["--import", "tsx", "scripts/executor.ts"], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "development", PI_COLLAB_RUNTIME: "docker", PI_COLLAB_DATA_DIR: root, PI_COLLAB_EXECUTOR_DATABASE_URL: executorConnectionString(config, dbName) }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = ""; worker.stdout.on("data", chunk => { output += chunk; }); worker.stderr.on("data", chunk => { output += chunk; });
  const exit = once(worker, "exit");
  const awaitState = async (table: "snapshots" | "validations" | "integrations" | "promotions", id: string, expected: string) => {
    const deadline = Date.now() + 25000;
    for (;;) {
      const row = (await admin.query(`SELECT status FROM collab.${table} WHERE id=$1`, [id])).rows[0];
      if (row?.status === expected) return;
      if (worker.exitCode !== null || Date.now() > deadline || ["failed", "unknown", "check_failed", "aborted"].includes(row?.status)) throw new Error(`${table} expected ${expected}, got ${row?.status}; ${output}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
  try {
    await awaitState("snapshots", saved.snapshotId, "ready");
    const validation = await requestValidation(users[2], saved.snapshotId, { profileId: required, idempotencyKey: randomUUID() });
    await awaitState("validations", validation.validationId, "passed");
    const result = await publish(c, saved.snapshotId, validation.validationId, true);
    const integration = await requestIntegration(users[2], project, { repositoryId: repository.id, targetSha: repository.baseSha, resultIds: [result.resultId], profileId: required, expectedPolicyId: policyId, idempotencyKey: randomUUID() });
    await awaitState("integrations", integration.integrationId, "checked");
    const detail = (await integrationDetail(users[3], integration.integrationId)).integration;
    assert.equal(detail.evidence.validation.environment.policy, "container-fixed-validation-v1");
    for (const reviewer of [users[0], users[3]]) await submitIntegrationReview(reviewer, integration.integrationId, { revisionHash: detail.review_state.revisionHash, expectedVersion: 0, decision: "approve", note: "Independent review of daemon-produced container evidence", idempotencyKey: randomUUID() });
    const promotion = await requestPromotion(users[0], integration.integrationId, { revisionHash: detail.review_state.revisionHash, acknowledgeExcluded: true, reason: "Promote the exact independently reviewed container repair", idempotencyKey: randomUUID() });
    await awaitState("promotions", promotion.promotionId, "applied");
    const advanced = (await admin.query("SELECT base_sha FROM collab.repositories WHERE id=$1", [repository.id])).rows[0].base_sha;
    assert.notEqual(advanced, repository.baseSha);
    assert.equal((await exec("git", ["show", `${advanced}:shared.txt`], { cwd: path.join(root, "repositories", repository.id, "git") })).stdout, "resolved\n");
  } finally { worker.kill("SIGTERM"); await exit; }
});
