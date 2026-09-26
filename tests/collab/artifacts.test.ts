import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { localConfig, applicationEnvironment, connectionString, executorConnectionString } from "../../scripts/local-config";
import { startNativeDatabase } from "../../scripts/native-database";
import { migrate } from "../../scripts/migrate";
import { provisioningAuth } from "../../lib/collab/auth";
import { database } from "../../lib/collab/database";
import { createProject } from "../../lib/collab/projects";
import { createTask } from "../../lib/collab/tasks";
import { startRun, runDetail } from "../../lib/collab/runs";
import { ExecutionStore } from "../../lib/collab/execution-store";
import { executeClaim } from "../../lib/collab/executor";
import { runtimeBackend } from "../../lib/collab/runtime/backends";
import { importLocalRepository } from "../../lib/collab/repository-import";
import { artifactContext, manageArtifacts } from "../../lib/collab/artifacts";
import { measureArtifact, processArtifactCleanup, scanArtifacts } from "../../lib/collab/runtime/artifact-storage";
import { requestSnapshot, processSnapshots } from "../../lib/collab/snapshots";
import { createValidationProfile, requestValidation } from "../../lib/collab/validations";
import { executeValidation } from "../../lib/collab/validation-worker";
const config = await localConfig(), name = `pi_collab_test_${randomBytes(6).toString("hex")}`, native = await startNativeDatabase(config), root = await mkdtemp(path.join(tmpdir(), "pi-collab-runtime-policy-"));
const mode = process.env.PI_COLLAB_TEST_DOCKER === "1" ? "docker" : "native";
Object.assign(process.env, applicationEnvironment(config), { DATABASE_URL: connectionString(config, false, name), PI_COLLAB_DATA_DIR: root, PI_COLLAB_RUNTIME: mode });
const admin = new Pool({ connectionString: connectionString(config, true, name) }), store = new ExecutionStore(executorConnectionString(config, name)), org = randomUUID(), users: string[] = [], executor = randomUUID(), exec = promisify(execFile), MiB = 1048576;
let project: string, repo: { id: string; baseSha: string };
before(async () => {
  await migrate(config, name); const auth = provisioningAuth(admin);
  for (let i = 0; i < 4; i++) users.push((await auth.api.signUpEmail({ body: { name: `Storage ${i}`, email: `storage${i}@test.invalid`, password: randomBytes(20).toString("hex") } })).user.id);
  await admin.query("INSERT INTO collab.organizations(id,name,created_by) VALUES($1,'Runtime budgets',$2)", [org, users[0]]);
  for (let i = 0; i < 3; i++) await admin.query("INSERT INTO collab.memberships(organization_id,user_id,role) VALUES($1,$2,$3)", [org, users[i], i === 0 ? "owner" : "member"]);
  await admin.query('UPDATE public."user" SET "twoFactorEnabled"=true WHERE id=$1', [users[0]]);
  project = (await createProject(users[0], { organizationId: org, name: "Bounded runtime", description: "" })).id;
  for (let i = 1; i < 3; i++) await admin.query("INSERT INTO collab.project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,'developer')", [org, project, users[i]]);
  const source = path.join(root, "source"); await mkdir(source);
  for (const args of [["init"], ["config", "user.name", "Storage fixture"], ["config", "user.email", "storage@test.invalid"]]) await exec("git", args, { cwd: source });
  await writeFile(path.join(source, "code.txt"), "baseline\n"); await exec("git", ["add", "."], { cwd: source }); await exec("git", ["commit", "-m", "Baseline"], { cwd: source });
  repo = await importLocalRepository(admin, root, { projectId: project, actorId: users[0], source, name: "Runtime policy repository" });
});
after(async () => {
  await store.close(); await database().end(); globalThis.__piCollabPool = undefined; await admin.end();
  const cleanup = new Pool({ connectionString: connectionString(config, true, "postgres") }); await cleanup.query(`DROP DATABASE "${name}" WITH (FORCE)`); await cleanup.end(); await native.stop(); await rm(root, { recursive: true, force: true });
});

const operation = (action: string, extra = {}) => ({ action, idempotencyKey: randomUUID(), reason: "Review retained material before physical reclamation", ...extra });
const policy = (expectedVersion = 0, extra = {}) => operation("policy", { expectedVersion, byteLimit: 100 * 1024 * MiB, candidateDays: 90, workspaceDays: 7, auditDays: 180, ...extra });
async function sourceSnapshot() {
  const task = await createTask(users[1], project, { title: "Storage lifecycle source", description: "", acceptance: "Capture and retain independent working bytes" });
  await startRun(users[1], task.id, { repositoryId: repo.id, baseSha: repo.baseSha, prompt: "Tool fixture without inference", expectedVersion: task.version, idempotencyKey: randomUUID() });
  const claim = await store.claim(executor, mode); assert.ok(claim);
  assert.equal(await executeClaim(store, executor, claim, { dataRoot: root, backend: runtimeBackend(mode), driver: async agent => { await agent.peer.command("bash", { command: "printf fixture > retained.txt" }); return {}; } }), "completed");
  const run = (await runDetail(users[1], claim.run.id)).run;
  const requested = await requestSnapshot(users[1], run.id, { expectedRevision: run.revision, idempotencyKey: randomUUID(), note: "Capture retention lifecycle fixture" });
  await processSnapshots(store, root);
  assert.equal((await admin.query("SELECT status FROM collab.snapshots WHERE id=$1", [requested.snapshotId])).rows[0].status, "ready");
  return { claim, run, id: requested.snapshotId as string };
}
async function age(kind: string, id: string) {
  await admin.query("UPDATE collab_worker.artifacts SET born_at=now()-interval '400 days',retain_until=now()-interval '1 day' WHERE kind=$1 AND id=$2", [kind,id]);
}
const cleanup = (kind: string, artifactId: string) => operation("cleanup", { kind, artifactId, acknowledge: true });
test("artifact policy has role/MFA/version/idempotency controls and reserves before creating material", async () => {
  await assert.rejects(artifactContext(users[3], project), /not_found/);
  await assert.rejects(manageArtifacts(users[1], project, policy()), /forbidden/);
  await admin.query("UPDATE collab.project_memberships SET role='maintainer' WHERE project_id=$1 AND user_id=$2",[project,users[2]]);
  await assert.rejects(manageArtifacts(users[2], project, policy()), /mfa_required/);
  const input = policy(0, { byteLimit: 512 * MiB });
  assert.deepEqual(await manageArtifacts(users[0], project, input), await manageArtifacts(users[0], project, input));
  await assert.rejects(manageArtifacts(users[0], project, { ...input, reason: "Different reason with same operation identity" }), /idempotency_conflict/);
  await assert.rejects(manageArtifacts(users[0], project, policy()), /stale_revision/);
  await assert.rejects(importLocalRepository(admin, root, { projectId: project, actorId: users[0], source: path.join(root,"source"), name: "Over budget repository" }), /artifact_budget_exhausted/);
  await manageArtifacts(users[0], project, policy(1));
  await assert.rejects(database().query("SELECT * FROM collab_worker.artifacts"), /permission denied/);
});
test("real snapshot cleanup retires sources, removes physical bytes, replays safely and then frees an exited archived workspace", { timeout: 60000 }, async () => {
  const f = await sourceSnapshot();
  await assert.rejects(manageArtifacts(users[0], project, cleanup("snapshot", f.id)), /artifact_protected/);
  await age("snapshot", f.id);
  const input = cleanup("snapshot", f.id), accepted = await manageArtifacts(users[0], project, input);
  assert.deepEqual(await manageArtifacts(users[0], project, input), accepted);
  assert.equal((await processArtifactCleanup(store, root, executor))?.status, "deleted");
  await assert.rejects(access(path.join(root,"snapshots",f.id)));
  assert.equal((await admin.query("SELECT status,error_code FROM collab.snapshots WHERE id=$1",[f.id])).rows[0].error_code,"storage_expired");
  await admin.query("UPDATE collab.workspaces SET status='archived',archived_at=now()-interval '10 days',retain_until=now()-interval '1 day' WHERE id=$1",[f.claim.workspace.id]);
  await age("workspace", f.claim.workspace.id); await scanArtifacts(store, root);
  // The scan batch may select older artifacts first; record this exact candidate.
  await store.recordArtifactUsage("workspace",f.claim.workspace.id,await measureArtifact(root,{kind:"workspace",id:f.claim.workspace.id,details:{}}));
  await manageArtifacts(users[0],project,cleanup("workspace",f.claim.workspace.id));
  assert.equal((await processArtifactCleanup(store,root,executor))?.status,"deleted");
  await assert.rejects(access(path.join(root,"workspaces",f.claim.workspace.id)));
  await assert.rejects(requestSnapshot(users[1],f.run.id,{expectedRevision:f.run.revision,idempotencyKey:randomUUID(),note:"Cannot recapture retired workspace"}),/artifact_expired|snapshot_unavailable/);
});
test("a new reference cancels queued cleanup; completed validation scratch is reclaimable while its snapshot stays protected", { timeout: 60000 }, async () => {
  const f=await sourceSnapshot();await age("snapshot",f.id);
  await manageArtifacts(users[0],project,cleanup("snapshot",f.id));
  const profile=await createValidationProfile(users[0],project,{repositoryId:repo.id,name:"Retained validation",config:{version:1,steps:[{tool:"node",args:["-e","console.log('validated')"],timeoutSeconds:10}]},idempotencyKey:randomUUID()});
  const requested=await requestValidation(users[1],f.id,{profileId:profile.profileId,idempotencyKey:randomUUID()});
  assert.equal(await processArtifactCleanup(store,root,executor),undefined);
  assert.equal((await admin.query("SELECT status FROM collab_worker.artifact_cleanup WHERE artifact_id=$1",[f.id])).rows[0].status,"cancelled");
  await access(path.join(root,"snapshots",f.id));
  const claim=await store.claimValidation(executor,mode);assert.ok(claim);assert.equal(claim.id,requested.validationId);
  assert.equal(await executeValidation(store,claim,root),"passed");await age("validation",claim.id);
  await manageArtifacts(users[0],project,cleanup("validation",claim.id));
  assert.equal((await processArtifactCleanup(store,root,executor))?.status,"deleted");
  await assert.rejects(access(path.join(root,"workspaces",claim.id)));
  await assert.rejects(manageArtifacts(users[0],project,cleanup("snapshot",f.id)),/artifact_protected/);
  assert.ok((await admin.query("SELECT evidence FROM collab.validations WHERE id=$1",[claim.id])).rows[0].evidence);
});
test("failed deletion can retry its fixed retired target, and audit pruning preserves fresh evidence", { timeout: 60000 }, async () => {
  const f=await sourceSnapshot();await age("snapshot",f.id);
  await manageArtifacts(users[0],project,cleanup("snapshot",f.id));
  const job=await store.claimArtifactCleanup(executor);assert.ok(job);
  await store.finishArtifactCleanup(executor,job.jobId,"artifact_cleanup_attention");
  await manageArtifacts(users[0],project,cleanup("snapshot",f.id));
  assert.equal((await processArtifactCleanup(store,root,executor))?.status,"deleted");
  await admin.query("INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail,created_at) VALUES($1,$2::uuid,$3,'old.fixture',$2::text,'{}',now()-interval '181 days')",[org,project,users[0]]);
  const input=operation("audit",{acknowledge:true}),result=await manageArtifacts(users[0],project,input);
  assert.equal(result.deletedCount,1);assert.match(result.batchHash,/^[a-f0-9]{64}$/);
  assert.deepEqual(await manageArtifacts(users[0],project,input),result);
  assert.equal((await artifactContext(users[0],project)).expiredAuditCount,0);
  assert.ok((await admin.query("SELECT 1 FROM collab.audit_events WHERE project_id=$1 AND action='artifacts.audit'",[project])).rowCount);
});
