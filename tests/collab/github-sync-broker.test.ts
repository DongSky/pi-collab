import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createServer, createConnection, type Socket } from "node:net";
import { Pool } from "pg";
import { localConfig, applicationEnvironment, connectionString, gitConnectionString, gitEnvironment } from "../../scripts/local-config";
import { startNativeDatabase } from "../../scripts/native-database";
import { migrate } from "../../scripts/migrate";
import { provisioningAuth } from "../../lib/collab/auth";
import { asUser, database } from "../../lib/collab/database";
import { createProject } from "../../lib/collab/projects";
import { runFeed } from "../../lib/collab/runs";
import { registerGitHubInstallation } from "../../lib/collab/git/github-registration";
import { importGitHubRepository } from "../../lib/collab/git/github-import";
import { syncGitHubRepository, reconcileGitHubSync } from "../../lib/collab/git/github-sync";
import { processGitSync } from "../../lib/collab/git/sync-broker";
import { requestGitHubSync, gitHubSyncAction, listGitHubSyncs } from "../../lib/collab/git/github-settings";
import { githubFixture, config as githubConfig } from "./fixtures/github";
import { githubGitFixture } from "./fixtures/github-git";
import { gitSource } from "./fixtures/git-source";
const exec = promisify(execFile), config = await localConfig(), native = await startNativeDatabase(config), dbName = `pi_collab_test_${randomBytes(6).toString("hex")}`;
Object.assign(process.env, applicationEnvironment(config), { DATABASE_URL: connectionString(config, false, dbName) });
const admin = new Pool({ connectionString: connectionString(config, true, dbName) }), root = await mkdtemp(path.join(tmpdir(), "pi-collab-sync-broker-"));
const broker = new Pool({ connectionString: gitConnectionString(config, dbName), connectionTimeoutMillis: 5000 });
const master = randomBytes(32), organization = randomUUID(), users: string[] = [];
let project: string, connectionId: string, remoteId = 3000;
before(async () => {
  await migrate(config, dbName); const auth = provisioningAuth(admin);
  for (let i = 0; i < 4; i++) users.push((await auth.api.signUpEmail({ body: { name: `Sync ${i}`, email: `sync${i}@test.invalid`, password: randomBytes(20).toString("hex") } })).user.id);
  await admin.query("INSERT INTO collab.organizations(id,name,created_by) VALUES($1,'Git broker test',$2)", [organization, users[0]]);
  for (let i = 0; i < 3; i++) await admin.query("INSERT INTO collab.memberships(organization_id,user_id,role) VALUES($1,$2,$3)", [organization, users[i], i ? "member" : "owner"]);
  await admin.query('UPDATE public."user" SET "twoFactorEnabled"=true WHERE id=ANY($1::text[])', [[users[0], users[2]]]);
  project = (await createProject(users[0], { organizationId: organization, name: "Git broker repos", description: "" })).id;
  for (let i = 1; i < 3; i++) await admin.query("INSERT INTO collab.project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,$4)", [organization, project, users[i], i === 1 ? "developer" : "maintainer"]);
  const f = await githubFixture(); try { connectionId = (await registerGitHubInstallation(admin, master, { ...githubConfig, organizationId: organization, actorId: users[0], reason: "Register local Git protocol fixtures for sync", idempotencyKey: randomUUID() }, f.pem, f.transport)).connectionId; } finally { await f.close(); }
});
after(async () => {
  master.fill(0); await broker.end(); if (globalThis.__piCollabPool) { await database().end(); globalThis.__piCollabPool = undefined; } await admin.end();
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
  const body = { expectedSha: old, expectedBranch: "main", acknowledge: true as const, reason: "Authorize safe remote synchronization from this fixed baseline", idempotencyKey: randomUUID() };
  const request = () => requestGitHubSync(users[0], repo.id, body);
  const process = (options: NonNullable<Parameters<typeof processGitSync>[3]> = {}) => processGitSync(broker, directory, async () => Buffer.from(master), { transport: f.transport, ...options });
  return { directory, f, repo, input, old, next, run, row, git, base, remote, body, request, process };
}
test("Web admission and dedicated-role broker preserve remote SHA and one baseline event", async () => {
  const s = await scenario(); try {
    const count = s.f.api.calls.length;
    const all = await Promise.all([s.request(), s.request(), s.request()]); assert.equal(new Set(all.map(x => x.jobId)).size, 1); assert.equal(all.filter(x => !x.replayed).length, 1);
    const id = all[0].jobId; assert.equal(s.f.api.calls.length, count);
    assert.equal((await listGitHubSyncs(users[1], project)).syncs.find(x => x.id === id).dispatch.state, "queued");
    const result = await s.process(); assert.equal(result.outcome, "fast_forward"); assert.equal(await s.base(), s.next); assert.equal(await s.git("rev-parse", "HEAD"), s.next);
    const baseline = (await runFeed(users[1], project)).events.filter(e => e.kind === "repository.baseline_changed" && e.payload.syncId === id); assert.equal(baseline.length, 1);
    const after = s.f.api.calls.length; assert.equal(await s.process(), null); assert.equal((await s.request()).replayed, true); assert.equal(s.f.api.calls.length, after);
    assert.equal((await listGitHubSyncs(users[1], project)).syncs.find(x => x.id === id).dispatch.state, "done");
  } finally { await s.f.close(); }
});
test("queued cancellation never opens a credential or contacts the provider", async () => {
  const s = await scenario(); try {
    const request = await s.request(), action = { action: "cancel" as const, reason: "Cancel the queued sync before any external read", idempotencyKey: randomUUID() };
    assert.equal((await gitHubSyncAction(users[0], request.jobId, action)).replayed, false); assert.equal((await gitHubSyncAction(users[0], request.jobId, action)).replayed, true);
    const count = s.f.api.calls.length;
    const result = await processGitSync(broker, s.directory, async () => { throw new Error("Credential must not be opened"); }, { transport: s.f.transport });
    assert.equal(result.status, "failed"); assert.equal(s.f.api.calls.length, count); assert.equal(await s.base(), s.old);
  } finally { await s.f.close(); }
});
test("Git service has only narrow procedures; Web and other brokers cannot use Git credentials or claim jobs", async () => {
  const environment = gitEnvironment(config);
  assert.equal(new URL(environment.PI_COLLAB_GIT_DATABASE_URL!).username, "pi_collab_git");
  for (const name of ["HOME", "DATABASE_URL", "BETTER_AUTH_SECRET", "PI_COLLAB_EXECUTOR_DATABASE_URL", "PI_COLLAB_GATEWAY_DATABASE_URL", "PI_COLLAB_BROKER_DATABASE_URL"]) assert.equal(environment[name], undefined);
  assert.equal(Object.values(environment).some(value => value?.includes(config.adminPassword)), false);
  for (const sql of ['SELECT * FROM public."user"', 'SELECT * FROM collab_git.credentials', 'SELECT * FROM collab.github_syncs', 'UPDATE collab.repositories SET base_sha=base_sha', 'SELECT collab_git.sync_grant($1)', 'SELECT collab_git.record_sync($1,NULL)']) {
    await assert.rejects(broker.query(sql, sql.includes('$1') ? [randomUUID()] : undefined), /permission/);
  }
  await assert.rejects(asUser(users[0], db => db.query("SELECT collab_git.claim_sync()")), /permission/);
  const connection = await admin.connect(); try {
    for (const role of ["pi_collab_executor", "pi_collab_gateway", "pi_collab_broker"]) {
      await connection.query(`SET ROLE ${role}`);
      await assert.rejects(connection.query("SELECT collab_git.claim_sync()"), /permission/);
      await assert.rejects(connection.query("SELECT * FROM collab_git.credentials"), /permission/);
      await connection.query("RESET ROLE");
    }
  } finally { connection.release(); }
});
test("Web requests require current scoped MFA, explicit acknowledgement, a matching baseline and a fixed retry payload", async () => {
  const s = await scenario(); try {
    for (const actor of [users[1], users[3]]) await assert.rejects(requestGitHubSync(actor, s.repo.id, s.body), /forbidden|not_found/);
    await admin.query('UPDATE public."user" SET "twoFactorEnabled"=false WHERE id=$1', [users[2]]);
    await assert.rejects(requestGitHubSync(users[2], s.repo.id, s.body), /mfa_required/);
    await admin.query('UPDATE public."user" SET "twoFactorEnabled"=true WHERE id=$1', [users[2]]);
    await assert.rejects(requestGitHubSync(users[0], s.repo.id, { ...s.body, expectedSha: s.next }), /stale_github_sync/);
    await assert.rejects(asUser(users[0], db => db.query("SELECT collab.request_github_sync($1,$2,'main',false,$3,$4)", [s.repo.id, s.old, s.body.reason, s.body.idempotencyKey])), /invalid_github_sync/);
    const r = await s.request();
    await assert.rejects(requestGitHubSync(users[0], s.repo.id, { ...s.body, reason: "A different request under the same key" }), /idempotency_conflict/);
    await assert.rejects(requestGitHubSync(users[0], s.repo.id, { ...s.body, idempotencyKey: randomUUID() }), /github_sync_target_busy/);
    for (const actor of [users[1], users[3]]) await assert.rejects(gitHubSyncAction(actor, r.jobId, { action: "cancel", reason: "Unauthorized cancellation attempt on another scope", idempotencyKey: randomUUID() }), /forbidden|not_found/);
    await assert.rejects(reconcileGitHubSync(admin, s.directory, r.jobId, users[0], "Legacy CLI cannot take a job owned by the Git service"), /github_sync_managed_by_broker/);
    await assert.rejects(admin.query("UPDATE collab.github_syncs SET status='fetching' WHERE id=$1", [r.jobId]), /github_sync_managed_by_broker/);
    assert.equal((await s.process()).outcome, "fast_forward");
  } finally { await s.f.close(); }
});
test("one pinned claim excludes another service lane and rejects callbacks on other SQL connections", async () => {
  const s = await scenario(); try {
    await s.request();
    assert.equal((await s.process({ afterClaim: async id => {
      assert.equal(await s.process(), null);
      const d = (await admin.query("SELECT * FROM collab_git.sync_dispatch WHERE sync_id=$1", [id])).rows[0];
      await assert.rejects(broker.query("SELECT collab_git.begin_sync($1,$2)", [id, d.claim_id]), /github_sync_claim_lost/);
      await assert.rejects(gitHubSyncAction(users[2], id, { action: "reconcile", reason: "Cannot replace a live service while its session owns the job", idempotencyKey: randomUUID() }), /github_sync_busy/);
    } })).outcome, "fast_forward");
  } finally { await s.f.close(); }
});
test("cancellation after fetch prevents effect admission; cancellation after intent writes a terminal Git fence", async () => {
  for (const phase of ["afterFetch", "afterIntent"] as const) {
    const s = await scenario(); try {
      await s.request(); const result = await s.process({ [phase]: async (id: string) => { await gitHubSyncAction(users[2], id, { action: "cancel", reason: "Cancel this known phase before the final target gate", idempotencyKey: randomUUID() }); } });
      if (phase === "afterIntent") assert.equal(result.outcome, "aborted"); else assert.equal(result.status, "failed");
      assert.equal(await s.base(), s.old); assert.equal(await s.git("rev-parse", "HEAD"), s.old);
    } finally { await s.f.close(); }
  }
});
test("regrant does not revive original authority and disabling the installation denies the final effect", async () => {
  const first = await scenario(); try {
    await first.request(); const result = await first.process({ beforeGate: async () => { await admin.query("UPDATE collab.project_memberships SET authorization_version=authorization_version+1 WHERE project_id=$1 AND user_id=$2", [project, users[0]]); } });
    assert.equal(result.outcome, "aborted"); assert.equal(await first.base(), first.old);
  } finally { await first.f.close(); }
  const second = await scenario(); try {
    await second.request(); const result = await second.process({ beforeGate: async () => { await admin.query("UPDATE collab.github_installations SET enabled=false,version=version+1 WHERE id=$1", [connectionId]); } });
    assert.equal(result.outcome, "aborted"); assert.equal(await second.git("rev-parse", "HEAD"), second.old);
  } finally {
    // Fixture reset is an administrator-only operation, not a product reenable path.
    await admin.query("UPDATE collab.github_installations SET enabled=true,version=1 WHERE id=$1", [connectionId]); await second.f.close();
  }
});
test("an actual lost backend after CAS requires explicit current-maintainer reconciliation and no key/network", async () => {
  const s = await scenario(); try {
    const request = await s.request();
    await assert.rejects(s.process({ afterUpdate: async id => { await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=$1", [`pi-collab-git-broker:${id}`]); await new Promise(r => setTimeout(r, 30)); } }), /outcome_unknown/);
    assert.equal(await s.git("rev-parse", "HEAD"), s.next); assert.equal(await s.base(), s.old);
    const count = s.f.api.calls.length;
    assert.equal((await s.process()).status, "attention"); assert.equal(await s.process(), null); assert.equal(s.f.api.calls.length, count);
    await admin.query("UPDATE collab.project_memberships SET active=false,authorization_version=authorization_version+1 WHERE project_id=$1 AND user_id=$2", [project, users[0]]);
    await gitHubSyncAction(users[2], request.jobId, { action: "reconcile", reason: "Current maintainer observes the revoked original operation", idempotencyKey: randomUUID() });
    const result = await processGitSync(broker, s.directory, async () => { throw new Error("Reconciliation must not read the master key"); });
    assert.equal(result.outcome, "fast_forward"); assert.equal(await s.base(), s.next); assert.equal(s.f.api.calls.length, count);
    assert.equal((await admin.query("SELECT 1 FROM collab.repository_baselines WHERE sync_id=$1", [request.jobId])).rowCount, 1);
  } finally { await admin.query("UPDATE collab.project_memberships SET active=true,authorization_version=authorization_version+1 WHERE project_id=$1 AND user_id=$2", [project, users[0]]); await s.f.close(); }
});
test("lost fetch ownership is not retried; explicit reconciliation closes it without network", async () => {
  const s = await scenario(); try {
    const r = await s.request();
    await assert.rejects(s.process({ afterFetch: async id => { await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=$1", [`pi-collab-git-broker:${id}`]); await new Promise(r => setTimeout(r, 30)); } }), /outcome_unknown/);
    const calls = s.f.api.calls.length; assert.equal((await s.process()).status, "attention");
    await gitHubSyncAction(users[2], r.jobId, { action: "reconcile", reason: "Explicitly close an abandoned fetch without reusing its directory", idempotencyKey: randomUUID() });
    const done = await s.process(); assert.equal(done.status, "failed"); assert.equal(await s.base(), s.old); assert.equal(s.f.api.calls.length, calls);
  } finally { await s.f.close(); }
});
test("broker settlement rejects forged observations and requires a gate in the same transaction", async () => {
  const s = await scenario(); const db = await broker.connect();
  try {
    await s.request(); const claim = (await db.query("SELECT collab_git.claim_sync() AS result")).rows[0].result, id = claim.job.id, nonce = claim.claimId;
    await db.query("SELECT collab_git.begin_sync($1,$2)", [id, nonce]);
    const evidence = await s.f.client.inspectRepository(String(remoteId));
    const admitted = (await db.query("SELECT collab_git.admit_sync_effect($1,$2,'remote_ahead',$3) AS result", [id, nonce, evidence])).rows[0].result;
    const oid = (await admin.query("SELECT collab_git.sync_oid($1,'applied') AS oid", [admitted.input])).rows[0].oid;
    const fake = { decision: "applied", receiptOid: oid, targetSha: s.next };
    await assert.rejects(db.query("SELECT collab_git.finish_sync($1,$2,$3)", [id, nonce, fake]), /github_sync_gate_required/);
    await db.query("SELECT collab_git.gate_sync($1,$2)", [id, nonce]);
    await assert.rejects(db.query("SELECT collab_git.finish_sync($1,$2,$3)", [id, nonce, fake]), /github_sync_gate_required/);
    await db.query("BEGIN"); await db.query("SELECT collab_git.gate_sync($1,$2)", [id, nonce]);
    await assert.rejects(db.query("SELECT collab_git.finish_sync($1,$2,$3)", [id, nonce, { ...fake, receiptOid: "0".repeat(40) }]), /invalid_github_sync_evidence/); await db.query("ROLLBACK");
    assert.equal(await s.base(), s.old);
    await db.query("SELECT collab_git.fail_sync($1,$2,'test_interruption')", [id, nonce]);
    await gitHubSyncAction(users[2], id, { action: "reconcile", reason: "Fence admitted but not prepared operation after assertions", idempotencyKey: randomUUID() }).catch(error => { assert.match(String(error), /github_sync_busy/); });
  } finally { db.release(true); await s.f.close(); }
  // Terminal receipt is prepared by a later explicit reconciler, not this test's SQL.
});
test("TCP-dropped final COMMIT acknowledgement cannot duplicate a successful broker baseline", async () => {
  const s = await scenario(), sockets = new Set<Socket>(); let armed = false, dropped = false;
  const proxy = createServer(client => {
    const upstream = createConnection({ host: "127.0.0.1", port: config.databasePort }); sockets.add(client); sockets.add(upstream); let final = false;
    client.on("data", chunk => { if (armed && Buffer.from(chunk).includes(Buffer.from("COMMIT"))) final = true; upstream.write(chunk); });
    upstream.on("data", chunk => { if (final && Buffer.from(chunk).includes(Buffer.from("COMMIT"))) { dropped = true; client.destroy(); upstream.destroy(); return; } client.write(chunk); });
    for (const socket of [client, upstream]) { socket.on("error", () => {}); socket.on("close", () => { sockets.delete(socket); client.destroy(); upstream.destroy(); }); }
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve)); const url = new URL(gitConnectionString(config, dbName)); url.port = String((proxy.address() as { port: number }).port);
  const through = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 5000, query_timeout: 5000 });
  try {
    const request = await s.request();
    await assert.rejects(processGitSync(through, s.directory, async () => Buffer.from(master), { transport: s.f.transport, beforeCommit: async () => { armed = true; } }), /outcome_unknown/);
    assert.equal(dropped, true); assert.equal((await s.request()).replayed, true); assert.equal(await s.process(), null); assert.equal(await s.base(), s.next);
    assert.equal((await admin.query("SELECT 1 FROM collab.repository_baselines WHERE sync_id=$1", [request.jobId])).rowCount, 1);
  } finally { await through.end(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => proxy.close(() => resolve())); await s.f.close(); }
});
