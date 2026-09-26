import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createServer, createConnection, type Socket } from "node:net";
import { Pool } from "pg";
import { localConfig, applicationEnvironment, connectionString, gitConnectionString } from "../../scripts/local-config";
import { startNativeDatabase } from "../../scripts/native-database";
import { migrate } from "../../scripts/migrate";
import { provisioningAuth } from "../../lib/collab/auth";
import { asUser, database } from "../../lib/collab/database";
import { createProject } from "../../lib/collab/projects";
import { registerGitHubInstallation } from "../../lib/collab/git/github-registration";
import { importGitHubRepository } from "../../lib/collab/git/github-import";
import { processGitImport } from "../../lib/collab/git/import-broker";
import { requestGitHubImport, gitHubImportAction, listGitHubImports, gitHubImportOptions } from "../../lib/collab/git/github-settings";
import { githubFixture, config as githubConfig } from "./fixtures/github";
import { githubGitFixture } from "./fixtures/github-git";
import { gitSource } from "./fixtures/git-source";
const exec = promisify(execFile), config = await localConfig(), native = await startNativeDatabase(config), dbName = `pi_collab_test_${randomBytes(6).toString("hex")}`;
Object.assign(process.env, applicationEnvironment(config), { DATABASE_URL: connectionString(config, false, dbName) });
const admin = new Pool({ connectionString: connectionString(config, true, dbName) }), root = await mkdtemp(path.join(tmpdir(), "pi-collab-import-broker-"));
const broker = new Pool({ connectionString: gitConnectionString(config, dbName), connectionTimeoutMillis: 5000 });
const master = randomBytes(32), organization = randomUUID(), otherOrganization = randomUUID(), users: string[] = [];
let project: string, connectionId: string, remoteId = 4000;
before(async () => {
  await migrate(config, dbName); const auth = provisioningAuth(admin);
  for (let i = 0; i < 5; i++) users.push((await auth.api.signUpEmail({ body: { name: `Import ${i}`, email: `import${i}@test.invalid`, password: randomBytes(20).toString("hex") } })).user.id);
  await admin.query("INSERT INTO collab.organizations(id,name,created_by) VALUES($1,'Import team',$3),($2,'Other import team',$4)", [organization, otherOrganization, users[0], users[4]]);
  for (let i = 0; i < 4; i++) await admin.query("INSERT INTO collab.memberships(organization_id,user_id,role) VALUES($1,$2,$3)", [organization, users[i], i === 0 ? "owner" : i === 2 || i === 3 ? "admin" : "member"]);
  await admin.query("INSERT INTO collab.memberships(organization_id,user_id,role) VALUES($1,$2,'owner')", [otherOrganization, users[4]]);
  await admin.query('UPDATE public."user" SET "twoFactorEnabled"=true');
  project = (await createProject(users[0], { organizationId: organization, name: "Import broker repos", description: "" })).id;
  for (let i = 1; i < 3; i++) await admin.query("INSERT INTO collab.project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,'maintainer')", [organization, project, users[i]]);
  const f = await githubFixture(); try { connectionId = (await registerGitHubInstallation(admin, master, { ...githubConfig, organizationId: organization, actorId: users[0], reason: "Register local Git protocol fixtures for import", idempotencyKey: randomUUID() }, f.pem, f.transport)).connectionId; } finally { await f.close(); }
});
after(async () => {
  master.fill(0); await broker.end(); if (globalThis.__piCollabPool) { await database().end(); globalThis.__piCollabPool = undefined; } await admin.end();
  const cleanup = new Pool({ connectionString: connectionString(config, true, "postgres") }); await cleanup.query(`DROP DATABASE "${dbName}" WITH (FORCE)`); await cleanup.end(); await native.stop(); await rm(root, { recursive: true, force: true });
});
async function scenario() {
  const directory = path.join(root, randomUUID()); await mkdir(directory); const sha = await gitSource(directory), f = await githubGitFixture(directory, ++remoteId);
  f.api.state.sha = sha; f.api.state.branch = "main";
  const body = { connectionId, githubRepositoryId: String(remoteId), name: `Web import ${remoteId}`, reason: "Authorize a new project repository from this team installation", idempotencyKey: randomUUID() };
  const request = () => requestGitHubImport(users[0], project, body);
  const process = (options: NonNullable<Parameters<typeof processGitImport>[3]> = {}) => processGitImport(broker, directory, async () => Buffer.from(master), { transport: f.transport, ...options });
  const row = async (id: string) => (await admin.query("SELECT * FROM collab.github_imports WHERE id=$1", [id])).rows[0];
  const published = async (id: string) => (await admin.query("SELECT 1 FROM collab.repositories WHERE id=$1", [id])).rowCount;
  const action = (id: string, kind: "cancel" | "reconcile", actor = users[0]) => gitHubImportAction(actor, id, { action: kind, reason: "Explicit operator decision for the original import", idempotencyKey: randomUUID() });
  const disconnect = async (id: string) => {
    assert.equal((await admin.query("SELECT pg_terminate_backend(pid) AS ended FROM pg_stat_activity WHERE application_name=$1", [`pi-collab-git-import:${id}`])).rows[0]?.ended, true);
    await new Promise(resolve => setTimeout(resolve, 30));
  };
  return { directory, sha, f, body, request, process, row, published, action, disconnect };
}
test("browser imports use a restricted process, preserve exact history and publish only once", async () => {
  const s = await scenario(); try {
    const results = await Promise.all([s.request(), s.request(), s.request()]); assert.equal(new Set(results.map(x => x.jobId)).size, 1); assert.equal(results.filter(x => !x.replayed).length, 1);
    const job = results[0]; assert.equal(await s.published(job.repositoryId), 0); assert.equal(s.f.api.calls.length, 0);
    const result = await s.process(); assert.equal(result.status, "completed"); assert.equal(result.baseSha, s.sha); assert.equal(await s.published(job.repositoryId), 1);
    const repo = path.join(s.directory, "repositories", job.repositoryId, "git");
    assert.equal((await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim(), s.sha);
    assert.equal((await exec("git", ["rev-list", "--count", "HEAD"], { cwd: repo })).stdout.trim(), "2");
    assert.equal((await listGitHubImports(users[1], project)).imports.find(x => x.id === job.jobId).dispatch.state, "done");
    const calls = s.f.api.calls.length; assert.equal(await s.process(), null); assert.equal((await s.request()).replayed, true); assert.equal(s.f.api.calls.length, calls);
    assert.equal((await admin.query("SELECT 1 FROM collab.audit_events WHERE resource_id=$1 AND action='github.repository_imported'", [job.repositoryId])).rowCount, 1);
  } finally { await s.f.close(); }
});
test("project maintainership alone cannot use a team installation; MFA, scope and retry payload are enforced", async () => {
  const s = await scenario(); try {
    assert.equal((await gitHubImportOptions(users[0], project)).installations.length, 1);
    assert.deepEqual(await gitHubImportOptions(users[1], project), { canImport: false, installations: [] });
    for (const actor of [users[1], users[3], users[4]]) await assert.rejects(requestGitHubImport(actor, project, s.body), /forbidden|not_found/);
    // Only fixture provisioning can create an admin without MFA; the product
    // correctly refuses disabling an existing administrator's second factor.
    await admin.query("UPDATE collab.memberships SET role='member' WHERE organization_id=$1 AND user_id=$2", [organization, users[2]]);
    await admin.query('UPDATE public."user" SET "twoFactorEnabled"=false WHERE id=$1', [users[2]]);
    await admin.query("UPDATE collab.memberships SET role='admin' WHERE organization_id=$1 AND user_id=$2", [organization, users[2]]);
    await assert.rejects(requestGitHubImport(users[2], project, s.body), /mfa_required/); await admin.query('UPDATE public."user" SET "twoFactorEnabled"=true WHERE id=$1', [users[2]]);
    await assert.rejects(requestGitHubImport(users[0], project, { ...s.body, connectionId: randomUUID() }), /connection_unavailable/);
    const job = await s.request(); await assert.rejects(requestGitHubImport(users[0], project, { ...s.body, name: "Changed retry payload" }), /idempotency_conflict/);
    await assert.rejects(requestGitHubImport(users[0], project, { ...s.body, idempotencyKey: randomUUID() }), /repository_unavailable/);
    await assert.rejects(s.action(job.jobId, "cancel", users[1]), /forbidden/); await assert.rejects(s.action(job.jobId, "reconcile", users[4]), /not_found/);
    await s.action(job.jobId, "cancel"); assert.equal((await s.process()).status, "failed"); assert.equal(s.f.api.calls.length, 0);
  } finally { await s.f.close(); }
});
test("claims are connection and nonce fenced; the old administrator CLI cannot hijack a Web job", async () => {
  const s = await scenario(), db = await broker.connect(); try {
    const job = await s.request();
    await assert.rejects(importGitHubRepository(admin, s.directory, master, { ...s.body, projectId: project, actorId: users[0] }, { transport: s.f.transport }), /managed_by_broker/);
    assert.equal((await s.row(job.jobId)).status, "pending");
    const claim = (await db.query("SELECT collab_git.claim_import() AS result")).rows[0].result;
    assert.equal(await s.process(), null);
    await assert.rejects(broker.query("SELECT collab_git.begin_import($1,$2)", [job.jobId, claim.claimId]), /claim_lost/);
    await assert.rejects(db.query("SELECT collab_git.begin_import($1,$2)", [job.jobId, randomUUID()]), /claim_lost/);
    await assert.rejects(s.action(job.jobId, "reconcile"), /import_busy/);
    const result = (await db.query("SELECT collab_git.begin_import($1,$2) AS result", [job.jobId, claim.claimId])).rows[0].result; assert.ok(result.sealed);
    await assert.rejects(db.query("SELECT collab_git.begin_import($1,$2)", [job.jobId, claim.claimId]), /claim_lost/);
    await assert.rejects(db.query("SELECT collab_git.finish_import($1,$2,$3)", [job.jobId, claim.claimId, { tokenRevoked: true, targetSha: s.sha }]), /invalid_github_import_evidence/);
    await db.query("SELECT collab_git.fail_import($1,$2,'test_no_transfer')", [job.jobId, claim.claimId]);
    assert.equal(await s.published(job.repositoryId), 0);
  } finally { db.release(true); await s.f.close(); }
});
test("Git role cannot read arbitrary imports or authorization helpers and other services cannot claim", async () => {
  for (const sql of ['SELECT * FROM collab.github_imports', 'SELECT * FROM collab_git.import_dispatch', 'SELECT collab_git.authorize_import($1)', 'SELECT collab_git.import_authority($1,$2)']) {
    await assert.rejects(broker.query(sql, sql.includes('$2') ? [project, users[0]] : sql.includes('$1') ? [randomUUID()] : undefined), /permission/);
  }
  await assert.rejects(asUser(users[0], db => db.query("SELECT collab_git.claim_import()")), /permission/);
  const db = await admin.connect(); try {
    for (const role of ["pi_collab_executor", "pi_collab_gateway", "pi_collab_broker"]) {
      await db.query(`SET ROLE ${role}`); await assert.rejects(db.query("SELECT collab_git.claim_import()"), /permission/); await db.query("RESET ROLE");
    }
  } finally { db.release(); }
});
test("queued cancellation uses no key; cancellation after a complete download still prevents publication", async () => {
  for (const stage of ["queued", "receipt"] as const) {
    const s = await scenario(); try {
      const job = await s.request(), body = { action: "cancel" as const, reason: "Cancel before the repository becomes visible", idempotencyKey: randomUUID() };
      const cancel = async () => { assert.equal((await gitHubImportAction(users[0], job.jobId, body)).replayed, false); assert.equal((await gitHubImportAction(users[0], job.jobId, body)).replayed, true); };
      if (stage === "queued") await cancel();
      const result = stage === "queued" ? await processGitImport(broker, s.directory, async () => { throw new Error("Must not read a key"); }, { transport: s.f.transport }) : await s.process({ afterReceipt: cancel });
      assert.equal(result.status, "failed"); assert.equal((await s.row(job.jobId)).failure, "github_import_cancelled"); assert.equal(await s.published(job.repositoryId), 0);
      if (stage === "queued") assert.equal(s.f.api.calls.length, 0); else assert.ok((await stat(path.join(s.directory, "repositories", job.repositoryId, "import-ready.json"))).isFile());
    } finally { await s.f.close(); }
  }
});
test("org/project permission regrant and installation disable during a transfer defeat final publication", async () => {
  for (const change of ["organization", "project", "installation"] as const) {
    const s = await scenario(); try {
      const job = await s.request();
      assert.equal((await s.process({ afterReceipt: async () => {
        if (change === "installation") await admin.query("UPDATE collab.github_installations SET enabled=false,version=version+1 WHERE id=$1", [connectionId]);
        else if (change === "organization") await admin.query("UPDATE collab.memberships SET authorization_version=authorization_version+2 WHERE organization_id=$1 AND user_id=$2", [organization, users[0]]);
        else await admin.query("UPDATE collab.project_memberships SET authorization_version=authorization_version+2 WHERE project_id=$1 AND user_id=$2", [project, users[0]]);
      } })).status, "failed");
      assert.equal(await s.published(job.repositoryId), 0); assert.match((await s.row(job.jobId)).failure, /authority_changed|connection_unavailable/);
    } finally { await admin.query("UPDATE collab.github_installations SET enabled=true WHERE id=$1", [connectionId]); await s.f.close(); }
  }
});
test("real backend death after receipt needs explicit current authority and recovers without network or App decryption", async () => {
  const s = await scenario(); try {
    const job = await s.request(); await assert.rejects(s.process({ afterReceipt: s.disconnect }), /outcome_unknown/);
    assert.equal((await s.process()).status, "attention"); assert.equal(await s.published(job.repositoryId), 0); assert.equal(await s.process(), null);
    await admin.query("UPDATE collab.project_memberships SET active=false,authorization_version=authorization_version+1 WHERE project_id=$1 AND user_id=$2", [project, users[0]]);
    await s.action(job.jobId, "reconcile", users[2]);
    // HMAC recovery needs its master key, but never accesses/decrypts an App key.
    const saved = (await admin.query("SELECT sealed FROM collab_git.credentials WHERE connection_id=$1", [connectionId])).rows[0].sealed;
    await admin.query("UPDATE collab_git.credentials SET sealed='{}' WHERE connection_id=$1", [connectionId]);
    try {
      assert.equal((await s.process({ transport: async () => { throw new Error("Recovery must not fetch"); } })).status, "completed");
      assert.equal(await s.published(job.repositoryId), 1); assert.equal((await s.row(job.jobId)).evidence.targetSha, s.sha);
    } finally { await admin.query("UPDATE collab_git.credentials SET sealed=$2 WHERE connection_id=$1", [connectionId, saved]); }
  } finally { await admin.query("UPDATE collab.project_memberships SET active=true,authorization_version=authorization_version+1 WHERE project_id=$1 AND user_id=$2", [project, users[0]]); await s.f.close(); }
});
test("missing or corrupted receipts never trigger redownload; cancel of an orphan cannot publish its bytes", async () => {
  for (const damage of ["missing", "receipt", "git", "cancel"] as const) {
    const s = await scenario(); try {
      const job = await s.request();
      await assert.rejects(s.process(damage === "missing" ? { afterClaim: s.disconnect } : { afterReceipt: s.disconnect }), /outcome_unknown/);
      assert.equal((await s.process()).status, "attention");
      const dir = path.join(s.directory, "repositories", job.repositoryId);
      if (damage === "receipt") { const file = path.join(dir, "import-ready.json"); const json = JSON.parse(await readFile(file, "utf8")); json.mac = "0".repeat(64); await writeFile(file, JSON.stringify(json)); }
      if (damage === "git") await exec("git", ["update-ref", "refs/heads/main", "HEAD^"], { cwd: path.join(dir, "git") });
      await s.action(job.jobId, damage === "cancel" ? "cancel" : "reconcile");
      let keyReads = 0, networkReads = 0;
      const result = await processGitImport(broker, s.directory, async () => { keyReads++; return Buffer.from(master); }, { transport: async () => { networkReads++; throw new Error("Must not refetch"); } });
      assert.equal(result.status, "failed"); assert.equal(await s.published(job.repositoryId), 0);
      assert.equal(networkReads, 0); if (damage === "cancel") { assert.equal(keyReads, 0); assert.equal((await s.row(job.jobId)).failure, "github_import_cancelled"); }
      if (damage !== "missing") assert.ok((await stat(dir)).isDirectory());
    } finally { await s.f.close(); }
  }
});
test("a stopped legacy CLI import transfers to Web reconciliation using the same authenticated receipt", async () => {
  const s = await scenario(); try {
    await assert.rejects(importGitHubRepository(admin, s.directory, master, { ...s.body, projectId: project, actorId: users[0] }, {
      transport: s.f.transport, beforeFinalize: async id => {
        assert.equal((await admin.query("SELECT pg_terminate_backend(pid) AS ended FROM pg_stat_activity WHERE application_name=$1", [`pi-collab-github-import:${id}`])).rows[0]?.ended, true);
        await new Promise(resolve => setTimeout(resolve, 30));
      },
    }), /outcome_unknown/);
    const job = await s.request(); assert.equal(job.replayed, true); assert.equal(job.status, "fetching");
    assert.equal((await listGitHubImports(users[0], project)).imports.find(x => x.id === job.jobId).dispatch, null);
    await s.action(job.jobId, "reconcile");
    assert.equal((await s.process({ transport: async () => { throw new Error("No provider traffic during takeover"); } })).status, "completed");
    assert.equal(await s.published(job.repositoryId), 1); assert.equal((await s.row(job.jobId)).evidence.targetSha, s.sha);
  } finally { await s.f.close(); }
});
test("TCP loss of final COMMIT response leaves one published repository and no repeated transfer", async () => {
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
    const job = await s.request(); await assert.rejects(processGitImport(through, s.directory, async () => Buffer.from(master), { transport: s.f.transport, beforeCommit: async () => { armed = true; } }), /outcome_unknown/);
    assert.equal(dropped, true); assert.equal((await s.request()).replayed, true); assert.equal(await s.process(), null); assert.equal(await s.published(job.repositoryId), 1);
    assert.equal((await admin.query("SELECT 1 FROM collab.audit_events WHERE resource_id=$1 AND action='github.repository_imported'", [job.repositoryId])).rowCount, 1);
  } finally { await through.end(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => proxy.close(() => resolve())); await s.f.close(); }
});
