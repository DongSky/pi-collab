import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
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
import { ExecutionStore } from "../../lib/collab/execution-store";
import { executeClaim } from "../../lib/collab/executor";
import { NativeRuntimeBackend } from "../../lib/collab/runtime/backends";
import { importLocalRepository } from "../../lib/collab/repository-import";
import { requestSnapshot, processSnapshots } from "../../lib/collab/snapshots";
import { declareWorkIntent, runWorkIntents, snapshotScopeReport } from "../../lib/collab/work-intents";
import { validIntentPath, overlappingPaths, type WorkDeclaration } from "../../lib/collab/work-intent-schema";
import { projectMap } from "../../lib/collab/project-map";
import { addDependency } from "../../lib/collab/tasks";

const config = await localConfig(), databaseName = `pi_collab_test_${randomBytes(6).toString("hex")}`, native = await startNativeDatabase(config);
Object.assign(process.env, applicationEnvironment(config), { DATABASE_URL: connectionString(config, false, databaseName) });
const admin = new Pool({ connectionString: connectionString(config, true, databaseName) }), store = new ExecutionStore(executorConnectionString(config, databaseName));
const root = await mkdtemp(path.join(tmpdir(), "pi-collab-intents-")), source = path.join(root, "source"), exec = promisify(execFile);
process.env.PI_COLLAB_DATA_DIR = root;
const org = randomUUID(), users: string[] = [];
let project: string, repository: { id: string; baseSha: string };
before(async () => {
  await migrate(config, databaseName); const provision = provisioningAuth(admin);
  for (let i = 0; i < 4; i++) users.push((await provision.api.signUpEmail({ body: { name: `Intent user ${i}`, email: `intent${i}@test.invalid`, password: randomBytes(20).toString("hex") } })).user.id);
  await admin.query("INSERT INTO collab.organizations(id,name,created_by) VALUES($1,'Intents',$2)", [org, users[0]]);
  for (let i = 0; i < 3; i++) await admin.query("INSERT INTO collab.memberships(organization_id,user_id,role) VALUES($1,$2,$3)", [org, users[i], i === 0 ? "owner" : "member"]);
  await admin.query('UPDATE public."user" SET "twoFactorEnabled"=true WHERE id=$1', [users[0]]);
  project = (await createProject(users[0], { organizationId: org, name: "Scope coordination", description: "" })).id;
  for (let i = 1; i < 3; i++) await admin.query("INSERT INTO collab.project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,$4)", [org, project, users[i], i === 1 ? "developer" : "reviewer"]);
  await mkdir(source); for (const args of [["init"], ["config", "user.name", "Intent test"], ["config", "user.email", "intent@test.invalid"]]) await exec("git", args, { cwd: source });
  for (const file of ["code.txt", "committed.txt", "delete.txt", "mode.sh"]) await writeFile(path.join(source, file), "baseline\n");
  await exec("git", ["add", "."], { cwd: source }); await exec("git", ["commit", "-m", "Baseline"], { cwd: source });
  repository = await importLocalRepository(admin, root, { projectId: project, actorId: users[0], source, name: "Scope source" });
});
afterEach(async () => {
  for (const r of (await admin.query("SELECT id FROM collab.runs WHERE status='queued'")).rows) await stopRun(users[0], r.id, { idempotencyKey: randomUUID() });
});
after(async () => {
  await store.close(); await database().end(); globalThis.__piCollabPool = undefined; await admin.end();
  const cleanup = new Pool({ connectionString: connectionString(config, true, "postgres") }); await cleanup.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`); await cleanup.end(); await native.stop(); await rm(root, { recursive: true, force: true });
});
const declaration = (paths = ["src/"]): WorkDeclaration => ({ paths, symbols: [], changeType: "feature", summary: "Expected source changes", expectedCompletion: null });
const body = (paths?: string[], revision = 0) => ({ declaration: declaration(paths), expectedRevision: revision, idempotencyKey: randomUUID() });
async function run(title: string, actor = users[1], repo = repository, projectId = project) {
  const task = await createTask(actor, projectId, { title, description: "", acceptance: "Scope is advisory" });
  return { task, ...await startRun(actor, task.id, { repositoryId: repo.id, baseSha: repo.baseSha, prompt: "Scope diagnostic", expectedVersion: task.version, idempotencyKey: randomUUID() }) };
}

test("project map shares live runs, dependencies and same-repository conflicts with reviewers, but not outsiders", async () => {
  const a = await run("Map backend"), b = await run("Map frontend", users[0]);
  await declareWorkIntent(users[1], a.runId, body(["src/"]));
  await declareWorkIntent(users[0], b.runId, body(["src/api.ts"]));
  const dependent = await createTask(users[1], project, { title: "Map dependent", description: "", acceptance: "" });
  await addDependency(users[1], dependent.id, { dependsOn: a.task.id, kind: "strict" });
  const map = await projectMap(users[2], project);
  assert.equal(map.tasks.find(t => t.id === a.task.id)?.run?.status, "queued");
  assert.equal(map.tasks.find(t => t.id === a.task.id)?.run?.repository_name, "Scope source");
  assert.equal(map.tasks.find(t => t.id === a.task.id)?.owner_active, true);
  assert.ok(map.dependencies.some(d => d.task_id === dependent.id && d.depends_on === a.task.id));
  assert.ok(map.conflicts.some(c => [c.left, c.right].includes(a.task.id) && [c.left, c.right].includes(b.task.id)));
  assert.ok(!JSON.stringify(map).includes("Scope diagnostic"));
  assert.ok(!JSON.stringify(map).includes(root));
  await assert.rejects(projectMap(users[3], project), /not found/);
  await admin.query("UPDATE collab.project_memberships SET active=false WHERE project_id=$1 AND user_id=$2", [project, users[2]]);
  try { await assert.rejects(projectMap(users[2], project), /not found/); }
  finally { await admin.query("UPDATE collab.project_memberships SET active=true WHERE project_id=$1 AND user_id=$2", [project, users[2]]); }
  await stopRun(users[1], a.runId, { idempotencyKey: randomUUID() });
  const version = (await admin.query("SELECT version FROM collab.tasks WHERE id=$1", [a.task.id])).rows[0].version;
  const next = await startRun(users[1], a.task.id, { repositoryId: repository.id, baseSha: repository.baseSha, prompt: "New map run", expectedVersion: version, idempotencyKey: randomUUID() });
  const refreshed = await projectMap(users[2], project);
  assert.equal(refreshed.tasks.find(t => t.id === a.task.id)?.run?.id, next.runId);
  assert.equal(refreshed.tasks.find(t => t.id === a.task.id)?.intent, null);
  assert.ok(!refreshed.conflicts.some(c => c.left === a.task.id || c.right === a.task.id));
});

test("path scopes match directory boundaries and conservative filesystem spelling without granting wildcard authority", () => {
  for (const value of ["src/", "src/file.ts", "文档/设计.md"]) assert.equal(validIntentPath(value), true);
  for (const value of ["/", "../", ".git/config", "src/.GIT/", "a//b", "a/../b", "src/**", "C:/x", "a\\b", "x\n"]) assert.equal(validIntentPath(value), false, value);
  assert.deepEqual(overlappingPaths(["src/api/"], ["src/apis/x.ts", "docs/"]), []);
  assert.equal(overlappingPaths(["src/"], ["SRC/api.ts"]).length, 1);
  assert.equal(overlappingPaths(["café/"], ["cafe\u0301/a"]).length, 1);
});

test("declarations are append-only, scoped, concurrently idempotent and optimistic; terminal replays cannot create late history", async () => {
  const r = await run("Versioned scope"), input = body();
  const results = await Promise.all(Array.from({ length: 15 }, () => declareWorkIntent(users[1], r.runId, input)));
  assert.equal(new Set(results.map(v => v.intentId)).size, 1); assert.equal(results.filter(v => !v.replayed).length, 1);
  await assert.rejects(declareWorkIntent(users[1], r.runId, { ...input, declaration: declaration(["other/"]) }), /idempotency_conflict/);
  const edits = await Promise.allSettled([declareWorkIntent(users[1], r.runId, body(["src/a"], 1)), declareWorkIntent(users[0], r.runId, body(["src/b"], 1))]);
  assert.equal(edits.filter(v => v.status === "fulfilled").length, 1);
  assert.equal(edits.filter(v => v.status === "rejected" && /stale_revision/.test(String(v.reason))).length, 1);
  assert.equal((await runWorkIntents(users[2], r.runId)).history.length, 2);
  for (const actor of [users[2], users[3]]) await assert.rejects(declareWorkIntent(actor, r.runId, body()), /forbidden|not_found/);
  await assert.rejects(runWorkIntents(users[3], r.runId), /不存在/);
  for (const sql of ["DELETE FROM collab.work_intents", "UPDATE collab.work_intents SET revision=9", "INSERT INTO collab.work_intents DEFAULT VALUES"]) await assert.rejects(asUser(users[1], db => db.query(sql)), /permission/);
  await stopRun(users[1], r.runId, { idempotencyKey: randomUUID() });
  assert.equal((await declareWorkIntent(users[1], r.runId, input)).replayed, true);
  await assert.rejects(declareWorkIntent(users[1], r.runId, body(["src/"], 2)), /intent_run_closed/);
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM collab.audit_events WHERE action='work_intent.declared' AND resource_id=ANY($1::text[])", [(await runWorkIntents(users[1], r.runId)).history.map(i => i.id)])).rows[0].n, 2);
});

test("database rejects malformed declarations and scope/run/task mixing; authority changes defeat stale writes", async () => {
  const r = await run("Validation scope"), other = await run("Other scope");
  for (const value of [null, { ...declaration(), paths: null }, { ...declaration(), paths: ["../secret"] }, { ...declaration(), paths: ["x\\y"] }, { ...declaration(), paths: [".GIT/config"] }, { ...declaration(), symbols: [null] }, { ...declaration(), expectedCompletion: "invalid" }, { ...declaration(), admin: true }]) {
    await assert.rejects(asUser(users[1], db => db.query("SELECT collab.declare_work_intent($1,0,$2,$3)", [r.runId, randomUUID(), value])), /invalid_work_intent/);
  }
  await assert.rejects(admin.query("INSERT INTO collab.work_intents(organization_id,project_id,task_id,run_id,revision,declared_by,declaration,idempotency_key,payload) VALUES($1,$2,$3,$4,1,$5,'{}',$6,'{}')", [org, project, other.task.id, r.runId, users[1], randomUUID()]), /foreign key/);
  await admin.query("UPDATE collab.project_memberships SET active=false,authorization_version=authorization_version+1 WHERE project_id=$1 AND user_id=$2", [project, users[1]]);
  await assert.rejects(declareWorkIntent(users[1], r.runId, body()), /not_found/);
  await admin.query("UPDATE collab.project_memberships SET active=true,authorization_version=authorization_version+1 WHERE project_id=$1 AND user_id=$2", [project, users[1]]);
  await assert.rejects(declareWorkIntent(users[1], r.runId, body()), /intent_run_closed/);
});

test("overlaps show peer evidence only for the same project/repository and newest run; disjoint paths stay quiet", async () => {
  const a = await run("API producer"), b = await run("API consumer", users[0]), c = await run("Docs writer");
  await declareWorkIntent(users[1], a.runId, body(["src/api/"]));
  await declareWorkIntent(users[0], b.runId, body(["src/api/orders.ts"]));
  await declareWorkIntent(users[1], c.runId, body(["docs/"]));
  assert.deepEqual((await runWorkIntents(users[1], a.runId)).overlaps.map(p => p.taskId), [b.task.id]);
  assert.equal((await runWorkIntents(users[1], c.runId)).overlaps.length, 0);
  const another = await importLocalRepository(admin, root, { projectId: project, actorId: users[0], source, name: "Other repository" });
  const unrelated = await run("Other repo", users[0], another); await declareWorkIntent(users[0], unrelated.runId, body(["src/api/"]));
  const otherProject = (await createProject(users[0], { organizationId: org, name: "Private scope", description: "" })).id;
  const privateRepo = await importLocalRepository(admin, root, { projectId: otherProject, actorId: users[0], source, name: "Private source" });
  const privateRun = await run("Invisible task", users[0], privateRepo, otherProject); await declareWorkIntent(users[0], privateRun.runId, body(["src/api/"]));
  assert.deepEqual((await runWorkIntents(users[1], a.runId)).overlaps.map(p => p.taskId), [b.task.id]);
  await stopRun(users[0], b.runId, { idempotencyKey: randomUUID() });
  const version = (await admin.query("SELECT version FROM collab.tasks WHERE id=$1", [b.task.id])).rows[0].version;
  await startRun(users[0], b.task.id, { repositoryId: repository.id, baseSha: repository.baseSha, prompt: "New run with no declaration", expectedVersion: version, idempotencyKey: randomUUID() });
  assert.equal((await runWorkIntents(users[1], a.runId)).overlaps.length, 0);
});

test("real Pi changes are independently compared to imported baseline, including commits, deletes, modes, staged/working/untracked bytes and excluded paths", { timeout: 30000 }, async () => {
  const r = await run("Actual scope"), intent = await declareWorkIntent(users[1], r.runId, body(["code.txt"]));
  const executor = randomUUID(), claim = await store.claim(executor, "native"); assert.ok(claim); assert.equal(claim.run.id, r.runId);
  assert.equal(await executeClaim(store, executor, claim, { dataRoot: root, backend: new NativeRuntimeBackend(), driver: async agent => {
    await agent.peer.command("bash", { command: 'printf "committed\\n" > committed.txt; git commit -am "Agent change"; printf "staged\\n" > code.txt; git add code.txt; printf "working\\n" > code.txt; rm delete.txt; chmod +x mode.sh; printf "new\\n" > untracked.txt; printf "private\\n" > .env' });
    return { kind: "real-pi-scope-diagnostic", modelInference: false };
  } }), "completed");
  await assert.rejects(declareWorkIntent(users[1], r.runId, body(["untracked.txt"], 1)), /intent_run_closed/);
  const revision = (await runDetail(users[1], r.runId)).run.revision;
  const snapshot = await requestSnapshot(users[1], r.runId, { expectedRevision: revision, idempotencyKey: randomUUID(), note: "Scope evidence" }); await processSnapshots(store, root);
  const report = await snapshotScopeReport(users[2], snapshot.snapshotId);
  assert.equal(report.intentId, intent.intentId); assert.equal(report.baseSha, repository.baseSha);
  assert.deepEqual(report.changes, [{ path: "code.txt", kind: "modified", declared: true }, { path: "committed.txt", kind: "modified", declared: false }, { path: "delete.txt", kind: "deleted", declared: false }, { path: "mode.sh", kind: "modified", declared: false }, { path: "untracked.txt", kind: "added", declared: false }]);
  assert.equal(report.undeclaredCount, 4); assert.ok(report.excluded.some(e => e.path === ".env"));
  await assert.rejects(snapshotScopeReport(users[3], snapshot.snapshotId), /不存在/);
  // A fresh restored run has sanitized Git ancestry. The report must still use
  // the imported original base, not HEAD or an agent-supplied changed-file list.
  const version = (await admin.query("SELECT version FROM collab.tasks WHERE id=$1", [r.task.id])).rows[0].version;
  const resumed = await startRun(users[1], r.task.id, { repositoryId: repository.id, baseSha: repository.baseSha, prompt: "Continue scope", snapshotId: snapshot.snapshotId, expectedVersion: version, idempotencyKey: randomUUID() });
  const next = await store.claim(executor, "native"); assert.ok(next); assert.equal(next.run.id, resumed.runId);
  assert.equal(await executeClaim(store, executor, next, { dataRoot: root, backend: new NativeRuntimeBackend(), driver: async agent => { await agent.peer.command("bash", { command: "cat code.txt" }); return { kind: "restored-scope-diagnostic" }; } }), "completed");
  const second = await requestSnapshot(users[1], resumed.runId, { expectedRevision: (await runDetail(users[1], resumed.runId)).run.revision, idempotencyKey: randomUUID(), note: "Restored scope evidence" }); await processSnapshots(store, root);
  const restored = await snapshotScopeReport(users[1], second.snapshotId);
  assert.equal(restored.intentId, null); assert.equal(restored.changeCount, 5); assert.equal(restored.undeclaredCount, 5);
  // Tampered saved bytes never produce a reassuring report.
  await writeFile(path.join(root, "snapshots", snapshot.snapshotId, "manifest.json"), "{}");
  await assert.rejects(snapshotScopeReport(users[1], snapshot.snapshotId), /不可用/);
});
