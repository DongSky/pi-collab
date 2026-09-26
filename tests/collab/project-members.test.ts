import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Pool } from "pg";
import { localConfig, applicationEnvironment, connectionString, executorConnectionString, gatewayConnectionString } from "../../scripts/local-config";
import { startNativeDatabase } from "../../scripts/native-database";
import { migrate } from "../../scripts/migrate";
import { provisioningAuth } from "../../lib/collab/auth";
import { database, asUser } from "../../lib/collab/database";
import { createProject, projectDetail, listProjects, projectAudit, audit } from "../../lib/collab/projects";
import { createTask } from "../../lib/collab/tasks";
import { addProjectMember, changeProjectMember, projectMembers, recoverProject, reassignTask } from "../../lib/collab/project-members";
import { createInvitation, acceptInvitation, changeMember, organizationDetail } from "../../lib/collab/onboarding";
import { startRun, runDetail, runFeed, runTranscript } from "../../lib/collab/runs";
import { ExecutionStore } from "../../lib/collab/execution-store";
import { GatewayStore } from "../../lib/collab/gateway/store";
import { executeClaim, type RunDriver } from "../../lib/collab/executor";
import { NativeRuntimeBackend } from "../../lib/collab/runtime/backends";
import { importLocalRepository } from "../../lib/collab/repository-import";

const config = await localConfig(), dbName = `pi_collab_test_${randomBytes(6).toString("hex")}`, native = await startNativeDatabase(config);
Object.assign(process.env, applicationEnvironment(config), { DATABASE_URL: connectionString(config, false, dbName) });
const admin = new Pool({ connectionString: connectionString(config, true, dbName) }), store = new ExecutionStore(executorConnectionString(config, dbName)), gateway = new GatewayStore(gatewayConnectionString(config, dbName));
const organization = randomUUID(), otherOrganization = randomUUID(), executor = randomUUID(), users: string[] = [];
const root = await mkdtemp(path.join(tmpdir(), "pi-collab-members-")), source = path.join(root, "source");
const email = (index: number) => `project-member${index}@test.invalid`;
async function project() {
  const p = await createProject(users[0], { organizationId: organization, name: `Project ${randomUUID()}`, description: "" });
  for (const [index, role] of [[1, "maintainer"], [2, "developer"], [3, "viewer"]] as const) await admin.query("INSERT INTO collab.project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,$4)", [organization, p.id, users[index], role]);
  return p.id as string;
}
const member = async (p: string, user: string) => (await admin.query("SELECT role,active,authorization_version::text AS version FROM collab.project_memberships WHERE project_id=$1 AND user_id=$2", [p, user])).rows[0];
async function change(p: string, user: string, role: "maintainer" | "developer" | "reviewer" | "viewer", active = true, actor = users[0]) {
  return changeProjectMember(actor, p, user, { role, active, expectedVersion: (await member(p, user)).version });
}
async function queued(p: string, user = users[2], repository?: { id: string; baseSha: string }, modelProfileId?: string) {
  const task = await createTask(user, p, { title: "Member-owned task", description: "", acceptance: "" });
  if (!repository) {
    const id = randomUUID(), baseSha = "a".repeat(40);
    await admin.query("INSERT INTO collab.repositories(id,organization_id,project_id,name,provider,base_sha,default_branch) VALUES($1,$2,$3,'Fixture','local',$4,'main')", [id, organization, p, baseSha]); repository = { id, baseSha };
  }
  const input = { repositoryId: repository.id, baseSha: repository.baseSha, prompt: "Protocol diagnostic only", expectedVersion: task.version, idempotencyKey: randomUUID(), ...(modelProfileId ? { modelProfileId } : {}) };
  const accepted = await startRun(user, task.id, input); return { task, input, accepted };
}
before(async () => {
  await migrate(config, dbName); const auth = provisioningAuth(admin);
  for (let i = 0; i < 8; i++) users.push((await auth.api.signUpEmail({ body: { name: `Member ${i}`, email: email(i), password: randomBytes(20).toString("hex") } })).user.id);
  await admin.query("INSERT INTO collab.organizations(id,name,created_by) VALUES($1,'Membership test',$2),($3,'Other',$4)", [organization, users[0], otherOrganization, users[4]]);
  for (let i = 0; i < 8; i++) await admin.query("INSERT INTO collab.memberships(organization_id,user_id,role,active) VALUES($1,$2,$3,$4)", [i === 4 ? otherOrganization : organization, users[i], i === 0 || i === 4 ? "owner" : i === 5 ? "admin" : "member", i !== 7]);
  await admin.query('UPDATE public."user" SET "twoFactorEnabled"=true WHERE id=$1', [users[0]]);
  await mkdir(source); const exec = promisify(execFile);
  for (const args of [["init"], ["config", "user.name", "Membership acceptance"], ["config", "user.email", "fixture@test.invalid"]]) await exec("git", args, { cwd: source });
  await writeFile(path.join(source, "initial.txt"), "original\n"); await exec("git", ["add", "."], { cwd: source }); await exec("git", ["commit", "-m", "Fixture"], { cwd: source });
});
after(async () => {
  await Promise.all([store.close(), gateway.close(), database().end(), admin.end()]); globalThis.__piCollabPool = undefined;
  const cleanup = new Pool({ connectionString: connectionString(config, true, "postgres") }); await cleanup.query(`DROP DATABASE "${dbName}" WITH (FORCE)`); await cleanup.end(); await native.stop(); await rm(root, { recursive: true, force: true });
});

test("project maintainers add only enabled organization members; web SQL cannot bypass audited grants", async () => {
  const p = await project();
  await assert.rejects(projectMembers(users[2], p), /permission/);
  await assert.rejects(projectMembers(users[4], p), /not found/);
  for (const actor of [users[2], users[3], users[4], users[5]]) await assert.rejects(addProjectMember(actor, p, { email: email(6), role: "maintainer" }), /forbidden|not_found/);
  for (const index of [4, 7]) await assert.rejects(addProjectMember(users[1], p, { email: email(index), role: "developer" }), /project_member_ineligible/);
  await assert.rejects(asUser(users[1], db => db.query("INSERT INTO collab.project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,'maintainer')", [organization, p, users[6]])), /row-level security/);
  const added = await addProjectMember(users[1], p, { email: email(6), role: "reviewer" }); assert.equal(added.userId, users[6]);
  await assert.rejects(addProjectMember(users[1], p, { email: email(6), role: "maintainer" }), /project_member_exists/);
  assert.equal((await member(p, users[6])).role, "reviewer");
  assert.equal((await admin.query("SELECT 1 FROM collab.audit_events WHERE project_id=$1 AND action='project.member_added' AND actor_id=$2", [p, users[1]])).rowCount, 1);
});

test("optimistic membership versions reject stale tabs; no-op saves do not revoke authority", async () => {
  const p = await project(), version = (await member(p, users[2])).version;
  const results = await Promise.allSettled(["reviewer", "viewer"].map(role => changeProjectMember(users[1], p, users[2], { role: role as "viewer" | "reviewer", active: true, expectedVersion: version })));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.match((results.find(result => result.status === "rejected") as PromiseRejectedResult).reason.message, /stale_membership/);
  const current = await member(p, users[2]); assert.equal(current.version, "2");
  const unchanged = await changeProjectMember(users[1], p, users[2], { role: current.role, active: true, expectedVersion: current.version }); assert.equal(unchanged.changed, false);
  assert.equal((await member(p, users[2])).version, "2");
  await assert.rejects(asUser(users[1], db => db.query("UPDATE collab.project_memberships SET role='maintainer' WHERE project_id=$1 AND user_id=$2", [p, users[2]])), /permission/);
});

test("organization administrators still require MFA when they have an explicit project maintainer role", async () => {
  const p = await project(); await addProjectMember(users[0], p, { email: email(5), role: "maintainer" });
  assert.equal((await projectDetail(users[5], p)).project.role, "maintainer");
  await assert.rejects(changeProjectMember(users[5], p, users[2], { role: "viewer", active: true, expectedVersion: "1" }), /mfa_required/);
  await assert.rejects(addProjectMember(users[5], p, { email: email(6), role: "developer" }), /mfa_required/);
});

test("audit pagination stays within the authorized project and is revoked along with project access", async () => {
  const p = await project();
  await asUser(users[0], async db => { for (let i = 0; i < 61; i++) await audit(db, organization, p, users[0], "audit.protocol_fixture", String(i), { fixture: true }); });
  const first = await projectAudit(users[3], p); assert.equal(first.events.length, 50); assert.ok(first.nextCursor);
  const second = await projectAudit(users[3], p, first.nextCursor); assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.events, ...second.events].map(event => event.id)).size, 62);
  for (const actor of [users[4], users[5]]) await assert.rejects(projectAudit(actor, p), /not found/);
  assert.throws(() => projectAudit(users[3], p, "9223372036854775808"), /游标/);
  assert.throws(() => projectAudit(users[3], p, ""), /游标/);
  await change(p, users[3], "viewer", false); await assert.rejects(projectAudit(users[3], p), /not found/);
});

test("two maintainers concurrently leaving cannot orphan a project", async () => {
  const p = await project();
  const results = await Promise.allSettled([users[0], users[1]].map(user => changeProjectMember(user, p, user, { role: "developer", active: true, expectedVersion: "1" })));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.match((results.find(result => result.status === "rejected") as PromiseRejectedResult).reason.message, /last_maintainer/);
  assert.equal((await admin.query("SELECT 1 FROM collab.project_memberships WHERE project_id=$1 AND active AND role='maintainer'", [p])).rowCount, 1);
});

test("disabled project members retain task history but lose content access and cannot be restored by invitations", async () => {
  const p = await project(), task = await createTask(users[2], p, { title: "Retained history", description: "", acceptance: "" });
  const invite = await createInvitation(users[0], organization, { email: email(2), role: "member", projectId: p, projectRole: "maintainer" });
  await change(p, users[2], "developer", false);
  assert.equal((await listProjects(users[2])).projects.some(project => project.id === p), false);
  await assert.rejects(projectDetail(users[2], p), /not found/); await assert.rejects(runFeed(users[2], p), /not found/);
  const detail = await projectDetail(users[0], p); assert.equal(detail.tasks.find(t => t.id === task.id).owner_name, "Member 2"); assert.equal(detail.tasks.find(t => t.id === task.id).owner_active, false);
  await assert.rejects(acceptInvitation(users[2], { token: new URL(invite.url).hash.slice(1), email: email(2) }), /project_membership_disabled/);
  await assert.rejects(createTask(users[0], p, { title: "Inactive assignee", description: "", acceptance: "", ownerId: users[2] }), /active project/);
  await change(p, users[2], "developer", true);
  assert.equal((await projectDetail(users[2], p)).project.id, p); assert.equal((await member(p, users[2])).version, "3");
});

test("removing and regranting an inviter cannot revive their outstanding project invitation", async () => {
  const p = await project();
  const invite = await createInvitation(users[0], organization, { email: email(6), role: "member", projectId: p, projectRole: "developer" });
  await change(p, users[0], "developer", true, users[1]);
  await change(p, users[0], "maintainer", true, users[1]);
  await assert.rejects(acceptInvitation(users[6], { token: new URL(invite.url).hash.slice(1), email: email(6) }), /邀请已失效/);
});

test("invitation acceptance racing issuer revocation shares the organization-first lock order", async () => {
  const p = await project(), invite = await createInvitation(users[0], organization, { email: email(6), role: "member", projectId: p, projectRole: "developer" });
  const client = await admin.connect(); let acceptance: Promise<unknown> | undefined;
  try {
    await client.query("BEGIN"); await client.query("SET LOCAL statement_timeout='3s'");
    await client.query("SELECT set_config('collab.user_id',$1,true)", [users[0]]);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,811))", [organization]);
    acceptance = acceptInvitation(users[6], { token: new URL(invite.url).hash.slice(1), email: email(6) }).then(() => "accepted", error => (error as Error).message);
    const deadline = Date.now() + 2000;
    while (!(await admin.query("SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=current_database() AND l.locktype='advisory' AND NOT l.granted")).rowCount) {
      assert.ok(Date.now() < deadline, "acceptance must wait for the organization lock"); await new Promise(resolve => setTimeout(resolve, 10));
    }
    await client.query("SELECT collab.change_project_member($1,$2,'developer',true,1)", [p, users[0]]);
    await client.query("COMMIT"); assert.equal(await acceptance, "invitation_unavailable");
  } finally { await client.query("ROLLBACK"); client.release(); await acceptance; }
});

test("project revocation cancels queued work and stops active work while another project remains authorized", async () => {
  const p = await project(), other = await project(), profile = randomUUID();
  await admin.query("INSERT INTO collab.model_profiles(id,organization_id,project_id,name,model_id,api,context_window,max_output_tokens,run_token_limit,run_request_limit) VALUES($1,$2,$3,'Fixture','fixture','openai-responses',128000,512,1000000,8)", [profile, organization, p]);
  const first = await queued(p, users[2], undefined, profile), second = await queued(p), independent = await queued(other);
  const claim = await store.claim(executor, "native"); assert.ok(claim); assert.equal(claim.run.id, first.accepted.runId);
  await store.running(executor, claim.run.id, claim.run.epoch);
  const hash = createHash("sha256").update(randomBytes(32)).digest("hex"); await store.issueModelCapability(executor, claim.run.id, claim.run.epoch, hash);
  assert.equal(await gateway.valid(hash), true); const access = (await runFeed(users[2], p)).authorizationVersion;
  await change(p, users[2], "viewer");
  assert.notEqual((await runFeed(users[2], p)).authorizationVersion, access);
  assert.equal((await runDetail(users[0], first.accepted.runId)).run.status, "stopping");
  assert.equal((await runDetail(users[0], second.accepted.runId)).run.status, "cancelled");
  assert.equal((await runDetail(users[0], independent.accepted.runId)).run.status, "queued");
  assert.equal(await gateway.valid(hash), false); await assert.rejects(store.output(executor, claim.run.id, claim.run.epoch, randomUUID(), []), /run_not_executable/);
  await change(p, users[2], "developer");
  assert.equal((await admin.query("SELECT collab_worker.authorized($1) AS allowed", [claim.run.id])).rows[0].allowed, false);
  assert.equal(await gateway.valid(hash), false);
  await store.finish(executor, claim.run.id, claim.run.epoch, "cancelled", {});
  const next = await store.claim(executor, "native"); assert.ok(next); assert.equal(next.run.id, independent.accepted.runId); await store.finish(executor, next.run.id, next.run.epoch, "cancelled", {});
});

test("revoking two active runs does not deadlock against one of them finishing and emitting project events", async () => {
  const p = await project(); await queued(p); await queued(p);
  const claims = [await store.claim(executor, "native"), await store.claim(executor, "native")]; assert.ok(claims[0] && claims[1]);
  const runs = claims.filter(Boolean).sort((a, b) => a!.run.id.localeCompare(b!.run.id));
  for (const run of runs) await store.running(executor, run!.run.id, run!.run.epoch);
  const client = await admin.connect(); let revocation: Promise<unknown> | undefined;
  try {
    await client.query("BEGIN"); await client.query("SET LOCAL statement_timeout='3s'");
    await client.query("SELECT 1 FROM collab.runs WHERE id=$1 FOR UPDATE", [runs[1]!.run.id]);
    revocation = change(p, users[2], "viewer").then(() => "revoked", error => (error as Error).message);
    const deadline = Date.now() + 2000;
    while (!(await admin.query("SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=current_database() AND l.locktype='transactionid' AND NOT l.granted")).rowCount) {
      assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10));
    }
    await client.query("SELECT collab_worker.finish($1,$2,$3,'completed','{}')", [executor, runs[1]!.run.id, runs[1]!.run.epoch]);
    await client.query("COMMIT"); assert.equal(await revocation, "revoked");
    assert.equal((await runDetail(users[0], runs[1]!.run.id)).run.status, "completed");
    await store.finish(executor, runs[0]!.run.id, runs[0]!.run.epoch, "cancelled", {});
  } finally { await client.query("ROLLBACK"); client.release(); await revocation; }
});

test("emergency project access requires organization admin, MFA and reason; governance does not disclose contents", async () => {
  const p = await project(); await change(p, users[0], "viewer", true, users[1]);
  await changeMember(users[0], organization, users[1], { role: "member", active: false });
  try {
    await assert.rejects(projectDetail(users[5], p), /not found/);
    const governance = (await organizationDetail(users[5], organization)).governance.find((row: { id: string }) => row.id === p);
    assert.equal(governance.maintainers, 0); assert.equal(governance.ownRole, null); assert.deepEqual(Object.keys(governance).sort(), ["id", "maintainers", "name", "ownRole"]);
    for (const actor of [users[2], users[4]]) await assert.rejects(recoverProject(actor, p, { reason: "Restore the orphaned project for review" }), /not_found/);
    await assert.rejects(recoverProject(users[5], p, { reason: "Restore the orphaned project for review" }), /mfa_required/);
    await admin.query('UPDATE public."user" SET "twoFactorEnabled"=true WHERE id=$1', [users[5]]);
    assert.throws(() => recoverProject(users[5], p, { reason: "short" }));
    await assert.rejects(asUser(users[5], db => db.query("SELECT collab.recover_project($1,'short')", [p])), /recovery_reason_required/);
    await recoverProject(users[5], p, { reason: "Restore the orphaned project for review" });
    assert.equal((await projectDetail(users[5], p)).project.role, "maintainer");
    const audit = (await admin.query("SELECT detail FROM collab.audit_events WHERE project_id=$1 AND action='project.emergency_access'", [p])).rows[0]; assert.equal(audit.detail.reason, "Restore the orphaned project for review");
    await assert.rejects(recoverProject(users[5], p, { reason: "Already a maintainer, not needed" }), /already_maintainer/);
  } finally { await changeMember(users[0], organization, users[1], { role: "member", active: true }); }
});

test("task handoff stops old authority and requires a new start; direct SQL cannot transfer ownership", async () => {
  const p = await project(), { task, accepted, input } = await queued(p), claim = await store.claim(executor, "native"); assert.ok(claim);
  await store.running(executor, claim.run.id, claim.run.epoch);
  const current = (await admin.query("SELECT version FROM collab.tasks WHERE id=$1", [task.id])).rows[0];
  await assert.rejects(reassignTask(users[2], task.id, { ownerId: users[1], expectedVersion: current.version }), /forbidden/);
  await assert.rejects(reassignTask(users[0], task.id, { ownerId: users[3], expectedVersion: current.version }), /invalid_owner/);
  await assert.rejects(asUser(users[0], db => db.query("UPDATE collab.tasks SET owner_id=$1 WHERE id=$2", [users[1], task.id])), /permission/);
  await reassignTask(users[0], task.id, { ownerId: users[1], expectedVersion: current.version });
  assert.equal((await runDetail(users[0], accepted.runId)).run.status, "stopping");
  const version = (await admin.query("SELECT owner_id,version FROM collab.tasks WHERE id=$1", [task.id])).rows[0]; assert.equal(version.owner_id, users[1]);
  await assert.rejects(startRun(users[1], task.id, { ...input, expectedVersion: version.version, idempotencyKey: randomUUID() }), /task_busy/);
  await assert.rejects(startRun(users[2], task.id, { ...input, expectedVersion: version.version, idempotencyKey: randomUUID() }), /forbidden/);
  await store.finish(executor, claim.run.id, claim.run.epoch, "cancelled", {});
  const ready = (await admin.query("SELECT version FROM collab.tasks WHERE id=$1", [task.id])).rows[0];
  const fresh = await startRun(users[1], task.id, { ...input, expectedVersion: ready.version, idempotencyKey: randomUUID() });
  assert.notEqual(fresh.runId, claim.run.id); const next = await store.claim(executor, "native"); assert.ok(next); assert.notEqual(next.workspace.id, claim.workspace.id); await store.finish(executor, next.run.id, next.run.epoch, "cancelled", {});
});

test("task reassignment and executor completion use compatible locks and reject stale assignment versions", async () => {
  const p = await project(), { task } = await queued(p), claim = await store.claim(executor, "native"); assert.ok(claim); await store.running(executor, claim.run.id, claim.run.epoch);
  const version = (await admin.query("SELECT version FROM collab.tasks WHERE id=$1", [task.id])).rows[0].version;
  const client = await admin.connect(); let reassignment: Promise<unknown> | undefined;
  try {
    await client.query("BEGIN"); await client.query("SET LOCAL statement_timeout='3s'"); await client.query("SELECT 1 FROM collab.runs WHERE id=$1 FOR UPDATE", [claim.run.id]);
    reassignment = reassignTask(users[0], task.id, { ownerId: users[1], expectedVersion: version }).then(() => "updated", error => (error as Error).message);
    await new Promise(resolve => setTimeout(resolve, 100));
    await client.query("SELECT collab_worker.finish($1,$2,$3,'completed','{}')", [executor, claim.run.id, claim.run.epoch]); await client.query("COMMIT");
    assert.equal(await reassignment, "stale_revision");
  } finally { await client.query("ROLLBACK"); client.release(); await reassignment; }
});

test("project removal stops a real Pi process and ordinary tool descendant before workspace release", { timeout: 25_000 }, async () => {
  const p = await project(), imported = await importLocalRepository(admin, root, { projectId: p, actorId: users[0], name: "Fixture", source });
  await queued(p, users[2], imported); const claim = await store.claim(executor, "native"); assert.ok(claim);
  let pid: number | undefined;
  const driver: RunDriver = async agent => {
    pid = agent.peer.pid;
    await agent.peer.command("bash", { command: 'node -e \'const fs=require("fs");fs.writeFileSync("ready","1");setTimeout(()=>fs.writeFileSync("must-not-write","1"),10000);\'' }); return { kind: "rpc-diagnostic" };
  };
  const result = executeClaim(store, executor, claim, { dataRoot: root, backend: new NativeRuntimeBackend(), driver, heartbeatMs: 50 });
  const ready = path.join(root, "workspaces", claim.workspace.id, "checkout/ready"), deadline = Date.now() + 8000;
  for (;;) { try { await access(ready); break; } catch {} assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 25)); }
  await change(p, users[2], "developer", false);
  assert.equal(await result, "cancelled"); assert.ok(pid); assert.throws(() => process.kill(-pid!, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
  await assert.rejects(runTranscript(users[2], claim.run.id), /不存在/);
  assert.equal((await runDetail(users[0], claim.run.id)).workspace.status, "stopped");
  await assert.rejects(access(path.join(root, "workspaces", claim.workspace.id, "checkout/must-not-write")));
});
