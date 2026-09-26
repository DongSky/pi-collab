import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { localConfig, applicationEnvironment, connectionString } from "../../scripts/local-config";
import { migrate } from "../../scripts/migrate";
import { startNativeDatabase } from "../../scripts/native-database";
import { provisioningAuth, auth } from "../../lib/collab/auth";
import { asUser, database } from "../../lib/collab/database";
import { createProject, listProjects, projectDetail } from "../../lib/collab/projects";
import { addDependency, createTask } from "../../lib/collab/tasks";
import { permits } from "../../lib/collab/policy";
import { requireSameOrigin } from "../../lib/collab/http";
import { editTask, taskEditHistory } from "../../lib/collab/task-lifecycle";

const config = await localConfig();
const databaseName = `pi_collab_test_${randomBytes(6).toString("hex")}`;
const native = await startNativeDatabase(config);
Object.assign(process.env, applicationEnvironment(config), { DATABASE_URL: connectionString(config, false, databaseName) });
const admin = new Pool({ connectionString: connectionString(config, true, databaseName) });
const organization = randomUUID(), otherOrganization = randomUUID();
const accounts: { id: string; email: string; password: string }[] = [];
let project: { id: string };

before(async () => {
  await migrate(config, databaseName);
  const provision = provisioningAuth(admin);
  for (const name of ["Owner", "Developer", "Reviewer", "Outsider"]) {
    const email = `${name.toLowerCase()}@test.invalid`, password = randomBytes(20).toString("hex");
    const result = await provision.api.signUpEmail({ body: { name, email, password } });
    accounts.push({ id: result.user.id, email, password });
  }
  await admin.query("INSERT INTO collab.organizations(id,name,created_by) VALUES($1,'Team',$2),($3,'Other team',$4)", [organization, accounts[0].id, otherOrganization, accounts[3].id]);
  for (let i = 0; i < 4; i++) await admin.query("INSERT INTO collab.memberships(organization_id,user_id,role) VALUES($1,$2,$3)", [i === 3 ? otherOrganization : organization, accounts[i].id, i === 0 || i === 3 ? "owner" : "member"]);
  project = await createProject(accounts[0].id, { organizationId: organization, name: "Test project", description: "" });
  for (let i = 1; i <= 2; i++) await admin.query("INSERT INTO collab.project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,$4)", [organization, project.id, accounts[i].id, i === 1 ? "developer" : "reviewer"]);
});

after(async () => {
  await database().end();
  globalThis.__piCollabPool = undefined;
  await admin.end();
  const cleanup = new Pool({ connectionString: connectionString(config, true, "postgres") });
  await cleanup.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  await cleanup.end();
  await native.stop();
});

test("application role cannot bypass RLS or administer the database", async () => {
  const { rows } = await database().query("SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user");
  assert.deepEqual(rows[0], { rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false });
  await assert.rejects(database().query("SELECT * FROM collab.installation"), /permission denied/);
});

test("organization and project data are invisible to another organization's member, even by guessed ID", async () => {
  assert.equal((await listProjects(accounts[3].id)).projects.length, 0);
  await assert.rejects(projectDetail(accounts[3].id, project.id), /Project not found/);
  await asUser(accounts[3].id, async db => {
    assert.equal((await db.query("SELECT * FROM collab.organizations WHERE id=$1", [organization])).rowCount, 0);
    assert.equal((await db.query("SELECT * FROM collab.projects WHERE id=$1", [project.id])).rowCount, 0);
  });
});

test("reviewer can read but cannot create a task through service or direct application SQL", async () => {
  assert.equal((await projectDetail(accounts[2].id, project.id)).project.id, project.id);
  await assert.rejects(createTask(accounts[2].id, project.id, { title: "Forbidden", description: "", acceptance: "" }), /permission/);
  await assert.rejects(asUser(accounts[2].id, db => db.query("INSERT INTO collab.tasks(organization_id,project_id,title,owner_id,created_by) VALUES($1,$2,'Bypass',$3,$4)", [organization, project.id, accounts[1].id, accounts[2].id])), /row-level security/);
});

test("developer can create own task but cannot assign work to another member", async () => {
  const task = await createTask(accounts[1].id, project.id, { title: "Own task", description: "Independent work", acceptance: "Checks pass" });
  assert.equal(task.owner_id, accounts[1].id);
  await assert.rejects(createTask(accounts[1].id, project.id, { title: "Assigned", description: "", acceptance: "", ownerId: accounts[0].id }), /maintainer/);
});

test("task lifecycle supports versioned edits, immutable history and closing/reopening without granting code approval", async () => {
  const task = await createTask(accounts[1].id, project.id, { title: "Editable task", description: "Original", acceptance: "Verify original" });
  const input = { title: "Updated task", description: "New goal", acceptance: "Verify new goal", status: "ready" as const,
    reason: "Clarify task requirements before starting", expectedVersion: task.version, idempotencyKey: randomUUID(), acknowledgeCompletion: false };
  const results = await Promise.all([editTask(accounts[1].id, task.id, input), editTask(accounts[1].id, task.id, input)]);
  assert.equal(new Set(results.map(r => r.editId)).size, 1);
  assert.equal(results[0].evidenceInvalidated, true);
  await assert.rejects(editTask(accounts[1].id, task.id, { ...input, title: "Conflicting payload" }), /idempotency_conflict/);
  await assert.rejects(editTask(accounts[1].id, task.id, { ...input, idempotencyKey: randomUUID() }), /stale_revision/);
  const next = { ...input, expectedVersion: task.version + 1, idempotencyKey: randomUUID(), status: "done" as const };
  await assert.rejects(editTask(accounts[1].id, task.id, next), /task_completion_acknowledgement/);
  await editTask(accounts[1].id, task.id, { ...next, acknowledgeCompletion: true });
  await editTask(accounts[1].id, task.id, { ...next, status: "draft", expectedVersion: task.version + 2, idempotencyKey: randomUUID(), reason: "Reopen after additional user feedback" });
  const history = await taskEditHistory(accounts[2].id, task.id);
  assert.equal(history.edits.length, 3);
  assert.equal(history.edits[0].updated.status, "draft");
  assert.equal(history.edits[2].previous.title, "Editable task");
  assert.equal(history.edits[2].updated.title, "Updated task");
  await assert.rejects(taskEditHistory(accounts[3].id, task.id), /不存在/);
  await assert.rejects(asUser(accounts[1].id, db => db.query("UPDATE collab.tasks SET status='done' WHERE id=$1", [task.id])), /permission denied/);
  await assert.rejects(asUser(accounts[1].id, db => db.query("DELETE FROM collab.task_edits WHERE task_id=$1", [task.id])), /permission denied/);
});

test("task editing rejects other developers/reviewers, unmanaged state promotion, and stale concurrent writes", async () => {
  const task = await createTask(accounts[1].id, project.id, { title: "Lifecycle roles", description: "", acceptance: "" });
  const input = { title: task.title, description: "", acceptance: "", status: "ready" as const, reason: "Plan the first iteration of this task", expectedVersion: task.version, idempotencyKey: randomUUID() };
  await assert.rejects(editTask(accounts[2].id, task.id, input), /forbidden/);
  await assert.rejects(editTask(accounts[3].id, task.id, input), /not_found/);
  await assert.rejects(editTask(accounts[1].id, task.id, { ...input, status: "ready_to_merge" }), /task_status_managed/);
  const outcomes = await Promise.allSettled([editTask(accounts[1].id, task.id, input), editTask(accounts[1].id, task.id, { ...input, status: "blocked", idempotencyKey: randomUUID() })]);
  assert.equal(outcomes.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(r => r.status === "rejected").length, 1);
});

test("concurrent opposite dependencies cannot create a cycle", async () => {
  const [a, b] = await Promise.all(["Backend", "Frontend"].map(title => createTask(accounts[1].id, project.id, { title, description: "", acceptance: "" })));
  const results = await Promise.allSettled([
    addDependency(accounts[1].id, a.id, { dependsOn: b.id, kind: "strict" }),
    addDependency(accounts[1].id, b.id, { dependsOn: a.id, kind: "strict" }),
  ]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const rejection = results.find(r => r.status === "rejected") as PromiseRejectedResult;
  assert.equal(rejection.reason.code, "dependency_cycle");
});

test("cross-project dependency cannot be inserted, even with a real task ID", async () => {
  const otherProject = await createProject(accounts[3].id, { organizationId: otherOrganization, name: "Other", description: "" });
  const otherTask = await createTask(accounts[3].id, otherProject.id, { title: "Private", description: "", acceptance: "" });
  const ownTask = await createTask(accounts[0].id, project.id, { title: "Own", description: "", acceptance: "" });
  await assert.rejects(addDependency(accounts[0].id, ownTask.id, { dependsOn: otherTask.id, kind: "soft" }), /not found/);
  await assert.rejects(asUser(accounts[0].id, db => db.query("INSERT INTO collab.task_dependencies(organization_id,project_id,task_id,depends_on) VALUES($1,$2,$3,$4)", [organization, project.id, ownTask.id, otherTask.id])), /permission denied/);
  await assert.rejects(admin.query("INSERT INTO collab.task_dependencies(organization_id,project_id,task_id,depends_on) VALUES($1,$2,$3,$4)", [organization, project.id, ownTask.id, otherTask.id]), /foreign key/);
});

test("pooled connections do not retain identity after commit or rollback", async () => {
  for (let i = 0; i < 30; i++) {
    const result = await asUser(accounts[i % 4].id, db => db.query("SELECT collab.actor() AS actor"));
    assert.equal(result.rows[0].actor, accounts[i % 4].id);
  }
  await assert.rejects(asUser(accounts[0].id, async () => { throw new Error("rollback"); }), /rollback/);
  const anonymous = await database().query("SELECT * FROM collab.tasks");
  assert.equal(anonymous.rowCount, 0);
});

test("organization membership revocation immediately removes access, including project creator", async () => {
  await admin.query("UPDATE collab.memberships SET role='owner' WHERE organization_id=$1 AND user_id=$2", [organization, accounts[1].id]);
  await admin.query("UPDATE collab.memberships SET active=false WHERE organization_id=$1 AND user_id=$2", [organization, accounts[0].id]);
  try {
    assert.equal((await listProjects(accounts[0].id)).projects.length, 0);
    await assert.rejects(projectDetail(accounts[0].id, project.id), /not found/);
  } finally {
    await admin.query("UPDATE collab.memberships SET active=true WHERE organization_id=$1 AND user_id=$2", [organization, accounts[0].id]);
    await admin.query("UPDATE collab.memberships SET role='member' WHERE organization_id=$1 AND user_id=$2", [organization, accounts[1].id]);
  }
});

test("public signup is disabled and invalid credentials cannot sign in", async () => {
  await assert.rejects(auth().api.signUpEmail({ body: { name: "Intruder", email: "new@test.invalid", password: "long-but-not-invited" } }), /not enabled/);
  await assert.rejects(auth().api.signInEmail({ body: { email: accounts[0].email, password: "incorrect-password" } }), /Invalid/);
  const login = await auth().api.signInEmail({ body: { email: accounts[0].email, password: accounts[0].password } });
  assert.equal(login.user.id, accounts[0].id);
  assert.ok(login.token);
  await admin.query('DELETE FROM public."session" WHERE token=$1', [login.token]);
  const remaining = await admin.query('SELECT id FROM public."session" WHERE token=$1', [login.token]);
  assert.equal(remaining.rowCount, 0);
});

test("audits are readable only within the authorized project and cannot be rewritten", async () => {
  const visible = await asUser(accounts[1].id, db => db.query("SELECT * FROM collab.audit_events WHERE project_id=$1", [project.id]));
  assert.ok(visible.rowCount && visible.rowCount > 0);
  assert.equal((await asUser(accounts[3].id, db => db.query("SELECT * FROM collab.audit_events WHERE project_id=$1", [project.id]))).rowCount, 0);
  await assert.rejects(asUser(accounts[0].id, db => db.query("DELETE FROM collab.audit_events WHERE project_id=$1", [project.id])), /permission denied/);
});

test("capabilities distinguish observers, reviewers, developers and maintainers", () => {
  assert.equal(permits("viewer", "run.start"), false);
  assert.equal(permits("reviewer", "review.submit"), true);
  assert.equal(permits("reviewer", "git.push"), false);
  assert.equal(permits("developer", "git.merge"), false);
  assert.equal(permits("maintainer", "git.merge"), true);
  assert.equal(permits(null, "project.read"), false);
});

test("mutations require an exact configured Origin, including requests with cookies", () => {
  const url = "http://127.0.0.1:30142/api/collab/projects";
  assert.throws(() => requireSameOrigin(new Request(url, { method: "POST" })), /same-origin/);
  assert.throws(() => requireSameOrigin(new Request(url, { method: "POST", headers: { Origin: "https://evil.test" } })), /same-origin/);
  assert.doesNotThrow(() => requireSameOrigin(new Request(url, { method: "POST", headers: { Origin: "http://127.0.0.1:30142" } })));
});
