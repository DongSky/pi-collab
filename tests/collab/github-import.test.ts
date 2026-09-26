import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, readdir, chmod, rename, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, createConnection, type Socket } from "node:net";
import { Pool } from "pg";
import { localConfig, applicationEnvironment, connectionString, executorConnectionString } from "../../scripts/local-config";
import { startNativeDatabase } from "../../scripts/native-database";
import { migrate } from "../../scripts/migrate";
import { provisioningAuth } from "../../lib/collab/auth";
import { asUser, database } from "../../lib/collab/database";
import { createProject } from "../../lib/collab/projects";
import { createTask } from "../../lib/collab/tasks";
import { startRun } from "../../lib/collab/runs";
import { ExecutionStore } from "../../lib/collab/execution-store";
import { executeClaim } from "../../lib/collab/executor";
import { NativeRuntimeBackend } from "../../lib/collab/runtime/backends";
import { registerGitHubInstallation } from "../../lib/collab/git/github-registration";
import { importGitHubRepository } from "../../lib/collab/git/github-import";
import { listGitHubImports } from "../../lib/collab/git/github-settings";
import { githubFixture, config as githubConfig } from "./fixtures/github";
import { githubGitFixture } from "./fixtures/github-git";
import { gitSource } from "./fixtures/git-source";

const config = await localConfig(), native = await startNativeDatabase(config), dbName = `pi_collab_test_${randomBytes(6).toString("hex")}`;
Object.assign(process.env, applicationEnvironment(config), { DATABASE_URL: connectionString(config, false, dbName) });
const admin = new Pool({ connectionString: connectionString(config, true, dbName) }), worker = new ExecutionStore(executorConnectionString(config, dbName));
const root = await mkdtemp(path.join(tmpdir(), "pi-collab-github-import-")), master = randomBytes(32), organization = randomUUID(), foreignOrganization = randomUUID(), users: string[] = [];
let project: string, foreignProject: string, connectionId: string, sha: string, remoteId = 2000;
before(async () => {
  await migrate(config, dbName); const auth = provisioningAuth(admin);
  for (let i = 0; i < 4; i++) users.push((await auth.api.signUpEmail({ body: { name: `Importer ${i}`, email: `importer${i}@test.invalid`, password: randomBytes(20).toString("hex") } })).user.id);
  for (const [org, owner] of [[organization, users[0]], [foreignOrganization, users[2]]]) {
    await admin.query("INSERT INTO collab.organizations(id,name,created_by) VALUES($1,'Remote import test',$2)", [org, owner]);
    await admin.query("INSERT INTO collab.memberships(organization_id,user_id,role) VALUES($1,$2,'owner')", [org, owner]);
    await admin.query('UPDATE public."user" SET "twoFactorEnabled"=true WHERE id=$1', [owner]);
  }
  await admin.query("INSERT INTO collab.memberships(organization_id,user_id,role) VALUES($1,$2,'member')", [organization, users[1]]);
  project = (await createProject(users[0], { organizationId: organization, name: "Remote imports", description: "" })).id;
  foreignProject = (await createProject(users[2], { organizationId: foreignOrganization, name: "Other imports", description: "" })).id;
  await admin.query("INSERT INTO collab.project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,'developer')", [organization, project, users[1]]);
  await admin.query("INSERT INTO collab.memberships(organization_id,user_id,role) VALUES($1,$2,'member')", [organization, users[3]]);
  await admin.query("INSERT INTO collab.project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,'maintainer')", [organization, project, users[3]]);
  const f = await githubFixture();
  try { connectionId = (await registerGitHubInstallation(admin, master, { ...githubConfig, organizationId: organization, actorId: users[0], idempotencyKey: randomUUID(), reason: "Register an isolated smart HTTP repository source" }, f.pem, f.transport)).connectionId; }
  finally { await f.close(); }
  sha = await gitSource(root);
});
after(async () => {
  master.fill(0); await worker.close(); if (globalThis.__piCollabPool) { await database().end(); globalThis.__piCollabPool = undefined; } await admin.end();
  const cleanup = new Pool({ connectionString: connectionString(config, true, "postgres") }); await cleanup.query(`DROP DATABASE "${dbName}" WITH (FORCE)`); await cleanup.end(); await native.stop(); await rm(root, { recursive: true, force: true });
});
async function scenario() {
  const f = await githubGitFixture(root, ++remoteId); f.api.state.sha = sha; f.api.state.branch = "main";
  const input = { projectId: project, actorId: users[0], connectionId, githubRepositoryId: String(remoteId), name: `Imported repository ${remoteId}`, reason: "Import the verified complete default branch for project development", idempotencyKey: randomUUID() };
  const run = (options: Omit<NonNullable<Parameters<typeof importGitHubRepository>[4]>, "transport"> = {}) => importGitHubRepository(admin, root, master, input, { transport: f.transport, ...options });
  const row = async () => (await admin.query("SELECT * FROM collab.github_imports WHERE idempotency_key=$1", [input.idempotencyKey])).rows[0];
  return { f, input, run, row };
}
test("remote admission enforces project maintainer MFA and installation organization before any provider request", async () => {
  const s = await scenario();
  try {
    for (const changes of [{ actorId: users[1] }, { actorId: users[3] }, { actorId: users[2], projectId: foreignProject }]) await assert.rejects(importGitHubRepository(admin, root, master, { ...s.input, ...changes }, { transport: s.f.transport }), /github_(maintainer_authority_required|connection_unavailable)/);
    assert.equal(s.f.calls.length + s.f.api.calls.length, 0); assert.equal(await s.row(), undefined);
  } finally { await s.f.close(); }
});
test("remote import is durable, scoped and idempotent; a real native Pi starts from the original downloaded Git commit", async () => {
  const s = await scenario();
  try {
    const imported = await s.run(); assert.equal(imported.baseSha, sha); assert.equal(imported.defaultBranch, "main");
    const requestCount = s.f.api.calls.length, again = await s.run(); assert.equal(again.id, imported.id); assert.equal(again.replayed, true); assert.equal(s.f.api.calls.length, requestCount);
    await assert.rejects(importGitHubRepository(admin, root, master, { ...s.input, name: "Altered request" }, { transport: s.f.transport }), /idempotency_conflict/);
    assert.equal((await asUser(users[1], db => db.query("SELECT 1 FROM collab.github_imports WHERE id=$1", [imported.jobId]))).rowCount, 1);
    assert.equal((await asUser(users[2], db => db.query("SELECT 1 FROM collab.github_imports WHERE id=$1", [imported.jobId]))).rowCount, 0);
    assert.equal((await listGitHubImports(users[1], project)).imports[0].baseSha, sha);
    await assert.rejects(listGitHubImports(users[2], project), /not_found|not found|不存在/);
    await assert.rejects(asUser(users[0], db => db.query("UPDATE collab.github_imports SET status='completed'")), /permission/);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM collab.audit_events WHERE action='github.repository_imported' AND resource_id=$1", [imported.id])).rows[0].n, 1);
    const task = await createTask(users[1], project, { title: "Use imported history", description: "", acceptance: "Read verified source without remote credentials" });
    await startRun(users[1], task.id, { repositoryId: imported.id, baseSha: sha, prompt: "Read the imported source", expectedVersion: task.version, idempotencyKey: randomUUID() });
    const executor = randomUUID(), claim = await worker.claim(executor, "native"); assert.ok(claim);
    assert.equal(await executeClaim(worker, executor, claim, { dataRoot: root, backend: new NativeRuntimeBackend(), driver: async agent => {
      await agent.peer.command("bash", { command: "test -z \"$GIT_CONFIG_VALUE_0\" && test -z \"$DATABASE_URL\" && test -z \"$(git remote)\" && cp code.txt verified-source.txt" }); return { diagnostic: true };
    } }), "completed");
    assert.equal(await readFile(path.join(root, "workspaces", claim.workspace.id, "checkout/verified-source.txt"), "utf8"), "second commit\n");
  } finally { await s.f.close(); }
});
test("concurrent same-key import shares one admission and one network transfer; a live operation cannot be replaced", async () => {
  const s = await scenario(); let release!: () => void, started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  s.f.api.state.afterBranch = async () => { started(); await gate; };
  const first = s.run();
  try {
    await ready; await assert.rejects(s.run(), /github_import_busy/);
    await assert.rejects(importGitHubRepository(admin, root, master, { ...s.input, idempotencyKey: randomUUID() }, { transport: s.f.transport }), /github_repository_already_bound/);
    release(); const result = await first; assert.equal((await s.run()).id, result.id);
    assert.equal(s.f.api.calls.filter(c => c.method === "POST").length, 1); assert.equal((await s.row()).status, "completed");
  } finally { release(); await first.catch(() => {}); await s.f.close(); }
});
test("revocation and regrant during download cannot publish a repository under the old authority version", async () => {
  const s = await scenario();
  s.f.api.state.afterBranch = async () => { for (const role of ["developer", "maintainer"]) await admin.query("UPDATE collab.project_memberships SET role=$3 WHERE project_id=$1 AND user_id=$2", [project, users[0], role]); };
  try {
    await assert.rejects(s.run(), /github_import_authority_changed/); const job = await s.row(); assert.equal(job.status, "failed");
    assert.equal((await admin.query("SELECT 1 FROM collab.repositories WHERE id=$1", [job.repository_id])).rowCount, 0);
    assert.equal(s.f.api.state.revoked, 1); await assert.rejects(s.run(), /github_import_authority_changed/);
  } finally { await s.f.close(); }
});
test("disable and re-enable version changes after download invalidate final admission without reviving old observations", async () => {
  const s = await scenario();
  try {
    await assert.rejects(s.run({ beforeFinalize: async () => { await admin.query("UPDATE collab.github_installations SET enabled=false,version=version+1 WHERE id=$1", [connectionId]); await admin.query("UPDATE collab.github_installations SET enabled=true,version=version+1 WHERE id=$1", [connectionId]); } }), /github_connection_unavailable/);
    assert.equal((await s.row()).status, "failed"); assert.equal((await admin.query("SELECT 1 FROM collab.github_bindings WHERE github_repository_id=$1", [s.input.githubRepositoryId])).rowCount, 0);
  } finally { await s.f.close(); }
});
test("an actual database disconnect after the durable receipt recovers the same repository without another HTTP request", async () => {
  const s = await scenario();
  try {
    await assert.rejects(s.run({ beforeFinalize: async jobId => { await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=$1", [`pi-collab-github-import:${jobId}`]); await new Promise(resolve => setTimeout(resolve, 20)); } }), /github_import_outcome_unknown/);
    const job = await s.row(); assert.equal(job.status, "fetching"); assert.equal((await admin.query("SELECT 1 FROM collab.repositories WHERE id=$1", [job.repository_id])).rowCount, 0);
    const recovered = await importGitHubRepository(admin, root, master, s.input, { transport: async () => { throw new Error("Recovery must not use network"); } });
    assert.equal(recovered.id, job.repository_id); assert.equal(recovered.replayed, true); assert.equal((await s.row()).status, "completed");
  } finally { await s.f.close(); }
});
test("explicit cancellation after download but before settlement cannot register a repository", async () => {
  const s = await scenario(), stop = new AbortController();
  try {
    await assert.rejects(s.run({ signal: stop.signal, beforeFinalize: async () => { stop.abort(); } }), /github_request_cancelled/);
    const job = await s.row(); assert.equal(job.status, "failed"); assert.equal(s.f.api.state.revoked, 1);
    assert.equal((await admin.query("SELECT 1 FROM collab.repositories WHERE id=$1", [job.repository_id])).rowCount, 0);
    await assert.rejects(s.run(), /github_request_cancelled/);
  } finally { await s.f.close(); }
});
test("corrupt receipts or Git objects after an interrupted import cannot become visible repositories", async () => {
  for (const kind of ["receipt", "pack", "symlink"]) {
    const s = await scenario();
    try {
      await assert.rejects(s.run({ beforeFinalize: async () => { throw new Error("Interrupted before SQL settlement"); } }), /github_import_outcome_unknown/);
      const job = await s.row(), directory = path.join(root, "repositories", job.repository_id);
      if (kind === "receipt") { const file = path.join(directory, "import-ready.json"), value = JSON.parse(await readFile(file, "utf8")); value.payload += " "; await writeFile(file, JSON.stringify(value)); }
      else if (kind === "pack") { const packs = path.join(directory, "git/objects/pack"), file = (await readdir(packs)).find(name => name.endsWith(".pack")); assert.ok(file); await chmod(path.join(packs, file), 0o600); await writeFile(path.join(packs, file), "corrupt pack"); }
      else { await rename(path.join(directory, "git"), path.join(directory, "git-original")); await symlink(path.join(root, "source.git"), path.join(directory, "git")); }
      await assert.rejects(s.run(), /^Error: github_/); assert.equal((await s.row()).status, "failed");
      assert.equal((await admin.query("SELECT 1 FROM collab.repositories WHERE id=$1", [job.repository_id])).rowCount, 0);
    } finally { await s.f.close(); }
  }
});
test("disconnect before a complete receipt fails closed on retry without re-downloading into the abandoned directory", async () => {
  const s = await scenario();
  s.f.api.state.afterBranch = async () => { const job = await s.row(); await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=$1", [`pi-collab-github-import:${job.id}`]); await new Promise(resolve => setTimeout(resolve, 20)); };
  try {
    await assert.rejects(s.run(), /github_import_outcome_unknown/); assert.equal((await s.row()).status, "fetching");
    const count = s.f.api.calls.length; await assert.rejects(s.run(), /^Error: github_/); assert.equal((await s.row()).status, "failed"); assert.equal(s.f.api.calls.length, count);
    assert.equal((await admin.query("SELECT 1 FROM collab.repositories WHERE id=$1", [(await s.row()).repository_id])).rowCount, 0);
  } finally { await s.f.close(); }
});
test("a failed transfer is terminal for its request; retry never reuses a partially written directory", async () => {
  const s = await scenario(); s.f.state.fail = "cut";
  try {
    await assert.rejects(s.run(), /^Error: github_/); const job = await s.row(); assert.equal(job.status, "failed"); const calls = s.f.calls.length;
    await assert.rejects(s.run(), /^Error: github_/); assert.equal(s.f.calls.length, calls);
    s.f.state.fail = ""; const next = await importGitHubRepository(admin, root, master, { ...s.input, idempotencyKey: randomUUID() }, { transport: s.f.transport });
    assert.notEqual(next.id, job.repository_id); assert.equal((await s.row()).status, "failed");
  } finally { await s.f.close(); }
});
test("dropping the real final COMMIT acknowledgement preserves one imported repository and one completion audit", async () => {
  const s = await scenario(), sockets = new Set<Socket>(); let armed = false, dropped = false;
  const proxy = createServer(client => {
    const upstream = createConnection({ host: "127.0.0.1", port: config.databasePort }); sockets.add(client); sockets.add(upstream); let commit = false, tail = Buffer.alloc(0);
    client.on("data", chunk => { const probe = Buffer.concat([tail, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]); if (armed && !dropped && probe.includes(Buffer.from("COMMIT\0"))) commit = true; tail = probe.subarray(-32); upstream.write(chunk); });
    upstream.on("data", chunk => { if (commit && !dropped) { dropped = true; client.destroy(); upstream.destroy(); } else client.write(chunk); });
    for (const socket of [client, upstream]) { socket.on("error", () => {}); socket.on("close", () => { sockets.delete(socket); client.destroy(); upstream.destroy(); }); }
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve)); const url = new URL(connectionString(config, true, dbName)); url.port = String((proxy.address() as { port: number }).port);
  const remote = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 5000 }); remote.on("error", () => {});
  try {
    await assert.rejects(importGitHubRepository(remote, root, master, s.input, { transport: s.f.transport, beforeFinalize: async () => { armed = true; } }), /github_import_outcome_unknown/);
    assert.equal(dropped, true); assert.equal((await s.row()).status, "completed"); const count = s.f.api.calls.length;
    const replay = await s.run(); assert.equal(replay.replayed, true); assert.equal(s.f.api.calls.length, count);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM collab.audit_events WHERE action='github.repository_imported' AND resource_id=$1", [replay.id])).rows[0].n, 1);
  } finally { for (const socket of sockets) socket.destroy(); await remote.end(); await new Promise<void>(resolve => proxy.close(() => resolve())); await s.f.close(); }
});
