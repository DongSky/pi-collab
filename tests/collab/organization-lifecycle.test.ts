import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { localConfig, applicationEnvironment, connectionString } from "../../scripts/local-config";
import { startNativeDatabase } from "../../scripts/native-database";
import { migrate } from "../../scripts/migrate";
import { provisioningAuth } from "../../lib/collab/auth";
import { database, asUser } from "../../lib/collab/database";
import { createProject, projectDetail, listProjects } from "../../lib/collab/projects";
import { createTask } from "../../lib/collab/tasks";
import { organizationAction, organizationDetail, changeMember, createInvitation, acceptInvitation } from "../../lib/collab/onboarding";
import { startRun, stopRun } from "../../lib/collab/runs";

const config = await localConfig(), dbName = `pi_collab_test_${randomBytes(6).toString("hex")}`, native = await startNativeDatabase(config);
Object.assign(process.env, applicationEnvironment(config), { DATABASE_URL: connectionString(config, false, dbName) });
const admin = new Pool({ connectionString: connectionString(config, true, dbName) }), users: string[] = [];
const reason = "Explicit organization lifecycle acceptance fixture";
before(async () => {
  await migrate(config, dbName); const auth = provisioningAuth(admin);
  for (let i = 0; i < 4; i++) users.push((await auth.api.signUpEmail({ body: { name: `Lifecycle ${i}`, email: `lifecycle${i}@test.invalid`, password: randomBytes(20).toString("hex") } })).user.id);
  await admin.query('UPDATE public."user" SET "twoFactorEnabled"=true WHERE id=ANY($1)', [[users[0], users[1]]]);
});
after(async () => {
  await database().end(); globalThis.__piCollabPool = undefined; await admin.end();
  const cleanup = new Pool({ connectionString: connectionString(config, true, "postgres") }); await cleanup.query(`DROP DATABASE "${dbName}" WITH (FORCE)`); await cleanup.end(); await native.stop();
});
async function fixture() {
  const org = randomUUID(); await admin.query("INSERT INTO collab.organizations(id,name,created_by) VALUES($1,'Lifecycle team',$2)", [org, users[0]]);
  for (let i = 0; i < 3; i++) await admin.query("INSERT INTO collab.memberships(organization_id,user_id,role) VALUES($1,$2,$3)", [org, users[i], i === 0 ? "owner" : "member"]);
  const project = await createProject(users[0], { organizationId: org, name: "Retained project", description: "" });
  await admin.query("INSERT INTO collab.project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,'developer')", [org, project.id, users[1]]);
  const task = await createTask(users[1], project.id, { title: "Retained task", description: "", acceptance: "" });
  return { org, project, task };
}
const action = (org: string, operation: "delete" | "restore" | "transfer", overrides = {}, actor = users[0]) => organizationAction(actor, org, { action: operation, expectedVersion: "1", confirmation: "Lifecycle team", reason, ...overrides });

test("lifecycle is owner-only, MFA-protected, exact-confirmation and revision checked", async () => {
  const { org } = await fixture();
  for (const user of [users[1], users[2], users[3]]) await assert.rejects(action(org, "delete", {}, user), /not_found/);
  await assert.rejects(action(org, "delete", { confirmation: "Another team" }), /invalid_organization_action/);
  await assert.rejects(action(org, "delete", { expectedVersion: "2" }), /stale_organization/);
  await assert.rejects(asUser(users[0], db => db.query("UPDATE collab.organizations SET deleted_at=now() WHERE id=$1", [org])), /permission/);
  assert.deepEqual((await organizationDetail(users[0], org)).blockers, []);
});

test("transfer is atomic, requires the recipient's MFA and current membership; concurrent stale transfer loses", async () => {
  const { org } = await fixture();
  await assert.rejects(action(org, "transfer", { targetUserId: users[2], targetVersion: "1" }), /transfer_mfa_required/);
  await assert.rejects(action(org, "transfer", { targetUserId: users[1], targetVersion: "2" }), /stale_membership/);
  const outcomes = await Promise.allSettled([1,2].map(() => action(org, "transfer", { targetUserId: users[1], targetVersion: "1" })));
  assert.equal(outcomes.filter(r => r.status === "fulfilled").length, 1);
  const rows = (await admin.query("SELECT user_id,role,authorization_version::text FROM collab.memberships WHERE organization_id=$1", [org])).rows;
  assert.equal(rows.find(r => r.user_id === users[1]).role, "owner"); assert.equal(rows.find(r => r.user_id === users[0]).role, "admin");
  assert.equal((await organizationDetail(users[1], org)).organization.lifecycle_version, "2");
  await assert.rejects(changeMember(users[1], org, users[1], { role: "member", active: true }), /last_owner/);
});

test("deletion preserves evidence, revokes all memberships/invitations, and restore never revives other members", async () => {
  const { org, project, task } = await fixture();
  const invite = await createInvitation(users[0], org, { email: "lifecycle3@test.invalid", role: "member" });
  await action(org, "delete");
  for (const actor of [users[0], users[1]]) {
    await assert.rejects(projectDetail(actor, project.id), /not found/);
    assert.equal((await listProjects(actor)).projects.some(p => p.id === project.id), false);
  }
  assert.equal((await listProjects(users[0])).deletedOrganizations.some(o => o.id === org), true);
  assert.equal((await listProjects(users[1])).deletedOrganizations.some(o => o.id === org), false);
  assert.equal((await organizationDetail(users[0], org)).deleted, true);
  await assert.rejects(action(org, "restore", { expectedVersion: "2" }, users[1]), /not_found/);
  await assert.rejects(acceptInvitation(users[3], { token: new URL(invite.url).hash.slice(1), email: "lifecycle3@test.invalid" }), /邀请已失效/);
  await assert.rejects(admin.query("UPDATE collab.memberships SET active=true WHERE organization_id=$1", [org]), /organization_deleted/);
  await action(org, "restore", { expectedVersion: "2" });
  assert.equal((await projectDetail(users[0], project.id)).tasks[0].id, task.id);
  await assert.rejects(projectDetail(users[1], project.id), /not found/);
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM collab.audit_events WHERE organization_id=$1 AND action IN ('organization.delete','organization.restore')", [org])).rows[0].n, 2);
  assert.equal((await admin.query("SELECT authorization_version::text AS v FROM collab.memberships WHERE organization_id=$1 AND user_id=$2", [org, users[0]])).rows[0].v, "3");
});

test("queued runs block deletion; after explicit stop the owner can delete", async () => {
  const { org, project, task } = await fixture(), repo = randomUUID(), sha = "a".repeat(40);
  await admin.query("INSERT INTO collab.repositories(id,organization_id,project_id,name,provider,base_sha,default_branch) VALUES($1,$2,$3,'Fixture','local',$4,'main')", [repo, org, project.id, sha]);
  const run = await startRun(users[1], task.id, { repositoryId: repo, baseSha: sha, prompt: "Fixture", expectedVersion: task.version, idempotencyKey: randomUUID() });
  assert.ok((await organizationDetail(users[0], org)).blockers.some((item: { kind: string }) => item.kind === "runs"));
  await assert.rejects(action(org, "delete"), /organization_busy/);
  await stopRun(users[1], run.runId, { idempotencyKey: randomUUID() });
  await action(org, "delete");
});
