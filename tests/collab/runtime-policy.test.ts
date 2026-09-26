import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
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
import { configureRuntimePolicy, runtimePolicyContext } from "../../lib/collab/runtime-policy";
import { measureWorkspace } from "../../lib/collab/runtime/storage-meter";
const config = await localConfig(), name = `pi_collab_test_${randomBytes(6).toString("hex")}`, native = await startNativeDatabase(config), root = await mkdtemp(path.join(tmpdir(), "pi-collab-runtime-policy-"));
const mode = process.env.PI_COLLAB_TEST_DOCKER === "1" ? "docker" : "native";
Object.assign(process.env, applicationEnvironment(config), { DATABASE_URL: connectionString(config, false, name), PI_COLLAB_DATA_DIR: root, PI_COLLAB_RUNTIME: mode });
const admin = new Pool({ connectionString: connectionString(config, true, name) }), store = new ExecutionStore(executorConnectionString(config, name)), org = randomUUID(), users: string[] = [], executor = randomUUID(), exec = promisify(execFile), MiB = 1048576;
let project: string, repo: { id: string; baseSha: string }, version = 0;
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
const policy = (extra = {}) => ({ expectedVersion: version, idempotencyKey: randomUUID(), reason: "Set explicit runtime and retained workspace budgets", aiSeconds: 30, terminalSeconds: 30, workspaceBytes: MiB, memberBytes: MiB, projectBytes: 2 * MiB, ...extra });
async function setPolicy(extra = {}) { const result = await configureRuntimePolicy(users[0], project, policy(extra)); version = result.version; }
async function queued(owner = users[1]) {
  const task = await createTask(owner, project, { title: "Quota-controlled work", description: "", acceptance: "Keep retained code and respect limits" });
  return startRun(owner, task.id, { repositoryId: repo.id, baseSha: repo.baseSha, prompt: "Local tool fixture, no inference", expectedVersion: task.version, idempotencyKey: randomUUID() });
}
test("runtime policy is scoped, MFA protected, versioned and retry safe", async () => {
  await assert.rejects(runtimePolicyContext(users[3], project), /not_found/);
  await assert.rejects(configureRuntimePolicy(users[1], project, policy()), /forbidden/);
  const input = policy(), a = await configureRuntimePolicy(users[0], project, input), b = await configureRuntimePolicy(users[0], project, input); version = a.version; assert.equal(a.version, b.version);
  await assert.rejects(configureRuntimePolicy(users[0], project, { ...input, reason: "Changed request under the same idempotency key" }), /idempotency_conflict/);
  await assert.rejects(configureRuntimePolicy(users[0], project, { ...input, idempotencyKey: randomUUID() }), /stale_revision/);
  await assert.rejects(database().query("SELECT * FROM collab_worker.run_execution_limits"), /permission denied/);
});
test("real Pi disk overrun stops the writer, retained usage blocks queued work, and new policy admits it without erasing prior files", { timeout: 45000 }, async () => {
  const a = await queued(), b = await queued(); const claim = await store.claim(executor, mode); assert.ok(claim); assert.equal(claim.run.id, a.runId); assert.equal(claim.limits?.workspaceBytes, MiB);
  assert.equal(await store.claim(executor, mode), null, "member reservation must leave second task queued");
  assert.equal(await executeClaim(store, executor, claim, { dataRoot: root, backend: runtimeBackend(mode), heartbeatMs: 100, driver: async agent => {
    await agent.peer.command("bash", { command: `node -e 'require("node:fs").writeFileSync("large.bin",Buffer.alloc(${2 * MiB}));setTimeout(()=>{},10000)'` }); return {};
  } }), "cancelled");
  const detail = (await runDetail(users[1], a.runId)).run; assert.equal(detail.summary.reason, "workspace_storage_exhausted");
  assert.equal(await store.claim(executor, mode), null); assert.equal((await runtimePolicyContext(users[1], project)).storageAvailable, false);
  await setPolicy({ workspaceBytes: 4 * MiB, memberBytes: 16 * MiB, projectBytes: 32 * MiB });
  const second = await store.claim(executor, mode); assert.ok(second); assert.equal(second.run.id, b.runId); assert.equal(second.limits?.workspaceBytes, 4 * MiB);
  assert.equal(await executeClaim(store, executor, second, { dataRoot: root, backend: runtimeBackend(mode), driver: async agent => { await agent.peer.command("bash", { command: "printf finished > own.txt" }); return {}; } }), "completed");
  const usage = await measureWorkspace(root, claim.workspace.id); assert.ok(usage.bytes! >= 2 * MiB);
});
test("the pinned runtime deadline stops an actual process even after a policy is relaxed", { timeout: 20000 }, async () => {
  await setPolicy({ aiSeconds: 3, workspaceBytes: 4 * MiB, memberBytes: 32 * MiB, projectBytes: 64 * MiB });
  const accepted = await queued(users[2]), claim = await store.claim(executor, mode); assert.ok(claim); assert.equal(claim.limits?.timeoutSeconds, 3);
  await setPolicy({ aiSeconds: 60, workspaceBytes: 4 * MiB, memberBytes: 32 * MiB, projectBytes: 64 * MiB });
  const started = Date.now(); assert.equal(await executeClaim(store, executor, claim, { dataRoot: root, backend: runtimeBackend(mode), driver: async agent => { await agent.peer.command("bash", { command: "node -e 'setTimeout(()=>{},15000)'" }); return {}; } }), "cancelled");
  assert.ok(Date.now() - started < 10000); assert.equal((await runDetail(users[2], accepted.runId)).run.summary.reason, "execution_timeout");
});
test("workspace metering ignores external symlink targets and exposes only counts", async () => {
  const id = randomUUID(), directory = path.join(root, "workspaces", id); await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, "small"), "ok");
  const external = path.join(root, "external"); await writeFile(external, Buffer.alloc(4 * MiB)); await symlink(external, path.join(directory, "external-link"));
  const result = await measureWorkspace(root, id); assert.equal(result.error, null); assert.ok(result.bytes! < 1024); assert.deepEqual(Object.keys(result).sort(), ["bytes", "error"]);
});
