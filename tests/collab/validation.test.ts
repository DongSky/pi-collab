import { measureWorkspace } from "../../lib/collab/runtime/storage-meter";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { createServer, createConnection, type Socket } from "node:net";
import { localConfig, applicationEnvironment, connectionString, executorConnectionString } from "../../scripts/local-config";
import { startNativeDatabase } from "../../scripts/native-database";
import { migrate } from "../../scripts/migrate";
import { provisioningAuth } from "../../lib/collab/auth";
import { asUser, database } from "../../lib/collab/database";
import { createProject } from "../../lib/collab/projects";
import { createTask } from "../../lib/collab/tasks";
import { startRun, runDetail } from "../../lib/collab/runs";
import { changeProjectMember } from "../../lib/collab/project-members";
import { ExecutionStore } from "../../lib/collab/execution-store";
import { importLocalRepository } from "../../lib/collab/repository-import";
import { createWorkspace } from "../../lib/collab/runtime/workspace";
import { captureSnapshot, snapshotSummary } from "../../lib/collab/runtime/snapshots";
import { requestSnapshot } from "../../lib/collab/snapshots";
import { createValidationProfile, listValidationProfiles, requestValidation, listValidations, validationDetail, cancelValidation } from "../../lib/collab/validations";
import { validationConfig, type ValidationConfig } from "../../lib/collab/validation-config";
import { executeValidation } from "../../lib/collab/validation-worker";
import { validateSnapshot } from "../../lib/collab/runtime/validation";

const config = await localConfig(), databaseName = `pi_collab_test_${randomBytes(6).toString("hex")}`;
const native = await startNativeDatabase(config);
Object.assign(process.env, applicationEnvironment(config), { DATABASE_URL: connectionString(config, false, databaseName) });
const admin = new Pool({ connectionString: connectionString(config, true, databaseName) }), store = new ExecutionStore(executorConnectionString(config, databaseName));
const executor = randomUUID(), organization = randomUUID(), users: string[] = [];
const root = await mkdtemp(path.join(tmpdir(), "pi-collab-validation-")), source = path.join(root, "source"), exec = promisify(execFile);
let project: string, imported: { id: string; baseSha: string };
before(async () => {
  await migrate(config, databaseName);
  const provision = provisioningAuth(admin);
  for (let i = 0; i < 5; i++) users.push((await provision.api.signUpEmail({ body: { name: `Validation user ${i}`, email: `validation${i}@test.invalid`, password: randomBytes(20).toString("hex") } })).user.id);
  await admin.query("INSERT INTO collab.organizations(id,name,created_by) VALUES($1,'Validation test',$2)", [organization, users[0]]);
  for (let i = 0; i < 4; i++) await admin.query("INSERT INTO collab.memberships(organization_id,user_id,role) VALUES($1,$2,$3)", [organization, users[i], i === 0 ? "owner" : "member"]);
  await admin.query('UPDATE public."user" SET "twoFactorEnabled"=true WHERE id=$1', [users[0]]); // SQL fixture; browser suite uses actual enrollment.
  project = (await createProject(users[0], { organizationId: organization, name: "Validation project", description: "" })).id;
  for (let i = 1; i < 4; i++) await admin.query("INSERT INTO collab.project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,$4)", [organization, project, users[i], i === 1 ? "developer" : i === 2 ? "reviewer" : "maintainer"]);
  await mkdir(source);
  for (const args of [["init"], ["config", "user.name", "Validation acceptance"], ["config", "user.email", "validation@test.invalid"]]) await exec("git", args, { cwd: source });
  await writeFile(path.join(source, "code.txt"), "baseline\n");
  await writeFile(path.join(source, "check.cjs"), 'const assert=require("node:assert/strict"),fs=require("node:fs");assert.equal(fs.readFileSync("code.txt","utf8"),"working\\n");for(const key of ["DATABASE_URL","PI_COLLAB_EXECUTOR_DATABASE_URL","NODE_OPTIONS","VALIDATION_PRIVATE_FIXTURE"])assert.equal(process.env[key],undefined);console.log("actual test passed");');
  await exec("git", ["add", "."], { cwd: source }); await exec("git", ["commit", "-m", "Initial fixture"], { cwd: source });
  imported = await importLocalRepository(admin, root, { projectId: project, actorId: users[0], name: "Local validation fixture", source });
});
after(async () => {
  await store.close(); await database().end(); globalThis.__piCollabPool = undefined; await admin.end();
  const cleanup = new Pool({ connectionString: connectionString(config, true, "postgres") });
  await cleanup.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`); await cleanup.end(); await native.stop(); await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const task = await createTask(users[1], project, { title: "Fixed version validation", description: "", acceptance: "Run an actual check on captured working bytes" });
  await startRun(users[1], task.id, { repositoryId: imported.id, baseSha: imported.baseSha, prompt: "SQL fixture admission", expectedVersion: task.version, idempotencyKey: randomUUID() });
  const claim = await store.claim(executor, "native"); assert.ok(claim);
  // Provision source directly: these tests exercise validation processes, not Pi inference.
  const workspace = await createWorkspace(root, claim.workspace.id, source, imported.baseSha);
  await writeFile(path.join(workspace.checkout, "code.txt"), "working\n");
  await store.running(executor, claim.run.id, claim.run.epoch);
  // Like executeClaim, measure before finish revokes the workspace epoch.
  await store.recordWorkspaceUsage(claim.workspace.id, claim.run.epoch, await measureWorkspace(root, claim.workspace.id));
  await store.finish(executor, claim.run.id, claim.run.epoch, "completed", { kind: "validation-source-fixture" });
  const run = (await runDetail(users[1], claim.run.id)).run;
  const requested = await requestSnapshot(users[1], run.id, { expectedRevision: run.revision, idempotencyKey: randomUUID(), note: "Validate exact working bytes" });
  const captured = await captureSnapshot(root, { id: requested.snapshotId, runId: run.id, workspaceId: workspace.id, repositoryId: imported.id, baseSha: imported.baseSha, note: "Validate exact working bytes",
    context: { title: task.title, description: "", acceptance: task.acceptance, prompt: claim.run.prompt, status: "completed" } });
  await store.completeSnapshot(requested.snapshotId, captured.manifestHash, snapshotSummary(captured.manifest), null);
  return { task, snapshotId: requested.snapshotId as string, captured, workspace };
}
const commands = (args: string[], timeoutSeconds = 10): ValidationConfig => ({ version: 1, steps: [{ tool: "node", args, timeoutSeconds }] });
async function profile(configuration = commands(["check.cjs"])) {
  return (await createValidationProfile(users[0], project, { repositoryId: imported.id, name: "Actual checks", config: configuration, idempotencyKey: randomUUID() })).profileId as string;
}
async function claimCheck(snapshotId: string, profileId: string) {
  const requested = await requestValidation(users[1], snapshotId, { profileId, idempotencyKey: randomUUID() });
  const claim = await store.claimValidation(executor); assert.ok(claim); assert.equal(claim.id, requested.validationId); return claim;
}

test("maintainer-only immutable configurations validate at HTTP and SQL boundaries; project scope and MFA are enforced", async () => {
  const input = { repositoryId: imported.id, name: "Version one", config: commands(["--test"]), idempotencyKey: randomUUID() };
  for (const actor of [users[1], users[2], users[4]]) await assert.rejects(createValidationProfile(actor, project, input), /forbidden|not_found/);
  const created = await createValidationProfile(users[0], project, input);
  assert.equal((await createValidationProfile(users[0], project, input)).profileId, created.profileId);
  await assert.rejects(createValidationProfile(users[0], project, { ...input, name: "Changed" }), /idempotency_conflict/);
  await assert.rejects(asUser(users[0], db => db.query("UPDATE collab.validation_profiles SET name='tamper' WHERE id=$1", [created.profileId])), /permission denied/);
  for (const invalid of [null, {}, { version: 1, steps: [] }, { version: 1, steps: [{ tool: "sh", args: ["x"], timeoutSeconds: 10 }] }, { version: 1, steps: [{ tool: "node", args: ["x\ny"], timeoutSeconds: 10 }] }]) {
    assert.equal(validationConfig.safeParse(invalid).success, false);
    await assert.rejects(asUser(users[0], db => db.query("SELECT collab.create_validation_profile($1,$2,'Invalid',$3,$4)", [project, imported.id, JSON.stringify(invalid), randomUUID()])), /invalid_validation/);
  }
  await admin.query("UPDATE collab.memberships SET role='admin' WHERE organization_id=$1 AND user_id=$2", [organization, users[3]]);
  await assert.rejects(createValidationProfile(users[3], project, input), /mfa_required/);
  await admin.query("UPDATE collab.memberships SET role='member' WHERE organization_id=$1 AND user_id=$2", [organization, users[3]]);
  await assert.rejects(listValidationProfiles(users[4], project), /not found/i);
});

test("concurrent idempotent admission and competing executors create one actual check, with exact snapshot and environment evidence", async () => {
  const f = await fixture(), profileId = await profile(), input = { profileId, idempotencyKey: randomUUID() };
  const accepted = await Promise.all(Array.from({ length: 20 }, () => requestValidation(users[1], f.snapshotId, input)));
  assert.equal(new Set(accepted.map(item => item.validationId)).size, 1);
  await assert.rejects(requestValidation(users[1], f.snapshotId, { ...input, profileId: await profile() }), /idempotency_conflict/);
  for (const actor of [users[2], users[4]]) await assert.rejects(requestValidation(actor, f.snapshotId, { profileId, idempotencyKey: randomUUID() }), /forbidden|not_found/);
  const claims = (await Promise.all(Array.from({ length: 6 }, () => store.claimValidation(randomUUID())))).filter(value => value !== null);
  assert.equal(claims.length, 1); const claim = claims[0];
  process.env.VALIDATION_PRIVATE_FIXTURE = "must-not-inherit";
  try { assert.equal(await executeValidation(store, claim, root, undefined, 100), "passed"); } finally { delete process.env.VALIDATION_PRIVATE_FIXTURE; }
  const detail = (await validationDetail(users[2], claim.id)).validation, evidence = detail.evidence;
  assert.equal(evidence.manifestHash, f.captured.manifestHash); assert.equal(evidence.worktreeCommit, f.captured.manifest.worktreeCommit);
  assert.notEqual(evidence.worktreeCommit, f.captured.manifest.exportedHead); assert.equal(evidence.steps[0].exitCode, 0); assert.equal(evidence.steps[0].sourceUnchanged, true);
  assert.match(evidence.configHash, /^[a-f0-9]{64}$/); assert.match(evidence.environment.nodeHash, /^[a-f0-9]{64}$/); assert.ok(evidence.steps[0].outputBytes > 0);
  assert.equal(JSON.stringify(evidence).includes("actual test passed"), false); assert.equal(JSON.stringify(evidence).includes(root), false);
  assert.equal(await readFile(path.join(f.workspace.checkout, "code.txt"), "utf8"), "working\n");
  assert.equal((await listValidations(users[2], f.task.id)).validations.length, 1);
  await assert.rejects(validationDetail(users[4], claim.id), /不存在/); await assert.rejects(listValidations(users[4], f.task.id), /不存在/);
  await assert.rejects(validateSnapshot(root, claim, new AbortController().signal), /EEXIST/);
  assert.equal(await store.finishValidation(claim, "failed", null, "late_callback"), "passed");
  await assert.rejects(store.finishValidation({ ...claim, epoch: "2" }, "passed", evidence, null), /validation_lease_lost/);
});

test("cross-project profiles and incomplete or mismatched evidence cannot authorize a passing check", async () => {
  const f = await fixture(), other = (await createProject(users[0], { organizationId: organization, name: "Different project", description: "" })).id;
  const otherRepo = await importLocalRepository(admin, root, { projectId: other, actorId: users[0], name: "Other repository", source });
  const otherProfile = await createValidationProfile(users[0], other, { repositoryId: otherRepo.id, name: "Other check", config: commands(["check.cjs"]), idempotencyKey: randomUUID() });
  await assert.rejects(requestValidation(users[1], f.snapshotId, { profileId: otherProfile.profileId, idempotencyKey: randomUUID() }), /validation_source_unavailable/);
  const claim = await claimCheck(f.snapshotId, await profile());
  await assert.rejects(asUser(users[1], db => db.query("UPDATE collab.validations SET status='passed' WHERE id=$1", [claim.id])), /permission denied/);
  await assert.rejects(asUser(users[1], db => db.query("SELECT collab_worker.finish_validation($1,$2,$3,'passed',NULL,NULL)", [executor, claim.id, claim.epoch])), /permission denied/);
  await assert.rejects(store.finishValidation(claim, "passed", null, null), /invalid_validation/);
  const evidence = await validateSnapshot(root, claim, new AbortController().signal);
  for (const invalid of [
    { ...evidence, manifestHash: "a".repeat(64) },
    { ...evidence, worktreeCommit: "" },
    { ...evidence, steps: [] },
    { ...evidence, steps: [{ ...evidence.steps[0], args: ["different.cjs"] }] },
    { ...evidence, steps: [{ ...evidence.steps[0], cleanupConfirmed: false }] },
    { ...evidence, steps: [{ ...evidence.steps[0], sourceUnchanged: false }] },
  ]) await assert.rejects(store.finishValidation(claim, "passed", invalid, null), /invalid_validation/);
  assert.equal(await store.finishValidation(claim, "passed", evidence, null), "passed");
});

test("nonzero exit, timeout, excessive output and changed working code cannot produce passing evidence", { timeout: 45000 }, async () => {
  for (const [args, seconds, error] of [
    [["-e", "process.exit(7)"], 10, "validation_nonzero_exit"],
    [["-e", "setInterval(()=>{},100)"], 1, "validation_timeout"],
    [["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},100)"], 1, "validation_timeout"],
    [["-e", "require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},100)'],{stdio:'ignore'}).unref()"], 10, "validation_descendants_running"],
    [["-e", "process.stdout.write('x'.repeat(2*1024*1024))"], 10, "validation_output_limit"],
    [["-e", "require('fs').writeFileSync('code.txt','changed')"], 10, "validation_source_changed"],
  ] as [string[], number, string][]) {
    const f = await fixture(), claim = await claimCheck(f.snapshotId, await profile(commands(args, seconds)));
    const outcome = await executeValidation(store, claim, root, undefined, 100);
    const evidence = (await validationDetail(users[1], claim.id)).validation.evidence;
    assert.equal(outcome, "failed", JSON.stringify({ expectedFailure: error, evidence }));
    assert.equal(evidence.steps[0].error, error); assert.equal(evidence.steps[0].cleanupConfirmed, true);
  }
});

test("multi-step checks stop at first failure; npm runs with a fresh cache and no inherited credentials", async () => {
  const f = await fixture(), profileId = await profile({ version: 1, steps: [{ tool: "npm", args: ["--version"], timeoutSeconds: 10 }, ...commands(["check.cjs"]).steps] });
  const claim = await claimCheck(f.snapshotId, profileId); assert.equal(await executeValidation(store, claim, root), "passed");
  const evidence = (await validationDetail(users[1], claim.id)).validation.evidence;
  assert.equal(evidence.steps.length, 2); assert.match(evidence.environment.npmCliHash, /^[a-f0-9]{64}$/);
  const failed = await claimCheck(f.snapshotId, await profile({ version: 1, steps: [...commands(["-e", "process.exit(5)"]).steps, ...commands(["check.cjs"]).steps] }));
  assert.equal(await executeValidation(store, failed, root), "failed"); assert.equal((await validationDetail(users[1], failed.id)).validation.evidence.steps.length, 1);
});

test("cancellation waits for a real process exit and denies observers; queued cancellation is idempotent", async () => {
  const f = await fixture(), profileId = await profile(commands(["-e", "setInterval(()=>{},100)"], 30));
  const claim = await claimCheck(f.snapshotId, profileId), work = executeValidation(store, claim, root, undefined, 100);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { try { await readFile(path.join(root, "workspaces", claim.id, "workspace.json")); break; } catch { await new Promise(resolve => setTimeout(resolve, 25)); } }
  await assert.rejects(cancelValidation(users[2], claim.id), /forbidden/); await cancelValidation(users[1], claim.id);
  assert.equal(await work, "cancelled"); assert.equal(await store.heartbeatValidation(claim), false);
  const next = await requestValidation(users[1], f.snapshotId, { profileId, idempotencyKey: randomUUID() });
  assert.equal((await cancelValidation(users[1], next.validationId)).status, "cancelled");
  assert.equal((await cancelValidation(users[1], next.validationId)).status, "cancelled"); assert.equal(await store.claimValidation(executor), null);
});

test("revoke and regrant never revives a pending or active validation authority", async () => {
  const f = await fixture(), profileId = await profile();
  const pending = await requestValidation(users[1], f.snapshotId, { profileId, idempotencyKey: randomUUID() });
  const revokeRegrant = async () => {
    const version = (await admin.query("SELECT authorization_version::text AS version FROM collab.project_memberships WHERE project_id=$1 AND user_id=$2", [project, users[1]])).rows[0].version;
    const disabled = await changeProjectMember(users[0], project, users[1], { role: "developer", active: false, expectedVersion: version });
    await changeProjectMember(users[0], project, users[1], { role: "developer", active: true, expectedVersion: disabled.version });
  };
  await revokeRegrant(); assert.equal(await store.claimValidation(executor), null); assert.equal((await validationDetail(users[0], pending.validationId)).validation.status, "revoked");
  const claim = await claimCheck(f.snapshotId, profileId); await revokeRegrant();
  assert.equal(await executeValidation(store, claim, root), "revoked");
  await assert.rejects(readFile(path.join(root, "validation-executions", claim.id, "admitted.json")), /ENOENT/);
});

test("an actual database TCP cut stops the owned validation process without replaying its side effect", { timeout: 25000 }, async () => {
  const f = await fixture(), profileId = await profile(commands(["-e", "require('fs').appendFileSync(process.env.HOME+'/started',process.pid+'\\n');setInterval(()=>{},100)"], 20));
  const claim = await claimCheck(f.snapshotId, profileId), sockets = new Set<Socket>(); let online = true;
  const proxy = createServer(client => {
    if (!online) { client.destroy(); return; }
    const upstream = createConnection({ host: "127.0.0.1", port: config.databasePort });
    for (const socket of [client, upstream]) { sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket)); }
    client.pipe(upstream); upstream.pipe(client);
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const url = new URL(executorConnectionString(config, databaseName)); url.port = String((proxy.address() as { port: number }).port);
  const disconnected = new ExecutionStore(url.toString());
  let pid: number | undefined;
  try {
    const outcome = executeValidation(disconnected, claim, root, undefined, 100).then(status => ({ status }), () => ({ status: "connection_lost" }));
    const marker = path.join(root, "workspaces", claim.id, "home", "started"), deadline = Date.now() + 8000;
    while (Date.now() < deadline) { try { pid = Number((await readFile(marker, "utf8")).trim()); break; } catch { await new Promise(resolve => setTimeout(resolve, 25)); } }
    assert.ok(pid && pid > 1); process.kill(pid, 0);
    online = false; for (const socket of sockets) socket.destroy();
    assert.equal((await outcome).status, "connection_lost");
    assert.throws(() => process.kill(pid!, 0), /ESRCH/);
    assert.equal((await readFile(marker, "utf8")).trim().split("\n").length, 1);
    await admin.query("UPDATE collab.validations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [claim.id]);
    assert.equal(await store.claimValidation(randomUUID()), null); assert.equal((await validationDetail(users[0], claim.id)).validation.status, "unknown");
    // Test database reset only, to leave the actor available for independent cases.
    await admin.query("UPDATE collab.validations SET status='failed' WHERE id=$1", [claim.id]);
  } finally {
    await disconnected.close(); for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    if (pid) try { process.kill(-pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
});

test("supervisor SIGKILL preserves an unknown job and never restarts its still-live process", { timeout: 20000 }, async () => {
  const f = await fixture(), profileId = await profile(commands(["-e", "require('fs').appendFileSync(process.env.HOME+'/started',process.pid+'\\n');setInterval(()=>{},100)"], 60));
  const claim = await claimCheck(f.snapshotId, profileId);
  const child = spawn(process.execPath, ["--import", "tsx", "tests/collab/fixtures/crash-validation.ts"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  let pid: number | undefined;
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  try {
    const ready = new Promise<{ ready: boolean; pid: number }>((resolve, reject) => { child.once("message", value => resolve(value as { ready: boolean; pid: number })); child.once("exit", () => reject(new Error("Validation supervisor exited before readiness"))); });
    child.send({ connection: executorConnectionString(config, databaseName), claim, root });
    ({ pid } = await ready); assert.ok(pid > 1); child.kill("SIGKILL"); await exited;
    process.kill(pid, 0);
    await admin.query("UPDATE collab.validations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [claim.id]);
    assert.equal(await store.claimValidation(randomUUID()), null); assert.equal((await validationDetail(users[0], claim.id)).validation.status, "unknown");
    await assert.rejects(validateSnapshot(root, claim, new AbortController().signal), /EEXIST/);
    assert.equal((await readFile(path.join(root, "workspaces", claim.id, "home", "started"), "utf8")).trim().split("\n").length, 1);
    process.kill(pid, 0); // A new executor observed the unknown job without signaling it.
    await admin.query("UPDATE collab.validations SET status='failed' WHERE id=$1", [claim.id]); // Test fixture reset only.
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited;
    if (pid) try { process.kill(-pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
});

test("numeric supervisor failures are recorded as unknown without throwing from error classification", async () => {
  const f = await fixture(), profileId = await profile(), claim = await claimCheck(f.snapshotId, profileId);
  const original = store.artifactLimit.bind(store);
  store.artifactLimit = async () => {
    await exec(process.execPath, ["-e", "process.exit(23)"]);
    throw new Error("Expected child failure");
  };
  try {
    assert.equal(await executeValidation(store, claim, root), "unknown");
    const detail = await validationDetail(users[1], claim.id);
    assert.equal(detail.validation.status, "unknown");
    assert.equal(detail.validation.evidence, null);
    assert.equal(detail.validation.error_code, "validation_outcome_unknown");
    assert.equal(await store.claimValidation(randomUUID()), null);
  } finally {
    store.artifactLimit = original;
    // This fixture failed before launch. Release its deliberately unknown slot
    // only after asserting no worker can reclaim it; later tests share this DB.
    await admin.query("UPDATE collab.validations SET status='failed' WHERE id=$1 AND status='unknown'", [claim.id]);
  }
});

test("corrupt snapshot cannot launch commands; an expired or unknown attempt is never reassigned", async () => {
  const f = await fixture(), profileId = await profile(), claim = await claimCheck(f.snapshotId, profileId);
  const blob = f.captured.manifest.worktree.find(entry => entry.path === "code.txt")!.hash;
  await writeFile(path.join(root, "snapshots", f.snapshotId, "blobs", blob), "corrupt");
  assert.equal(await executeValidation(store, claim, root), "failed"); assert.equal((await validationDetail(users[1], claim.id)).validation.evidence, null);
  const fresh = await fixture(), expired = await claimCheck(fresh.snapshotId, profileId);
  await admin.query("UPDATE collab.validations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [expired.id]);
  assert.equal(await store.claimValidation(randomUUID()), null); assert.equal((await validationDetail(users[1], expired.id)).validation.status, "unknown");
  assert.equal(await store.heartbeatValidation(expired), false); assert.equal(await store.finishValidation(expired, "passed", null, null), "unknown");
  await assert.rejects(requestValidation(users[1], fresh.snapshotId, { profileId, idempotencyKey: randomUUID() }), /validation_busy/);
});
