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
import { createTask, addDependency } from "../../lib/collab/tasks";
import { startRun, stopRun } from "../../lib/collab/runs";
import { ExecutionStore } from "../../lib/collab/execution-store";
import { importLocalRepository } from "../../lib/collab/repository-import";
import { configureScheduling, schedulingContext } from "../../lib/collab/scheduling";
import { capacityContext, configureCapacity } from "../../lib/collab/capacity";

const config = await localConfig(), dbName = `pi_collab_test_${randomBytes(6).toString("hex")}`, native = await startNativeDatabase(config);
Object.assign(process.env, applicationEnvironment(config), { DATABASE_URL: connectionString(config, false, dbName) });
const admin = new Pool({ connectionString: connectionString(config, true, dbName) }), worker = new ExecutionStore(executorConnectionString(config, dbName));
const root = await mkdtemp(path.join(tmpdir(), "pi-collab-scheduling-")), org = randomUUID(), executor = randomUUID(), users: string[] = [];
const projects: string[] = [], repos: { id: string; baseSha: string }[] = [];
before(async () => {
  await migrate(config, dbName); const auth = provisioningAuth(admin);
  for (let i = 0; i < 4; i++) users.push((await auth.api.signUpEmail({ body: { name: `Queue user ${i}`, email: `queue${i}@test.invalid`, password: randomBytes(20).toString("hex") } })).user.id);
  await admin.query("INSERT INTO collab.organizations(id,name,created_by) VALUES($1,'Scheduling test',$2)", [org, users[0]]);
  for (let i = 0; i < 3; i++) await admin.query("INSERT INTO collab.memberships(organization_id,user_id,role) VALUES($1,$2,$3)", [org, users[i], i ? "member" : "owner"]);
  await admin.query('UPDATE public."user" SET "twoFactorEnabled"=true WHERE id=$1', [users[0]]);
  const source = path.join(root, "source"), exec = promisify(execFile); await mkdir(source);
  for (const args of [["init"], ["config", "user.name", "Scheduler fixture"], ["config", "user.email", "queue@test.invalid"]]) await exec("git", args, { cwd: source });
  await writeFile(path.join(source, "file.txt"), "fixed baseline"); await exec("git", ["add", "."], { cwd: source }); await exec("git", ["commit", "-m", "Baseline"], { cwd: source });
  for (let i = 0; i < 2; i++) {
    const project = (await createProject(users[0], { organizationId: org, name: `Queue project ${i}`, description: "" })).id; projects.push(project);
    for (let u = 1; u < 3; u++) await admin.query("INSERT INTO collab.project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,'developer')", [org, project, users[u]]);
    repos.push(await importLocalRepository(admin, root, { projectId: project, actorId: users[0], source, name: "Queue repository" }));
  }
});
afterEach(async () => {
  for (const r of (await admin.query("SELECT id,epoch::text,status FROM collab.runs WHERE status IN ('queued','starting','running')")).rows) {
    if (r.status === "queued") await stopRun(users[0], r.id, { idempotencyKey: randomUUID() });
    else await worker.finish(executor, r.id, r.epoch, "cancelled", {});
  }
});
after(async () => {
  await worker.close(); await database().end(); globalThis.__piCollabPool = undefined; await admin.end();
  const cleanup = new Pool({ connectionString: connectionString(config, true, "postgres") }); await cleanup.query(`DROP DATABASE "${dbName}" WITH (FORCE)`); await cleanup.end(); await native.stop(); await rm(root, { recursive: true, force: true });
});
const settings = (version: number, priority: number) => ({ expectedVersion: version, priority, reason: "Set bounded team queue priority", idempotencyKey: randomUUID() });
async function priority(index: number, value: number) { const state = await schedulingContext(users[0], projects[index]); return configureScheduling(users[0], projects[index], settings(state.version, value)); }
async function enqueue(index = 0, owner = users[1], minutes = 0, dependency?: string) {
  const task = await createTask(owner, projects[index], { title: `Queued work ${randomUUID()}`, description: "", acceptance: "Keep isolated workspace" });
  if (dependency) await addDependency(owner, task.id, { dependsOn: dependency, kind: "strict" });
  const version = (await admin.query("SELECT version FROM collab.tasks WHERE id=$1", [task.id])).rows[0].version;
  const run = await startRun(owner, task.id, { repositoryId: repos[index].id, baseSha: repos[index].baseSha, expectedVersion: version, prompt: "Local scheduling fixture", idempotencyKey: randomUUID() });
  await admin.query("UPDATE collab.runs SET created_at=now()-($2::integer*interval '1 minute') WHERE id=$1", [run.runId, minutes]);
  return { ...run, task };
}
async function claim() { const c = await worker.claim(executor, "native"); if (c) await worker.recordWorkspaceUsage(c.workspace.id, c.run.epoch, { bytes: 0, error: null }); return c; }

test("scheduling policy is versioned, idempotent, scoped, MFA-protected and auditable", async () => {
  const request = settings(0, 2);
  await assert.rejects(configureScheduling(users[1], projects[0], request), /forbidden/);
  await assert.rejects(schedulingContext(users[3], projects[0]), /not_found/);
  await admin.query("UPDATE collab.project_memberships SET role='maintainer' WHERE project_id=$1 AND user_id=$2", [projects[0], users[2]]);
  await assert.rejects(configureScheduling(users[2], projects[0], request), /mfa_required/);
  await admin.query("UPDATE collab.project_memberships SET role='developer' WHERE project_id=$1 AND user_id=$2", [projects[0], users[2]]);
  assert.deepEqual(await configureScheduling(users[0], projects[0], request), { version: 1, priority: 2 });
  assert.deepEqual(await configureScheduling(users[0], projects[0], request), { version: 1, priority: 2 });
  await assert.rejects(configureScheduling(users[0], projects[0], { ...request, priority: 0 }), /idempotency_conflict/);
  await assert.rejects(configureScheduling(users[0], projects[0], settings(0, 0)), /stale_revision/);
  await assert.rejects(asUser(users[0], db => db.query("UPDATE collab.project_scheduling SET priority=0")), /permission/);
  assert.equal((await admin.query("SELECT count(*)::int n FROM collab.audit_events WHERE action='scheduling.configured' AND project_id=$1", [projects[0]])).rows[0].n, 1);
});

test("the real atomic claim combines project priority with waiting time across projects", async () => {
  await priority(0, 0); await priority(1, 2);
  const low = await enqueue(0, users[1], 1), high = await enqueue(1, users[2]);
  assert.equal((await claim())?.run.id, high.runId);
  assert.equal((await claim())?.run.id, low.runId);
  const old = await enqueue(0, users[1], 12), fresh = await enqueue(1, users[2]);
  assert.equal((await claim())?.run.id, old.runId, "Enough waiting outranks bounded priority credit");
  assert.equal((await claim())?.run.id, fresh.runId);
});

test("member fair share precedes priority until overdue eligible work receives oldest-first protection", async () => {
  await priority(0, 2); await priority(1, 0);
  const active = await enqueue(0, users[1]); assert.equal((await claim())?.run.id, active.runId);
  const busy = await enqueue(0, users[1], 2), idle = await enqueue(1, users[2]);
  const listing = await schedulingContext(users[1], projects[0]);
  assert.deepEqual(listing.queue.map((q: { runId: string }) => q.runId), [busy.runId]);
  assert.equal((await claim())?.run.id, idle.runId, "Fresh idle member gets a fair share");
  assert.equal((await claim())?.run.id, busy.runId);
  // Busy member remains eligible in another project (quota still per project).
  const overdue = await enqueue(1, users[1], 31), fresh = await enqueue(0, users[2]);
  assert.equal((await schedulingContext(users[1], projects[1])).queue[0].protected, true);
  assert.equal((await claim())?.run.id, overdue.runId, "New idle work cannot starve an overdue eligible request");
  assert.equal((await claim())?.run.id, fresh.runId);
});

test("priority and waiting protection never bypass strict dependencies or configured member capacity", async () => {
  await priority(0, 2); await priority(1, 0);
  const cap = await capacityContext(users[0], projects[0]);
  await configureCapacity(users[0], projects[0], { expectedVersion: cap.version, idempotencyKey: randomUUID(), reason: "Verify priority keeps capacity limits", projectRuns: 8, memberRuns: 1, dailyTokens: 10000000, dailyUsd: null, prices: [] });
  const upstream = await createTask(users[1], projects[0], { title: "Unpublished dependency", description: "", acceptance: "Publish immutable output" });
  const dependent = await enqueue(0, users[1], 40, upstream.id), active = await enqueue(0, users[1]);
  assert.equal((await claim())?.run.id, active.runId);
  const capped = await enqueue(0, users[1], 35), eligible = await enqueue(1, users[2]);
  assert.equal((await claim())?.run.id, eligible.runId); assert.equal(await claim(), null);
  const state = await schedulingContext(users[1], projects[0]);
  assert.equal(state.queue.find((q: { runId: string }) => q.runId === dependent.runId).dependencyState, "waiting");
  assert.equal(state.queue.find((q: { runId: string }) => q.runId === capped.runId).capacityAvailable, false);
});
