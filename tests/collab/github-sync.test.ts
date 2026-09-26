import { revertCatalogue } from "../../lib/collab/reverts";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createServer, createConnection, type Socket } from "node:net";
import { Pool } from "pg";
import { localConfig, applicationEnvironment, connectionString } from "../../scripts/local-config";
import { startNativeDatabase } from "../../scripts/native-database";
import { migrate } from "../../scripts/migrate";
import { provisioningAuth } from "../../lib/collab/auth";
import { asUser, database } from "../../lib/collab/database";
import { createProject } from "../../lib/collab/projects";
import { createTask } from "../../lib/collab/tasks";
import { startRun, runFeed } from "../../lib/collab/runs";
import { registerGitHubInstallation } from "../../lib/collab/git/github-registration";
import { importGitHubRepository } from "../../lib/collab/git/github-import";
import { syncGitHubRepository, reconcileGitHubSync } from "../../lib/collab/git/github-sync";
import { listGitHubSyncs } from "../../lib/collab/git/github-settings";
import { githubFixture, config as githubConfig } from "./fixtures/github";
import { githubGitFixture } from "./fixtures/github-git";
import { gitSource } from "./fixtures/git-source";
const exec = promisify(execFile), config = await localConfig(), native = await startNativeDatabase(config), dbName = `pi_collab_test_${randomBytes(6).toString("hex")}`;
Object.assign(process.env, applicationEnvironment(config), { DATABASE_URL: connectionString(config, false, dbName) });
const admin = new Pool({ connectionString: connectionString(config, true, dbName) }), root = await mkdtemp(path.join(tmpdir(), "pi-collab-sync-db-"));
const master = randomBytes(32), organization = randomUUID(), users: string[] = [];
let project: string, connectionId: string, remoteId = 3000;
before(async () => {
  await migrate(config, dbName); const auth = provisioningAuth(admin);
  for (let i = 0; i < 4; i++) users.push((await auth.api.signUpEmail({ body: { name: `Sync ${i}`, email: `sync${i}@test.invalid`, password: randomBytes(20).toString("hex") } })).user.id);
  await admin.query("INSERT INTO collab.organizations(id,name,created_by) VALUES($1,'Sync test',$2)", [organization, users[0]]);
  for (let i = 0; i < 3; i++) await admin.query("INSERT INTO collab.memberships(organization_id,user_id,role) VALUES($1,$2,$3)", [organization, users[i], i ? "member" : "owner"]);
  await admin.query('UPDATE public."user" SET "twoFactorEnabled"=true WHERE id=ANY($1::text[])', [[users[0], users[2]]]);
  project = (await createProject(users[0], { organizationId: organization, name: "Synchronize repos", description: "" })).id;
  for (let i = 1; i < 3; i++) await admin.query("INSERT INTO collab.project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,$4)", [organization, project, users[i], i === 1 ? "developer" : "maintainer"]);
  const f = await githubFixture(); try { connectionId = (await registerGitHubInstallation(admin, master, { ...githubConfig, organizationId: organization, actorId: users[0], reason: "Register local Git protocol fixtures for sync", idempotencyKey: randomUUID() }, f.pem, f.transport)).connectionId; } finally { await f.close(); }
});
after(async () => {
  master.fill(0); if (globalThis.__piCollabPool) { await database().end(); globalThis.__piCollabPool = undefined; } await admin.end();
  const cleanup = new Pool({ connectionString: connectionString(config, true, "postgres") }); await cleanup.query(`DROP DATABASE "${dbName}" WITH (FORCE)`); await cleanup.end(); await native.stop(); await rm(root, { recursive: true, force: true });
});
async function scenario() {
  const directory = path.join(root, randomUUID()); await mkdir(directory); const next = await gitSource(directory);
  const old = (await exec("git", ["rev-parse", "HEAD^"], { cwd: path.join(directory, "source") })).stdout.trim(), f = await githubGitFixture(directory, ++remoteId);
  const remote = async (...args: string[]) => (await exec("git", args, { cwd: path.join(directory, "source.git") })).stdout.trim();
  await remote("update-ref", "refs/heads/main", old); f.api.state.branch = "main"; f.api.state.sha = old;
  const repo = await importGitHubRepository(admin, directory, master, { projectId: project, actorId: users[0], connectionId, githubRepositoryId: String(remoteId), name: `Sync ${remoteId}`, reason: "Import original baseline before remote development", idempotencyKey: randomUUID() }, { transport: f.transport });
  await remote("update-ref", "refs/heads/main", next); f.api.state.sha = next;
  const input = { repositoryId: repo.id, actorId: users[0], reason: "Fetch and conditionally advance the verified remote default branch", idempotencyKey: randomUUID() };
  const run = (options: NonNullable<Parameters<typeof syncGitHubRepository>[4]> = {}) => syncGitHubRepository(admin, directory, master, input, { transport: f.transport, ...options });
  const row = async () => (await admin.query("SELECT * FROM collab.github_syncs WHERE repository_id=$1 AND idempotency_key=$2", [repo.id, input.idempotencyKey])).rows[0];
  const git = async (...args: string[]) => (await exec("git", args, { cwd: path.join(directory, "repositories", repo.id, "git") })).stdout.trim();
  const base = async () => (await admin.query("SELECT base_sha FROM collab.repositories WHERE id=$1", [repo.id])).rows[0].base_sha;
  return { directory, f, repo, input, old, next, run, row, git, base, remote };
}
test("fast-forward emits one durable baseline, keeps old workspace input and gives new runs the remote SHA", async () => {
  const s = await scenario(); try {
    const oldTask = await createTask(users[0], project, { title: "Pinned old input", description: "", acceptance: "Keep input fixed" });
    await startRun(users[0], oldTask.id, { repositoryId: s.repo.id, baseSha: s.old, prompt: "Old workspace", expectedVersion: oldTask.version, idempotencyKey: randomUUID() });
    const result = await s.run(); assert.equal(result.outcome, "fast_forward"); assert.equal(await s.base(), s.next); assert.equal(await s.git("rev-parse", "HEAD"), s.next);
    const count = s.f.calls.length + s.f.api.calls.length;
    assert.equal((await s.run()).replayed, true); assert.equal(s.f.calls.length + s.f.api.calls.length, count);
    const notifications = (await admin.query("SELECT recipient_id,event_key FROM collab.inbox WHERE task_id=$1 AND kind='repository.baseline'", [oldTask.id])).rows;
    assert.equal(notifications.length, 1); assert.equal(notifications[0].recipient_id, users[0]);
    assert.equal(typeof notifications[0].event_key, "string");
    const pinned = (await admin.query("SELECT w.base_sha FROM collab.workspaces w JOIN collab.runs r ON r.workspace_id=w.id WHERE r.task_id=$1", [oldTask.id])).rows[0]; assert.equal(pinned.base_sha, s.old);
    const task = await createTask(users[0], project, { title: "New baseline", description: "", acceptance: "Use new input" });
    await startRun(users[0], task.id, { repositoryId: s.repo.id, baseSha: s.next, prompt: "New workspace", expectedVersion: task.version, idempotencyKey: randomUUID() });
    const events = (await runFeed(users[1], project)).events.filter(e => e.kind === "repository.baseline_changed" && e.payload.syncId === result.jobId); assert.equal(events.length, 1); assert.equal(events[0].payload.newSha, s.next); assert.equal(events[0].payload.promotionId, null);
    assert.deepEqual((await revertCatalogue(users[1], project)).sources, [], "remote syncs are not supported managed-promotion revert sources");
    assert.equal((await listGitHubSyncs(users[1], project)).syncs[0].outcome, "fast_forward");
    await assert.rejects(listGitHubSyncs(users[3], project), /不存在|not_found|Project not found/);
    assert.equal((await asUser(users[3], db => db.query("SELECT id FROM collab.github_syncs"))).rowCount, 0);
    await assert.rejects(asUser(users[0], db => db.query("UPDATE collab.github_syncs SET status='completed'")), /permission/);
    await assert.rejects(syncGitHubRepository(admin, s.directory, master, { ...s.input, reason: "Changed reason under the same request key" }), /idempotency_conflict/);
  } finally { await s.f.close(); }
});
test("maintainer MFA is checked before provider traffic; concurrent same/other keys cannot race the target", async () => {
  const s = await scenario(); try {
    const count = s.f.api.calls.length;
    for (const user of [users[1], users[3]]) await assert.rejects(syncGitHubRepository(admin, s.directory, master, { ...s.input, actorId: user }, { transport: s.f.transport }), /authority_required/);
    await admin.query('UPDATE public."user" SET "twoFactorEnabled"=false WHERE id=$1', [users[2]]);
    await assert.rejects(syncGitHubRepository(admin, s.directory, master, { ...s.input, actorId: users[2] }, { transport: s.f.transport }), /authority_required/);
    await admin.query('UPDATE public."user" SET "twoFactorEnabled"=true WHERE id=$1', [users[2]]); assert.equal(s.f.api.calls.length, count);
    await s.run({ afterFetch: async () => {
      await assert.rejects(s.run(), /github_sync_busy/);
      await assert.rejects(syncGitHubRepository(admin, s.directory, master, { ...s.input, idempotencyKey: randomUUID() }, { transport: s.f.transport }), /github_sync_target_busy/);
    } });
  } finally { await s.f.close(); }
});
test("equal, locally ahead, diverged and changed-default observations never reset local work", async () => {
  const s = await scenario(); try {
    await s.run(); const run = () => syncGitHubRepository(admin, s.directory, master, { ...s.input, idempotencyKey: randomUUID() }, { transport: s.f.transport });
    assert.equal((await run()).outcome, "equal");
    await s.remote("update-ref", "refs/heads/main", s.old); s.f.api.state.sha = s.old; assert.equal((await run()).outcome, "local_ahead");
    const source = path.join(s.directory, "source"); await exec("git", ["checkout", "--detach", s.old], { cwd: source }); await writeFile(path.join(source, "new.txt"), "remote divergent work\n");
    for (const args of [["add", "."], ["commit", "-m", "Divergent remote work"], ["push", path.join(s.directory, "source.git"), "HEAD:refs/heads/main"]]) await exec("git", args, { cwd: source });
    s.f.api.state.sha = await s.remote("rev-parse", "refs/heads/main"); assert.equal((await run()).outcome, "diverged");
    await s.remote("update-ref", "refs/heads/renamed", s.f.api.state.sha); s.f.api.state.branch = "renamed"; assert.equal((await run()).outcome, "branch_changed");
    assert.equal(await s.git("rev-parse", "HEAD"), s.next); assert.equal(await s.base(), s.next);
    assert.equal((await admin.query("SELECT 1 FROM collab.repository_baselines WHERE repository_id=$1", [s.repo.id])).rowCount, 1);
  } finally { await s.f.close(); }
});
test("abandoned admitted effect is terminally aborted, including after original authority was revoked", async () => {
  const s = await scenario(); try {
    await assert.rejects(s.run({ afterAdmission: async () => { throw new Error("process crashed before prepare"); } }), /outcome_unknown/);
    const job = await s.row(), calls = s.f.api.calls.length;
    await admin.query("UPDATE collab.project_memberships SET active=false,authorization_version=authorization_version+1 WHERE project_id=$1 AND user_id=$2", [project, users[0]]);
    await assert.rejects(s.run(), /authority_required/);
    const recovered = await reconcileGitHubSync(admin, s.directory, job.id, users[2], "A different maintainer reconciles the revoked owner request");
    assert.equal(recovered.outcome, "aborted"); assert.equal(await s.git("rev-parse", "HEAD"), s.old); assert.equal(s.f.api.calls.length, calls);
  } finally { await admin.query("UPDATE collab.project_memberships SET active=true,authorization_version=authorization_version+1 WHERE project_id=$1 AND user_id=$2", [project, users[0]]); await s.f.close(); }
});
test("final authority change blocks apply; same-key reconciliation closes rather than retries", async () => {
  const s = await scenario(); try {
    await assert.rejects(s.run({ beforeApply: async () => { await admin.query("UPDATE collab.project_memberships SET authorization_version=authorization_version+1 WHERE project_id=$1 AND user_id=$2", [project, users[0]]); } }), /outcome_unknown/);
    assert.equal(await s.git("rev-parse", "HEAD"), s.old); assert.equal((await s.run()).outcome, "aborted");
  } finally { await s.f.close(); }
});
test("real PostgreSQL disconnect after target CAS reconciles Git without another fetch or lost baseline", async () => {
  const s = await scenario(); try {
    await assert.rejects(s.run({ afterUpdate: async id => { await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=$1", [`pi-collab-github-sync:${id}`]); await new Promise(r => setTimeout(r, 30)); } }), /outcome_unknown/);
    assert.equal(await s.git("rev-parse", "HEAD"), s.next); assert.equal(await s.base(), s.old); const calls = s.f.api.calls.length;
    assert.equal((await s.run()).outcome, "fast_forward"); assert.equal(await s.base(), s.next); assert.equal(s.f.api.calls.length, calls);
  } finally { await s.f.close(); }
});
test("unexpected target stays occupied even after terminal fencing until discrepancy is corrected", async () => {
  const s = await scenario(); try {
    await assert.rejects(s.run({ afterAdmission: async () => { throw new Error("crash"); } }), /outcome_unknown/);
    // Simulate a same-OS-account out-of-band ref rewrite. With no prepared
    // receipt the remote SHA alone must not be attributed to this operation.
    await exec("git", ["fetch", path.join(s.directory, "source.git"), "main"], { cwd: path.join(s.directory, "repositories", s.repo.id, "git") });
    await s.git("update-ref", "refs/heads/main", s.next);
    assert.equal((await s.run()).status, "blocked");
    await assert.rejects(syncGitHubRepository(admin, s.directory, master, { ...s.input, idempotencyKey: randomUUID() }), /target_busy/);
    await s.git("update-ref", "refs/heads/main", s.old); assert.equal((await s.run()).outcome, "aborted");
  } finally { await s.f.close(); }
});
test("cancel before effect admission fails without a branch write; abandoned fetching cannot restart", async () => {
  const s = await scenario(); try {
    const cancel = new AbortController();
    await assert.rejects(s.run({ signal: cancel.signal, afterFetch: async () => { cancel.abort(); } }), /cancelled|unavailable/);
    assert.equal((await s.row()).status, "failed"); assert.equal(await s.base(), s.old); assert.equal(await s.git("rev-parse", "HEAD"), s.old);
    await admin.query("UPDATE collab.github_syncs SET status='fetching',finished_at=NULL,failure=NULL WHERE id=$1", [(await s.row()).id]);
    const count = s.f.calls.length; await assert.rejects(s.run(), /fetch_abandoned/); assert.equal(s.f.calls.length, count);
  } finally { await s.f.close(); }
});
test("a real TCP-dropped final COMMIT acknowledgement replays one completed sync", async () => {
  const s = await scenario(); const sockets = new Set<Socket>(); let armed = false, dropped = false;
  const proxy = createServer(client => {
    const upstream = createConnection({ host: "127.0.0.1", port: config.databasePort }); sockets.add(client); sockets.add(upstream);
    let final = false;
    client.on("data", chunk => { if (armed && Buffer.from(chunk).includes(Buffer.from("COMMIT"))) final = true; upstream.write(chunk); });
    upstream.on("data", chunk => { if (final && Buffer.from(chunk).includes(Buffer.from("COMMIT"))) { dropped = true; client.destroy(); upstream.destroy(); return; } client.write(chunk); });
    for (const socket of [client, upstream]) { socket.on("error", () => {}); socket.on("close", () => { sockets.delete(socket); client.destroy(); upstream.destroy(); }); }
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve)); const url = new URL(connectionString(config, true, dbName)); url.port = String((proxy.address() as { port: number }).port);
  const through = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 5000, query_timeout: 5000 });
  try {
    await assert.rejects(syncGitHubRepository(through, s.directory, master, s.input, { transport: s.f.transport, beforeCommit: async () => { armed = true; } }), /outcome_unknown/);
    assert.equal(dropped, true); const calls = s.f.api.calls.length; const replay = await s.run(); assert.equal(replay.replayed, true); assert.equal(replay.outcome, "fast_forward"); assert.equal(s.f.api.calls.length, calls);
    assert.equal((await admin.query("SELECT 1 FROM collab.repository_baselines WHERE sync_id=$1", [replay.jobId])).rowCount, 1);
  } finally { await through.end(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => proxy.close(() => resolve())); await s.f.close(); }
});
