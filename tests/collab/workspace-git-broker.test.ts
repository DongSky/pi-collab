import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer, createConnection, type Socket } from "node:net";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { localConfig, applicationEnvironment, connectionString, executorConnectionString, gitConnectionString } from "../../scripts/local-config";
import { startNativeDatabase } from "../../scripts/native-database";
import { migrate } from "../../scripts/migrate";
import { provisioningAuth } from "../../lib/collab/auth";
import { asUser, database } from "../../lib/collab/database";
import { createProject } from "../../lib/collab/projects";
import { createTask } from "../../lib/collab/tasks";
import { startRun, runDetail } from "../../lib/collab/runs";
import { ExecutionStore } from "../../lib/collab/execution-store";
import { executeClaim } from "../../lib/collab/executor";
import { importLocalRepository } from "../../lib/collab/repository-import";
import { NativeRuntimeBackend } from "../../lib/collab/runtime/backends";
import { inspectWorkspaceGit } from "../../lib/collab/runtime/workspace-git-view";
import { cancelReservedWorkspaceGit, observeWorkspaceGitOperation, reserveWorkspaceGit } from "../../lib/collab/runtime/workspace-git-operation";
import { processSnapshots, requestSnapshot } from "../../lib/collab/snapshots";
import { requestWorkspaceGit, workspaceGitAction, listWorkspaceGit, workspaceGitInput } from "../../lib/collab/git/workspace-operations";
import { processWorkspaceGit } from "../../lib/collab/git/workspace-broker";
import { workspaceGitState, workspaceGitPreview, workspaceGitFile } from "../../lib/collab/git/workspace-preview";

const config = await localConfig(), dbName = `pi_collab_test_${randomBytes(6).toString("hex")}`, native = await startNativeDatabase(config);
Object.assign(process.env, applicationEnvironment(config), { DATABASE_URL: connectionString(config, false, dbName) });
const admin = new Pool({ connectionString: connectionString(config, true, dbName) }), broker = new Pool({ connectionString: gitConnectionString(config, dbName) });
const store = new ExecutionStore(executorConnectionString(config, dbName)), executor = randomUUID(), organization = randomUUID(), users: string[] = [];
const root = await mkdtemp(path.join(tmpdir(), "pi-collab-workspace-broker-")), original = path.join(root, "source"), exec = promisify(execFile);
process.env.PI_COLLAB_DATA_DIR = root;
let project: string, imported: { id: string; baseSha: string };
before(async () => {
  await migrate(config, dbName); const auth = provisioningAuth(admin);
  for (let i = 0; i < 5; i++) users.push((await auth.api.signUpEmail({ body: { name: `Workspace member ${i}`, email: `workspace${i}@test.invalid`, password: randomBytes(20).toString("hex") } })).user.id);
  await admin.query("INSERT INTO collab.organizations(id,name,created_by) VALUES($1,'Workspace Git test',$2)", [organization, users[0]]);
  for (let i = 0; i < 4; i++) await admin.query("INSERT INTO collab.memberships(organization_id,user_id,role) VALUES($1,$2,$3)", [organization, users[i], i ? "member" : "owner"]);
  await admin.query('UPDATE public."user" SET "twoFactorEnabled"=true WHERE id=$1', [users[0]]);
  project = (await createProject(users[0], { organizationId: organization, name: "Workspace Git project", description: "" })).id;
  for (let i = 1; i < 4; i++) await admin.query("INSERT INTO collab.project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,$4)", [organization, project, users[i], i === 2 ? "reviewer" : "developer"]);
  await mkdir(original);
  for (const args of [["init", "-b", "main"], ["config", "user.name", "Local fixture"], ["config", "user.email", "fixture@test.invalid"]]) await exec("git", args, { cwd: original });
  await writeFile(path.join(original, "code.txt"), "original\n"); await exec("git", ["add", "."], { cwd: original }); await exec("git", ["commit", "-m", "Initial fixture"], { cwd: original });
  imported = await importLocalRepository(admin, root, { projectId: project, actorId: users[0], name: "Native Git fixture", source: original });
});
after(async () => {
  await store.close(); await broker.end(); if (globalThis.__piCollabPool) { await database().end(); globalThis.__piCollabPool = undefined; } await admin.end();
  const cleanup = new Pool({ connectionString: connectionString(config, true, "postgres") }); await cleanup.query(`DROP DATABASE "${dbName}" WITH (FORCE)`); await cleanup.end(); await native.stop(); await rm(root, { recursive: true, force: true });
});
async function scenario() {
  const task = await createTask(users[1], project, { title: "Workspace Git acceptance", description: "", acceptance: "" });
  await startRun(users[1], task.id, { repositoryId: imported.id, baseSha: imported.baseSha, prompt: "Make a draft using the native Pi tool", expectedVersion: task.version, idempotencyKey: randomUUID() });
  const claim = await store.claim(executor, "native"); assert.ok(claim); assert.equal(claim.run.task_id, task.id);
  assert.equal(await executeClaim(store, executor, claim, { dataRoot: root, backend: new NativeRuntimeBackend(), driver: async agent => {
    await agent.peer.command("bash", { command: "printf 'draft by Pi\\n' > code.txt" }); return { kind: "local-tool-fixture" };
  } }), "completed");
  const source = { workspaceId: claim.workspace.id, identity: { runId: claim.run.id, executorId: executor, epoch: claim.run.epoch } };
  const view = await inspectWorkspaceGit(root, source), detail = await runDetail(users[1], claim.run.id), checkout = path.join(root, "workspaces", claim.workspace.id, "checkout");
  const input = { kind: "stage" as const, selections: [{ path: "code.txt", direction: "stage" as const, hunks: "file" as const }], revision: view.revision, expectedRunRevision: detail.run.revision as string, acknowledge: true as const, idempotencyKey: randomUUID() };
  const request = () => requestWorkspaceGit(users[1], claim.run.id, input);
  const process = (options: NonNullable<Parameters<typeof processWorkspaceGit>[2]> = {}) => processWorkspaceGit(broker, root, options);
  const action = (id: string, kind: "cancel" | "reconcile", actor = users[0]) => workspaceGitAction(actor, id, { action: kind, reason: "Inspect or stop this exact existing Git operation", idempotencyKey: randomUUID() });
  const git = async (...args: string[]) => (await exec("git", args, { cwd: checkout })).stdout.trim();
  return { claim, source, view, input, request, process, action, git, checkout, row: async (id: string) => (await admin.query("SELECT * FROM collab_git.workspace_operations WHERE id=$1", [id])).rows[0] };
}
test("real Pi draft, durable deduplication, native stage and attributed commit preserve working files and source", async () => {
  const s = await scenario(), head = await s.git("rev-parse", "HEAD");
  const requests = await Promise.all([s.request(), s.request(), s.request()]); assert.equal(new Set(requests.map(r => r.jobId)).size, 1); assert.equal(requests.filter(r => !r.replayed).length, 1);
  assert.equal((await s.process())?.status, "applied"); assert.equal(await s.git("show", ":code.txt"), "draft by Pi"); assert.equal(await s.git("rev-parse", "HEAD"), head);
  assert.equal((await s.request()).replayed, true); assert.equal(await s.process(), null);
  const index = await readFile(path.join(s.checkout, ".git/index")), view = await inspectWorkspaceGit(root, s.source);
  const commit = await requestWorkspaceGit(users[1], s.claim.run.id, { kind: "commit", message: "Confirm the exact staged draft", revision: view.revision, expectedRunRevision: s.input.expectedRunRevision, acknowledge: true, idempotencyKey: randomUUID() });
  assert.equal((await s.process())?.status, "applied"); const row = await s.row(commit.jobId);
  assert.equal(await s.git("rev-parse", "HEAD"), row.effect_request.commit); assert.equal(await s.git("rev-list", "--count", `${head}..HEAD`), "1");
  const bytes = await s.git("cat-file", "commit", "HEAD"); assert.match(bytes, /author Workspace member 1 <member-/); assert.ok(bytes.includes(createHash("sha256").update(users[1]).digest("hex")));
  assert.deepEqual(await readFile(path.join(s.checkout, ".git/index")), index); assert.equal(await readFile(path.join(s.checkout, "code.txt"), "utf8"), "draft by Pi\n");
  assert.equal((await exec("git", ["rev-parse", "HEAD"], { cwd: original })).stdout.trim(), head);
  const listed = (await listWorkspaceGit(users[2], s.claim.run.id)).operations; assert.equal(listed.length, 2); assert.equal(listed[0].claim_id, undefined);
  assert.equal((await admin.query("SELECT 1 FROM collab.audit_events WHERE resource_id=$1 AND action='workspace_git.applied'", [commit.jobId])).rowCount, 1);
});
test("current task ownership, scoped membership, MFA, fixed payload and narrow SQL grants", async () => {
  const s = await scenario();
  for (const actor of [users[2], users[3], users[4]]) await assert.rejects(requestWorkspaceGit(actor, s.claim.run.id, s.input), /forbidden|not_found/);
  await assert.rejects(listWorkspaceGit(users[4], s.claim.run.id), /not_found/);
  await admin.query("UPDATE collab.memberships SET role='admin' WHERE organization_id=$1 AND user_id=$2", [organization, users[1]]);
  await assert.rejects(s.request(), /forbidden/);
  await admin.query("UPDATE collab.memberships SET role='member' WHERE organization_id=$1 AND user_id=$2", [organization, users[1]]);
  assert.equal(workspaceGitInput.safeParse({ ...s.input, identity: { actorId: users[0] } }).success, false);
  await assert.rejects(asUser(users[1], db => db.query("SELECT collab.request_workspace_git($1,$2,$3)", [s.claim.run.id, randomUUID(), { ...s.input, actorId: users[0] }])), /invalid_workspace_git/);
  const request = await s.request();
  await assert.rejects(requestWorkspaceGit(users[1], s.claim.run.id, { ...s.input, revision: "a".repeat(64) }), /idempotency_conflict/);
  await assert.rejects(requestWorkspaceGit(users[1], s.claim.run.id, { ...s.input, idempotencyKey: randomUUID() }), /workspace_git_busy/);
  for (const sql of ["SELECT * FROM collab_git.workspace_operations", "UPDATE collab_git.workspace_operations SET status='applied'", "SELECT collab_git.workspace_result($1)"])
    await assert.rejects(broker.query(sql, sql.includes("$1") ? [request.jobId] : undefined), /permission/);
  await assert.rejects(asUser(users[1], db => db.query("SELECT collab_git.claim_workspace()")), /permission/);
  assert.equal((await s.process())?.status, "applied");
});
test("snapshots and Git are mutually exclusive; completed immutable snapshots survive subsequent Git changes", async () => {
  const s = await scenario(), snapshot = { expectedRevision: s.input.expectedRunRevision, note: "Preserve original stopped draft", idempotencyKey: randomUUID() };
  const first = await requestSnapshot(users[1], s.claim.run.id, snapshot);
  await assert.rejects(s.request(), /workspace_git_busy/); await processSnapshots(store, root);
  const artifact = await readFile(path.join(root, "snapshots", first.snapshotId, "manifest.json"));
  await s.request(); await assert.rejects(requestSnapshot(users[1], s.claim.run.id, { ...snapshot, idempotencyKey: randomUUID() }), /workspace_git_busy/);
  assert.equal((await s.process())?.status, "applied");
  assert.deepEqual(await readFile(path.join(root, "snapshots", first.snapshotId, "manifest.json")), artifact);
  await requestSnapshot(users[1], s.claim.run.id, { ...snapshot, idempotencyKey: randomUUID() }); await processSnapshots(store, root);
});
test("queued cancellation never reserves Git; cancellation at final gate produces a settled abort", async () => {
  for (const queued of [true, false]) {
    const s = await scenario(), accepted = await s.request(), before = await readFile(path.join(s.checkout, ".git/index"));
    if (queued) await s.action(accepted.jobId, "cancel");
    const result = await s.process(queued ? {} : { beforeGate: id => s.action(id, "cancel").then(() => {}) });
    assert.equal(result.status, "aborted"); assert.deepEqual(await readFile(path.join(s.checkout, ".git/index")), before);
    assert.equal((await s.row(accepted.jobId)).launch_intent, !queued);
  }
});
test("pinned SQL ownership excludes other brokers and callbacks; recovery cannot replace a live session", async () => {
  const s = await scenario(); await s.request();
  assert.equal((await s.process({ afterClaim: async id => {
    assert.equal(await s.process(), null); const row = await s.row(id);
    await assert.rejects(broker.query("SELECT collab_git.begin_workspace($1,$2)", [id, row.claim_id]), /workspace_git_claim_lost/);
    await assert.rejects(s.action(id, "reconcile"), /workspace_git_busy/);
  } })).status, "applied");
});
test("original membership version and task version are rechecked immediately before the effect", async () => {
  for (const change of ["membership", "task"] as const) {
    const s = await scenario(); await s.request(); const before = await readFile(path.join(s.checkout, ".git/index"));
    const result = await s.process({ beforeGate: async () => {
      if (change === "membership") await admin.query("UPDATE collab.project_memberships SET authorization_version=authorization_version+1 WHERE project_id=$1 AND user_id=$2", [project, users[1]]);
      else await admin.query("UPDATE collab.tasks SET version=version+1 WHERE id=$1", [s.claim.run.task_id]);
    } });
    assert.equal(result.status, "aborted"); assert.deepEqual(await readFile(path.join(s.checkout, ".git/index")), before);
  }
});
test("a lost SQL owner after reservation retains occupancy; explicit reconciliation cancels without replay", async () => {
  const s = await scenario(), accepted = await s.request(), before = await readFile(path.join(s.checkout, ".git/index"));
  await assert.rejects(s.process({ afterReservation: async id => {
    const row = await s.row(id); await admin.query("SELECT pg_terminate_backend($1)", [row.backend_pid]); await new Promise(resolve => setTimeout(resolve, 50));
  } }), /outcome_unknown/);
  assert.equal((await s.process())?.status, "attention");
  await assert.rejects(requestWorkspaceGit(users[1], s.claim.run.id, { ...s.input, idempotencyKey: randomUUID() }), /workspace_git_busy/);
  await s.action(accepted.jobId, "reconcile"); assert.equal((await s.process())?.status, "aborted");
  assert.deepEqual(await readFile(path.join(s.checkout, ".git/index")), before);
  const observed = await observeWorkspaceGitOperation(root, s.source.workspaceId); assert.equal(observed?.state.reason, "cancelled_before_launch");
});
test("SQL loss after the actual commit retains unknown status and later observes exactly one commit", async () => {
  const s = await scenario(); await s.request(); await s.process(); const head = await s.git("rev-parse", "HEAD"), view = await inspectWorkspaceGit(root, s.source);
  const accepted = await requestWorkspaceGit(users[1], s.claim.run.id, { kind: "commit", message: "One commit despite SQL loss", revision: view.revision, expectedRunRevision: s.input.expectedRunRevision, acknowledge: true, idempotencyKey: randomUUID() });
  await assert.rejects(s.process({ beforeFinish: async id => {
    const row = await s.row(id); assert.equal(row.status, "running"); assert.equal(row.acknowledgement.phase, "applied");
    await admin.query("SELECT pg_terminate_backend($1)", [row.backend_pid]); await new Promise(resolve => setTimeout(resolve, 50));
  } }), /outcome_unknown/);
  assert.equal(await s.git("rev-list", "--count", `${head}..HEAD`), "1");
  await s.process(); await s.action(accepted.jobId, "reconcile"); assert.equal((await s.process())?.status, "applied");
  assert.equal(await s.git("rev-list", "--count", `${head}..HEAD`), "1"); assert.equal(await s.process(), null);
});

test("stale previews and invalid hunk selections abort before reserving the workspace", async () => {
  for (const invalidHunk of [true, false]) {
    const s = await scenario();
    const accepted = await requestWorkspaceGit(users[1], s.claim.run.id, invalidHunk ? { ...s.input, selections: [{ ...s.input.selections[0], hunks: ["a".repeat(64)] }] } : s.input);
    if (!invalidHunk) await writeFile(path.join(s.checkout, "code.txt"), "changed since confirmation\n");
    const result = await s.process(); assert.equal(result.status, "aborted"); assert.equal((await s.row(accepted.jobId)).launch_intent, false);
    assert.equal(await s.git("show", ":code.txt"), "original");
  }
});
test("effect acknowledgement is not workspace release; occupancy remains until cleanup and SQL settlement", async () => {
  const s = await scenario(), accepted = await s.request(); let checked = false;
  const result = await s.process({ checkpoint: async event => {
    if (event.checkpoint !== "sealed") return;
    const row = await s.row(accepted.jobId); assert.equal(row.status, "running"); assert.equal(row.acknowledgement, null);
    assert.equal((await observeWorkspaceGitOperation(root, s.source.workspaceId))?.settled, false); checked = true;
  }, beforeFinish: async id => {
    const row = await s.row(id); assert.equal(row.status, "running"); assert.equal(row.acknowledgement.phase, "applied");
    await assert.rejects(requestSnapshot(users[1], s.claim.run.id, { expectedRevision: s.input.expectedRunRevision, note: "Cannot capture before SQL releases ownership", idempotencyKey: randomUUID() }), /workspace_git_busy/);
  } });
  assert.equal(result.status, "applied"); assert.equal(checked, true);
});
test("SQL settlement rejects absent exit evidence and requires an acknowledgement gate in the same transaction", async () => {
  const s = await scenario(), accepted = await s.request(), db = await broker.connect();
  try {
    const claim = (await db.query("SELECT collab_git.claim_workspace() AS result")).rows[0].result;
    await db.query("SELECT collab_git.begin_workspace($1,$2)", [accepted.jobId, claim.claimId]);
    const reservation = await reserveWorkspaceGit(root, claim.admission), observed = await observeWorkspaceGitOperation(root, s.source.workspaceId); assert.ok(observed);
    await assert.rejects(db.query("SELECT collab_git.admit_workspace_effect($1,$2,$3)", [accepted.jobId, claim.claimId, { ...observed.state.request, revision: "0".repeat(64) }]), /invalid_workspace_git_evidence/);
    await db.query("SELECT collab_git.admit_workspace_effect($1,$2,$3)", [accepted.jobId, claim.claimId, observed.state.request]);
    await assert.rejects(db.query("SELECT collab_git.ack_workspace($1,$2,$3)", [accepted.jobId, claim.claimId, { ...observed.state, phase: "applied" }]), /workspace_git_gate_required/);
    await db.query("SELECT collab_git.gate_workspace($1,$2)", [accepted.jobId, claim.claimId]);
    await assert.rejects(db.query("SELECT collab_git.ack_workspace($1,$2,$3)", [accepted.jobId, claim.claimId, { ...observed.state, phase: "applied" }]), /workspace_git_gate_required/);
    await assert.rejects(db.query("SELECT collab_git.finish_workspace($1,$2,$3)", [accepted.jobId, claim.claimId, { ...observed, state: { ...observed.state, phase: "aborted" } }]), /invalid_workspace_git_evidence/);
    await cancelReservedWorkspaceGit(reservation);
    await db.query("SELECT collab_git.fail_workspace($1,$2,'workspace_git_test_interruption')", [accepted.jobId, claim.claimId]);
  } finally { db.release(true); }
  await s.action(accepted.jobId, "reconcile"); assert.equal((await s.process())?.status, "aborted"); assert.equal(await s.git("show", ":code.txt"), "original");
});
test("actual native SIGKILL after commit is reconciled by a fresh process without another commit", async () => {
  const s = await scenario(); await s.request(); await s.process(); const head = await s.git("rev-parse", "HEAD"), view = await inspectWorkspaceGit(root, s.source);
  const accepted = await requestWorkspaceGit(users[1], s.claim.run.id, { kind: "commit", message: "Recover one actual effect", revision: view.revision, expectedRunRevision: s.input.expectedRunRevision, acknowledge: true, idempotencyKey: randomUUID() });
  const result = await s.process({ checkpoint: async (event, child) => { if (event.checkpoint === "effect") child.stop(); } });
  assert.equal(result.status, "attention"); assert.equal(await s.git("rev-list", "--count", `${head}..HEAD`), "1");
  assert.equal((await s.row(accepted.jobId)).acknowledgement, null);
  await s.action(accepted.jobId, "reconcile"); const recovered = await s.process(); assert.equal(recovered.status, "applied");
  assert.equal(await s.git("rev-list", "--count", `${head}..HEAD`), "1");
  const observed = await observeWorkspaceGitOperation(root, s.source.workspaceId); assert.equal(observed?.state.attempt?.mode, "recover"); assert.equal(observed?.settled, true);
});
test("final gate holds task ownership until the effect acknowledgement commits", async () => {
  const s = await scenario(); await s.request(); let mutation: Promise<unknown> | undefined, completed = false;
  try {
    const result = await s.process({ checkpoint: async event => {
      if (event.checkpoint !== "authorized") return;
      mutation = admin.query("UPDATE collab.tasks SET owner_id=$2,version=version+1 WHERE id=$1", [s.claim.run.task_id, users[3]]).then(() => { completed = true; });
      await new Promise(resolve => setTimeout(resolve, 80)); assert.equal(completed, false);
    } });
    assert.equal(result.status, "applied"); await mutation; assert.equal(completed, true);
    await assert.rejects(requestWorkspaceGit(users[1], s.claim.run.id, { ...s.input, idempotencyKey: randomUUID() }), /forbidden/);
  } finally { await mutation; }
});
test("missing reservation after launch intent stays occupied; reconciliation cannot invent an absent fence", async () => {
  const s = await scenario(), accepted = await s.request(), db = await broker.connect();
  try {
    const claim = (await db.query("SELECT collab_git.claim_workspace() AS result")).rows[0].result;
    await db.query("SELECT collab_git.begin_workspace($1,$2)", [accepted.jobId, claim.claimId]);
  } finally { db.release(true); }
  assert.equal((await s.process())?.status, "attention"); await s.action(accepted.jobId, "reconcile");
  assert.equal((await s.process())?.status, "attention");
  await assert.rejects(requestSnapshot(users[1], s.claim.run.id, { expectedRevision: s.input.expectedRunRevision, note: "Unknown launch must retain occupancy", idempotencyKey: randomUUID() }), /workspace_git_busy/);
  assert.equal(await s.git("show", ":code.txt"), "original");
});
test("TCP-dropped COMMIT response observes applied evidence and never repeats an index effect", async () => {
  const s = await scenario(), accepted = await s.request(), sockets = new Set<Socket>(); let armed = false, dropped = false;
  const proxy = createServer(client => {
    const upstream = createConnection({ host: "127.0.0.1", port: config.databasePort }); sockets.add(client); sockets.add(upstream); let final = false;
    client.on("data", chunk => { if (armed && Buffer.from(chunk).includes(Buffer.from("COMMIT"))) final = true; upstream.write(chunk); });
    upstream.on("data", chunk => { if (final && Buffer.from(chunk).includes(Buffer.from("COMMIT"))) { dropped = true; client.destroy(); upstream.destroy(); return; } client.write(chunk); });
    for (const socket of [client, upstream]) { socket.on("error", () => {}); socket.on("close", () => { sockets.delete(socket); client.destroy(); upstream.destroy(); }); }
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve)); const url = new URL(gitConnectionString(config, dbName)); url.port = String((proxy.address() as { port: number }).port);
  const through = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 5000, query_timeout: 5000 });
  try {
    await assert.rejects(processWorkspaceGit(through, root, { beforeAckCommit: async () => {
      // Wait only for the native child, not its parent callback. Cleanup and exit
      // happen independently of the SQL acknowledgement currently being held.
      const deadline = Date.now() + 5000;
      while (!(await observeWorkspaceGitOperation(root, s.source.workspaceId))?.settled && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal((await observeWorkspaceGitOperation(root, s.source.workspaceId))?.settled, true); armed = true;
    } }), /outcome_unknown/);
    assert.equal(dropped, true); const before = await readFile(path.join(s.checkout, ".git/index"));
    assert.equal((await s.request()).replayed, true); assert.equal((await s.process())?.status, "attention");
    await s.action(accepted.jobId, "reconcile"); assert.equal((await s.process())?.status, "applied");
    assert.deepEqual(await readFile(path.join(s.checkout, ".git/index")), before); assert.equal(await s.process(), null);
  } finally { await through.end(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => proxy.close(() => resolve())); }
});

test("authorized Web previews distinguish layers and bind file reads to exact revisions without source writes", async () => {
  const s = await scenario(), before = await readFile(path.join(s.checkout, ".git/index"));
  const preview = await workspaceGitPreview(users[1], s.claim.run.id); assert.equal(preview.canWrite, true); assert.equal(preview.revision, s.input.revision);
  const file = await workspaceGitFile(users[1], s.claim.run.id, { revision: preview.revision, layer: "working", path: "code.txt" });
  assert.equal(file.before?.text, "original\n"); assert.equal(file.after?.text, "draft by Pi\n");
  assert.deepEqual(await readFile(path.join(s.checkout, ".git/index")), before);
  await writeFile(path.join(s.checkout, "code.txt"), "different after preview\n");
  await assert.rejects(workspaceGitFile(users[1], s.claim.run.id, { revision: preview.revision, layer: "working", path: "code.txt" }), /已变化/);
  const fresh = await workspaceGitPreview(users[1], s.claim.run.id); assert.notEqual(fresh.revision, preview.revision);
});
test("read previews reapply project scope while controls require current owner/MFA and operation availability", async () => {
  const s = await scenario();
  for (const actor of [users[2], users[3]]) { assert.equal((await workspaceGitState(actor, s.claim.run.id)).canWrite, false); assert.equal((await workspaceGitPreview(actor, s.claim.run.id)).canWrite, false); }
  await assert.rejects(workspaceGitPreview(users[4], s.claim.run.id), /访问权限/);
  await s.request(); assert.equal((await workspaceGitState(users[1], s.claim.run.id)).occupied, true);
  await assert.rejects(workspaceGitPreview(users[1], s.claim.run.id), /已有 Git/); assert.equal((await s.process()).status, "applied");
  const preview = await workspaceGitPreview(users[1], s.claim.run.id); assert.equal(preview.files.find(f => f.path === "code.txt")?.staged, true);
  assert.equal((await workspaceGitFile(users[1], s.claim.run.id, { revision: preview.revision, layer: "staged", path: "code.txt" })).after?.text, "draft by Pi\n");
  await admin.query("UPDATE collab.project_memberships SET active=false WHERE project_id=$1 AND user_id=$2", [project, users[2]]);
  await assert.rejects(workspaceGitFile(users[2], s.claim.run.id, { revision: preview.revision, layer: "staged", path: "code.txt" }), /访问权限/);
  await admin.query("UPDATE collab.project_memberships SET active=true WHERE project_id=$1 AND user_id=$2", [project, users[2]]);
});
test("Web file queries cannot read excluded secrets, unchanged paths or client-supplied source locations", async () => {
  const s = await scenario(); await writeFile(path.join(s.checkout, ".env"), "PRIVATE_TEST_ONLY=do-not-display\n");
  const preview = await workspaceGitPreview(users[1], s.claim.run.id); assert.ok(preview.exclusions.some(item => item.path === ".env"));
  assert.equal(JSON.stringify(preview).includes("do-not-display"), false);
  for (const file of [".env", "missing.txt"]) await assert.rejects(workspaceGitFile(users[1], s.claim.run.id, { revision: preview.revision, layer: "working", path: file }), /排除/);
  assert.throws(() => workspaceGitFile(users[1], s.claim.run.id, { revision: preview.revision, layer: "working", path: "../source/code.txt" }));
  assert.throws(() => workspaceGitFile(users[1], s.claim.run.id, { revision: preview.revision, layer: "working", path: "code.txt", workspaceId: randomUUID() }));
  await admin.query("UPDATE collab.workspaces SET status='archived' WHERE id=$1", [s.source.workspaceId]);
  assert.equal((await workspaceGitState(users[1], s.claim.run.id)).available, false); await assert.rejects(workspaceGitPreview(users[1], s.claim.run.id), /尚未归档/);
});
