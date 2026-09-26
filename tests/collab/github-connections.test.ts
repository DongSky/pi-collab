import { removeGitHubCredential } from "../../lib/collab/git/github-settings";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, generateKeyPairSync } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Pool } from "pg";
import { localConfig, applicationEnvironment, connectionString, executorConnectionString } from "../../scripts/local-config";
import { startNativeDatabase } from "../../scripts/native-database";
import { migrate } from "../../scripts/migrate";
import { provisioningAuth } from "../../lib/collab/auth";
import { asUser, database } from "../../lib/collab/database";
import { createProject } from "../../lib/collab/projects";
import { importLocalRepository } from "../../lib/collab/repository-import";
import { registerGitHubInstallation, bindGitHubRepository, refreshGitHubInstallation } from "../../lib/collab/git/github-registration";
import { config as githubConfig, githubFixture } from "./fixtures/github";

const config = await localConfig(), native = await startNativeDatabase(config), dbName = `pi_collab_test_${randomBytes(6).toString("hex")}`;
Object.assign(process.env, applicationEnvironment(config), { DATABASE_URL: connectionString(config, false, dbName) });
const admin = new Pool({ connectionString: connectionString(config, true, dbName) }), executor = new Pool({ connectionString: executorConnectionString(config, dbName) });
const root = await mkdtemp(path.join(tmpdir(), "pi-collab-github-")), organization = randomUUID(), otherOrganization = randomUUID(), master = randomBytes(32), users: string[] = [];
let fixture: Awaited<ReturnType<typeof githubFixture>>, project: string, otherProject: string, repository: { id: string; baseSha: string; defaultBranch: string }, otherRepository: typeof repository, connectionId: string;
const registration = { ...githubConfig, organizationId: organization, actorId: "", idempotencyKey: randomUUID(), reason: "Explicit GitHub App registration for this team" };
const bind = (overrides: Partial<Parameters<typeof bindGitHubRepository>[2]> = {}) => ({ repositoryId: repository.id, connectionId, githubRepositoryId: "1011", actorId: users[0], idempotencyKey: randomUUID(), reason: "Bind the exact imported base to the verified GitHub repository", ...overrides });
before(async () => {
  await migrate(config, dbName); fixture = await githubFixture(); const auth = provisioningAuth(admin);
  for (let i = 0; i < 5; i++) users.push((await auth.api.signUpEmail({ body: { name: `GitHub ${i}`, email: `github${i}@test.invalid`, password: randomBytes(20).toString("hex") } })).user.id);
  for (const [id, owner] of [[organization, users[0]], [otherOrganization, users[3]]]) await admin.query("INSERT INTO collab.organizations(id,name,created_by) VALUES($1,'GitHub scope acceptance',$2)", [id, owner]);
  for (let i = 0; i < 4; i++) await admin.query("INSERT INTO collab.memberships(organization_id,user_id,role) VALUES($1,$2,$3)", [organization, users[i], [0, 3].includes(i) ? "owner" : "member"]);
  await admin.query("INSERT INTO collab.memberships(organization_id,user_id,role) VALUES($1,$2,'owner')", [otherOrganization, users[3]]);
  await admin.query('UPDATE public."user" SET "twoFactorEnabled"=true WHERE id=ANY($1)', [[users[0], users[3]]]);
  project = (await createProject(users[0], { organizationId: organization, name: "GitHub binding", description: "" })).id;
  otherProject = (await createProject(users[3], { organizationId: otherOrganization, name: "Separate GitHub scope", description: "" })).id;
  for (const i of [1, 2, 3]) await admin.query("INSERT INTO collab.project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,$4)", [organization, project, users[i], i === 1 ? "developer" : "maintainer"]);
  const source = path.join(root, "source"), exec = promisify(execFile); await mkdir(source);
  for (const args of [["init", "-b", "main"], ["config", "user.name", "GitHub acceptance"], ["config", "user.email", "github@test.invalid"]]) await exec("git", args, { cwd: source });
  await writeFile(path.join(source, "code.txt"), "exact imported base\n"); await exec("git", ["add", "."], { cwd: source }); await exec("git", ["commit", "-m", "Local import"], { cwd: source });
  repository = await importLocalRepository(admin, root, { projectId: project, actorId: users[0], source, name: "Existing native checkout" });
  otherRepository = await importLocalRepository(admin, root, { projectId: otherProject, actorId: users[3], source, name: "Other native checkout" });
  fixture.state.sha = repository.baseSha; fixture.state.branch = repository.defaultBranch; registration.actorId = users[0];
});
after(async () => { master.fill(0); await fixture?.close(); await executor.end(); await admin.end(); if (globalThis.__piCollabPool) { await database().end(); globalThis.__piCollabPool = undefined; } const p = new Pool({ connectionString: connectionString(config, true, "postgres") }); await p.query(`DROP DATABASE "${dbName}" WITH (FORCE)`); await p.end(); await native.stop(); await rm(root, { recursive: true, force: true }); });

test("installation registration requires organization administrator MFA; retries retain one encrypted connection and one audit", async () => {
  for (const actorId of [users[1], users[2], users[4]]) await assert.rejects(registerGitHubInstallation(admin, master, { ...registration, actorId }, fixture.pem, fixture.transport), /github_admin_authority_required/);
  const all = await Promise.all(Array.from({ length: 6 }, () => registerGitHubInstallation(admin, master, registration, fixture.pem, fixture.transport)));
  assert.equal(new Set(all.map(r => r.connectionId)).size, 1); assert.equal(all.filter(r => !r.replayed).length, 1); connectionId = all[0].connectionId;
  await assert.rejects(registerGitHubInstallation(admin, master, { ...registration, reason: "Different input for the same request key" }, fixture.pem, fixture.transport), /idempotency_conflict/);
  await assert.rejects(registerGitHubInstallation(admin, master, { ...registration, organizationId: otherOrganization, actorId: users[3], idempotencyKey: randomUUID() }, fixture.pem, fixture.transport), /github_installation_already_registered/);
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM collab.audit_events WHERE action='github.installation_registered'")).rows[0].n, 1);
  assert.equal((await admin.query("SELECT sealed::text AS value FROM collab_git.credentials")).rows[0].value.includes("BEGIN PRIVATE KEY"), false);
});

test("Web, executor and unrelated members cannot read keys or write provider linkage; admin metadata and project evidence use scoped RLS", async () => {
  for (const user of [users[0], users[1]]) {
    await assert.rejects(asUser(user, db => db.query("SELECT * FROM collab_git.credentials")), /permission/);
    await assert.rejects(asUser(user, db => db.query("UPDATE collab.repositories SET provider='github'")), /permission/);
    await assert.rejects(asUser(user, db => db.query("UPDATE collab.github_installations SET enabled=true")), /permission/);
  }
  await assert.rejects(executor.query("SELECT * FROM collab_git.credentials"), /permission/);
  for (const role of ["pi_collab_app", "pi_collab_executor", "pi_collab_gateway", "pi_collab_broker"]) {
    const privileges = (await admin.query("SELECT has_schema_privilege($1,'collab_git','USAGE') AS schema,has_table_privilege($1,'collab_git.credentials','SELECT') AS credentials", [role])).rows[0];
    assert.deepEqual(privileges, { schema: false, credentials: false }, role);
  }
  assert.equal((await asUser(users[0], db => db.query("SELECT * FROM collab.github_installations"))).rowCount, 1);
  assert.equal((await asUser(users[1], db => db.query("SELECT * FROM collab.github_installations"))).rowCount, 0);
  assert.equal((await asUser(users[4], db => db.query("SELECT * FROM collab.github_installations"))).rowCount, 0);
});

test("project maintainer MFA, installation organization and exact remote default branch/base gate binding without changing local code", async () => {
  for (const actorId of [users[1], users[2], users[4]]) await assert.rejects(bindGitHubRepository(admin, master, bind({ actorId }), fixture.transport), /github_maintainer_authority_required/);
  await assert.rejects(bindGitHubRepository(admin, master, bind({ actorId: users[3], repositoryId: otherRepository.id }), fixture.transport), /github_connection_unavailable/);
  fixture.state.sha = "b".repeat(40); await assert.rejects(bindGitHubRepository(admin, master, bind(), fixture.transport), /github_baseline_mismatch/); fixture.state.sha = repository.baseSha;
  fixture.state.branch = "another-default"; await assert.rejects(bindGitHubRepository(admin, master, bind(), fixture.transport), /github_baseline_mismatch/); fixture.state.branch = repository.defaultBranch;
  assert.equal((await admin.query("SELECT provider,base_sha FROM collab.repositories WHERE id=$1", [repository.id])).rows[0].provider, "local");
});

test("authority revoked during the HTTP request cannot settle a binding, and regrant does not revive the old authorization version", async () => {
  await admin.query('UPDATE public."user" SET "twoFactorEnabled"=true WHERE id=$1', [users[2]]);
  fixture.state.afterBranch = async () => {
    await admin.query("UPDATE collab.project_memberships SET active=false WHERE project_id=$1 AND user_id=$2", [project, users[2]]);
    await admin.query("UPDATE collab.project_memberships SET active=true WHERE project_id=$1 AND user_id=$2", [project, users[2]]);
  };
  try { await assert.rejects(bindGitHubRepository(admin, master, bind({ actorId: users[2] }), fixture.transport), /github_maintainer_authority_required/); }
  finally { fixture.state.afterBranch = undefined; }
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM collab.github_bindings")).rows[0].n, 0);
});

test("installation disable/regrant and a moved local base during HTTP verification invalidate pending binding settlement", async () => {
  fixture.state.afterBranch = async () => {
    await admin.query("UPDATE collab.github_installations SET enabled=false,version=version+1 WHERE id=$1", [connectionId]);
    // Administrative restoration is a fixture only; no public re-enable API exists.
    await admin.query("UPDATE collab.github_installations SET enabled=true,version=version+1 WHERE id=$1", [connectionId]);
  };
  try { await assert.rejects(bindGitHubRepository(admin, master, bind(), fixture.transport), /github_connection_unavailable/); }
  finally { fixture.state.afterBranch = undefined; }
  fixture.state.afterBranch = async () => { await admin.query("UPDATE collab.repositories SET base_sha=$2 WHERE id=$1", [repository.id, "c".repeat(40)]); };
  try { await assert.rejects(bindGitHubRepository(admin, master, bind(), fixture.transport), /github_baseline_mismatch/); }
  finally { fixture.state.afterBranch = undefined; await admin.query("UPDATE collab.repositories SET base_sha=$2 WHERE id=$1", [repository.id, repository.baseSha]); }
});

test("organization authority changes during installation verification cannot register stale administrative intent", async () => {
  fixture.state.afterInstallation = async () => {
    await admin.query("UPDATE collab.memberships SET role='member' WHERE organization_id=$1 AND user_id=$2", [organization, users[0]]);
    await admin.query("UPDATE collab.memberships SET role='owner' WHERE organization_id=$1 AND user_id=$2", [organization, users[0]]);
  };
  try { await assert.rejects(registerGitHubInstallation(admin, master, { ...registration, idempotencyKey: randomUUID() }, fixture.pem, fixture.transport), /github_admin_authority_required/); }
  finally { fixture.state.afterInstallation = undefined; }
});

test("binding retries preserve stable provider identity and read evidence without conferring push or protected merge", async () => {
  const input = bind(), all = await Promise.all(Array.from({ length: 6 }, () => bindGitHubRepository(admin, master, input, fixture.transport)));
  assert.equal(all.filter(r => !r.replayed).length, 1);
  await assert.rejects(bindGitHubRepository(admin, master, { ...input, githubRepositoryId: "1012" }, fixture.transport), /idempotency_conflict/);
  await assert.rejects(bindGitHubRepository(admin, master, bind(), fixture.transport), /github_repository_already_bound/);
  const metadata = (await asUser(users[1], db => db.query("SELECT b.*,collab.github_binding_state(repository_id) AS state FROM collab.github_bindings b"))).rows[0];
  assert.equal(metadata.github_repository_id, "1011"); assert.equal(metadata.state, "observed"); assert.equal(metadata.evidence.tokenRevoked, true); assert.equal(metadata.evidence.capabilities.protectedMerge, false);
  assert.equal((await asUser(users[4], db => db.query("SELECT * FROM collab.github_bindings"))).rowCount, 0);
  const repo = (await admin.query("SELECT provider,base_sha FROM collab.repositories WHERE id=$1", [repository.id])).rows[0]; assert.equal(repo.provider, "github"); assert.equal(repo.base_sha, repository.baseSha);
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM collab.audit_events WHERE action='github.repository_bound'")).rows[0].n, 1);
});

test("administrative disable is versioned, audited and idempotent; it invalidates bound installation authority without deleting code", async () => {
  const key = randomUUID(), args = [connectionId, "3", "Disable this installation and every associated remote authority", key];
  for (const user of [users[1], users[2], users[4]]) await assert.rejects(asUser(user, db => db.query("SELECT collab.disable_github_installation($1,$2,$3,$4)", args)), /forbidden|not_found/);
  const all = await Promise.all(Array.from({ length: 6 }, () => asUser(users[0], async db => (await db.query("SELECT collab.disable_github_installation($1,$2,$3,$4) AS result", args)).rows[0].result)));
  assert.ok(all.every(r => r.version === "4" && r.enabled === false)); assert.equal(all.filter(r => !r.replayed).length, 1);
  await assert.rejects(asUser(users[0], db => db.query("SELECT collab.disable_github_installation($1,$2,$3,$4)", [connectionId, "1", args[2], randomUUID()])), /stale_github_connection/);
  assert.equal((await asUser(users[1], db => db.query("SELECT collab.github_binding_state($1) AS state", [repository.id]))).rows[0].state, "disabled");
  assert.equal((await admin.query("SELECT base_sha FROM collab.repositories WHERE id=$1", [repository.id])).rows[0].base_sha, repository.baseSha);
  const replay = await registerGitHubInstallation(admin, master, registration, fixture.pem, fixture.transport); assert.equal(replay.enabled, false); assert.equal(replay.version, "4");
});

test("installation lifecycle refreshes permissions, rotates verified keys, deletes local credentials and revalidates reconnection",async()=>{
 const initial=String((await admin.query("SELECT version FROM collab.github_installations WHERE id=$1",[connectionId])).rows[0].version);
 const input={connectionId,actorId:users[0],expectedVersion:initial,reason:"Revalidate the same installation and every bound repository",idempotencyKey:randomUUID(),enable:true};
 await assert.rejects(refreshGitHubInstallation(admin,master,{...input,actorId:users[1]},undefined,fixture.transport),/github_admin_authority_required/);
 const refreshed=await refreshGitHubInstallation(admin,master,input,undefined,fixture.transport);assert.equal(refreshed.enabled,true);
 assert.equal((await refreshGitHubInstallation(admin,master,input,undefined,fixture.transport)).replayed,true);
 assert.equal((await asUser(users[1],db=>db.query("SELECT collab.github_binding_state($1) AS state",[repository.id]))).rows[0].state,"observed");
 const pair=generateKeyPairSync("rsa",{modulusLength:2048}),next=await githubFixture(1011,pair);next.state.sha=repository.baseSha;next.state.branch=repository.defaultBranch;
 try{
  const rotated=await refreshGitHubInstallation(admin,master,{...input,expectedVersion:refreshed.version,idempotencyKey:randomUUID()},next.pem,next.transport);
  assert.notEqual(rotated.publicKeyFingerprint,refreshed.publicKeyFingerprint);
  const remove={expectedVersion:rotated.version,idempotencyKey:randomUUID(),reason:"Remove local encrypted key while retaining audit and source code"};
  await assert.rejects(removeGitHubCredential(users[1],connectionId,remove),/forbidden/);
  const removed=await removeGitHubCredential(users[0],connectionId,remove);assert.equal(removed.credentialPresent,false);assert.equal((await removeGitHubCredential(users[0],connectionId,remove)).replayed,true);
  assert.equal((await admin.query("SELECT 1 FROM collab_git.credentials WHERE connection_id=$1",[connectionId])).rowCount,0);
  assert.equal((await asUser(users[1],db=>db.query("SELECT collab.github_binding_state($1) AS state",[repository.id]))).rows[0].state,"disabled");
  const restored=await refreshGitHubInstallation(admin,master,{...input,expectedVersion:removed.version,idempotencyKey:randomUUID()},next.pem,next.transport);assert.equal(restored.enabled,true);assert.equal(restored.credentialPresent,true);
  assert.equal((await admin.query("SELECT base_sha FROM collab.repositories WHERE id=$1",[repository.id])).rows[0].base_sha,repository.baseSha);
 }finally{next.pem.fill(0);await next.close();}
});
