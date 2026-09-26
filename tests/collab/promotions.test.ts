import { createRevertTask, revertCatalogue } from "../../lib/collab/reverts";
import { inbox } from "../../lib/collab/discussions";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { createServer, createConnection, type Socket } from "node:net";
import { localConfig, applicationEnvironment, connectionString, executorConnectionString } from "../../scripts/local-config";
import { startNativeDatabase } from "../../scripts/native-database";
import { migrate } from "../../scripts/migrate";
import { provisioningAuth } from "../../lib/collab/auth";
import { asUser, database } from "../../lib/collab/database";
import { coordinate } from "../../lib/collab/coordination-server";
import { createProject } from "../../lib/collab/projects";
import { createTask } from "../../lib/collab/tasks";
import { startRun, runDetail, runFeed } from "../../lib/collab/runs";
import { ExecutionStore } from "../../lib/collab/execution-store";
import { executeClaim } from "../../lib/collab/executor";
import { NativeRuntimeBackend } from "../../lib/collab/runtime/backends";
import { importLocalRepository } from "../../lib/collab/repository-import";
import { requestSnapshot, processSnapshots } from "../../lib/collab/snapshots";
import { createValidationProfile, requestValidation } from "../../lib/collab/validations";
import { executeValidation } from "../../lib/collab/validation-worker";
import { publishResult } from "../../lib/collab/task-results";
import { requestIntegration, integrationDetail, cancelIntegration } from "../../lib/collab/integrations";
import { executeIntegration } from "../../lib/collab/integration-worker";
import { publishIntegrationPolicy, submitIntegrationReview } from "../../lib/collab/integration-reviews";
import { requestPromotion, promotionAction, promotionDetail } from "../../lib/collab/promotions";
import { executePromotion } from "../../lib/collab/promotion-worker";
import { prepareLocalPromotion, applyLocalPromotion, abortLocalPromotion, localPromotionCommit, observeLocalPromotion } from "../../lib/collab/runtime/local-promotion";
import { registerGitHubInstallation, bindGitHubRepository } from "../../lib/collab/git/github-registration";
import { syncGitHubRepository } from "../../lib/collab/git/github-sync";
import { githubFixture, config as githubConfig } from "./fixtures/github";
import type { PromotionClaim } from "../../lib/collab/promotion-schema";

const config = await localConfig(), dbName = `pi_collab_test_${randomBytes(6).toString("hex")}`, native = await startNativeDatabase(config);
Object.assign(process.env, applicationEnvironment(config), { DATABASE_URL: connectionString(config, false, dbName) });
const admin = new Pool({ connectionString: connectionString(config, true, dbName) }), store = new ExecutionStore(executorConnectionString(config, dbName));
const root = await mkdtemp(path.join(tmpdir(), "pi-collab-promotions-")), source = path.join(root, "source"), exec = promisify(execFile), organization = randomUUID(), executor = randomUUID(), users: string[] = [];
process.env.PI_COLLAB_DATA_DIR = root;
let project: string, repository: { id: string; baseSha: string; defaultBranch: string }, profileId: string, policyId: string, resultId: string, sourceWorkspace: string;
const signal = () => AbortSignal.timeout(120_000);
const git = async (...args: string[]) => (await exec("git", args, { cwd: path.join(root, "repositories", repository.id, "git") })).stdout.trim();
const row = async (id: string) => (await promotionDetail(users[0], id)).promotion;
const action = (id: string, kind: "cancel" | "reconcile") => promotionAction(users[0], id, { action: kind, reason: "Explicit maintainer operation for promotion acceptance", idempotencyKey: randomUUID() });
const request = (revision: string) => ({ revisionHash: revision, acknowledgeExcluded: true as const, reason: "Promote this independently reviewed fixed candidate locally", idempotencyKey: randomUUID() });
const revision = async (id: string) => (await integrationDetail(users[0], id)).integration.review_state.revisionHash as string;
async function review(id: string, user = users[2], decision: "approve" | "request_changes" | "withdraw" = "approve") {
  const s = (await integrationDetail(user, id)).integration.review_state;
  return submitIntegrationReview(user, id, { revisionHash: s.revisionHash, expectedVersion: s.ownVersion, decision, note: "Independently checked the fixed code, profile and excluded scope", idempotencyKey: randomUUID() });
}
async function candidate(approved = true) {
  const q = await requestIntegration(users[1], project, { repositoryId: repository.id, targetSha: repository.baseSha, resultIds: [resultId], profileId, expectedPolicyId: policyId, idempotencyKey: randomUUID() });
  const c = await store.claimIntegration(executor); assert.ok(c); assert.equal(c.id, q.integrationId);
  assert.equal(await executeIntegration(store, c, root), "checked");
  if (approved) await review(c.id);
  return c.id;
}
async function promotion(id?: string) { const integration = id ?? await candidate(); const p = await requestPromotion(users[0], integration, request(await revision(integration))); const c = await store.claimPromotion(executor); assert.ok(c); assert.equal(c.id, p.promotionId); return c; }
async function reconcile(c: PromotionClaim) { await action(c.id, "reconcile"); const next = await store.claimPromotion(executor); assert.ok(next); assert.equal(next.id, c.id); assert.equal(next.mode, "reconcile"); return next; }
before(async () => {
  await migrate(config, dbName); const auth = provisioningAuth(admin);
  for (let i = 0; i < 5; i++) users.push((await auth.api.signUpEmail({ body: { name: `Promotion ${i}`, email: `promotion${i}@test.invalid`, password: randomBytes(20).toString("hex") } })).user.id);
  await admin.query("INSERT INTO collab.organizations(id,name,created_by) VALUES($1,'Promotion acceptance',$2)", [organization, users[0]]);
  for (let i = 0; i < 4; i++) await admin.query("INSERT INTO collab.memberships(organization_id,user_id,role) VALUES($1,$2,$3)", [organization, users[i], i === 0 ? "owner" : "member"]);
  await admin.query('UPDATE public."user" SET "twoFactorEnabled"=true WHERE id=$1', [users[0]]);
  project = (await createProject(users[0], { organizationId: organization, name: "Local promotion", description: "" })).id;
  for (let i = 1; i < 4; i++) await admin.query("INSERT INTO collab.project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,$4)", [organization, project, users[i], i === 3 ? "maintainer" : "developer"]);
  await mkdir(source);
  for (const args of [["init", "-b", '主分支/"quoted'], ["config", "user.name", "Promotion acceptance"], ["config", "user.email", "promotion@test.invalid"]]) await exec("git", args, { cwd: source });
  await writeFile(path.join(source, "code.txt"), "baseline\n"); await writeFile(path.join(source, ".env"), "PRIVATE_FIXTURE=preserved\n");
  await exec("git", ["add", "."], { cwd: source }); await exec("git", ["commit", "-m", "Imported baseline"], { cwd: source });
  repository = await importLocalRepository(admin, root, { projectId: project, actorId: users[0], source, name: "Native promotion target" });
  profileId = (await createValidationProfile(users[0], project, { repositoryId: repository.id, name: "Required native check", idempotencyKey: randomUUID(), config: { version: 1, steps: [{ tool: "node", args: ["-e", "require('node:assert/strict').equal(require('node:fs').readFileSync('code.txt','utf8'),'baseline\\n')"], timeoutSeconds: 10 }] } })).profileId;
  policyId = (await publishIntegrationPolicy(users[0], project, { repositoryId: repository.id, profileId, requiredApprovals: 1, reviewerApprovals: true, expectedVersion: 0, reason: "Require an independent current review before local delivery", idempotencyKey: randomUUID() })).policyId;
  const t = await createTask(users[1], project, { title: "Real Pi source", description: "", acceptance: "Preserve baseline and add feature" });
  await startRun(users[1], t.id, { repositoryId: repository.id, baseSha: repository.baseSha, prompt: "Local promotion diagnostic", expectedVersion: t.version, idempotencyKey: randomUUID() });
  const c = await store.claim(executor, "native"); assert.ok(c); sourceWorkspace = c.workspace.id;
  assert.equal(await executeClaim(store, executor, c, { dataRoot: root, backend: new NativeRuntimeBackend(), driver: async agent => { await agent.peer.command("bash", { command: "printf feature > feature.txt" }); return { kind: "real-pi-promotion-input", modelInference: false }; } }), "completed");
  const run = (await runDetail(users[1], c.run.id)).run, snapshot = await requestSnapshot(users[1], run.id, { expectedRevision: run.revision, idempotencyKey: randomUUID(), note: "Immutable source for promotion acceptance" });
  await processSnapshots(store, root); await requestValidation(users[1], snapshot.snapshotId, { profileId, idempotencyKey: randomUUID() });
  const v = await store.claimValidation(executor); assert.ok(v); assert.equal(await executeValidation(store, v, root), "passed");
  resultId = (await publishResult(users[1], t.id, { validationId: v.id, expectedVersion: (await admin.query("SELECT version FROM collab.tasks WHERE id=$1", [t.id])).rows[0].version, idempotencyKey: randomUUID(), note: "Checked source for independent integration review" })).resultId;
});
after(async () => { await store.close(); if (globalThis.__piCollabPool) { await database().end(); globalThis.__piCollabPool = undefined; } await admin.end(); const cleanup = new Pool({ connectionString: connectionString(config, true, "postgres") }); await cleanup.query(`DROP DATABASE "${dbName}" WITH (FORCE)`); await cleanup.end(); await native.stop(); await rm(root, { recursive: true, force: true }); });

test("admission requires maintainer MFA and current independent reviews; concurrent retries pin one operation with SQL/TypeScript-identical Git IDs", async () => {
  const id = await candidate(false), input = request(await revision(id));
  await assert.rejects(requestPromotion(users[0], id, input), /promotion_not_ready/);
  await review(id);
  for (const u of [users[1], users[2], users[4]]) await assert.rejects(requestPromotion(u, id, input), /forbidden|not_found/);
  await assert.rejects(requestPromotion(users[3], id, input), /mfa_required/);
  await assert.rejects(requestPromotion(users[0], id, { ...input, revisionHash: "e".repeat(64) }), /promotion_not_ready/);
  const all = await Promise.all(Array.from({ length: 8 }, () => requestPromotion(users[0], id, input)));
  assert.equal(new Set(all.map(p => p.promotionId)).size, 1); assert.equal(all.filter(p => !p.replayed).length, 1);
  const p = await row(all[0].promotionId); assert.equal(p.promotion_sha, localPromotionCommit(p.input).oid);
  await assert.rejects(requestPromotion(users[0], id, { ...input, reason: "A different request with the same key" }), /idempotency_conflict/);
  await assert.rejects(requestPromotion(users[0], id, { ...input, idempotencyKey: randomUUID() }), /promotion_target_busy/);
  await assert.rejects(promotionDetail(users[4], p.id), /不存在/);
  await assert.rejects(asUser(users[0], db => db.query("UPDATE collab.promotions SET status='applied'")), /permission/);
  await assert.rejects(store.pool.query("SELECT collab_worker.promotion_grant($1)", [p.id]), /permission/);
  const c = await store.claimPromotion(executor); assert.ok(c);
  await action(c.id, "cancel"); assert.equal((await row(c.id)).status, "preparing");
  assert.equal(await executePromotion(store, c, root), "aborted");
  const observed = await observeLocalPromotion(root, c.input, signal());
  assert.equal(observed.receiptOid, (await admin.query("SELECT collab_worker.promotion_oid($1,'aborted') AS oid", [c.input])).rows[0].oid);
  assert.equal((await requestPromotion(users[0], id, input)).status, "aborted");
});

test("all integration adapters respect promotion occupancy; cancelled preparation writes a terminal fence and releases the target", async () => {
  const id = await candidate(), p = await requestPromotion(users[0], id, request(await revision(id)));
  const queued = await requestIntegration(users[1], project, { repositoryId: repository.id, targetSha: repository.baseSha, resultIds: [resultId], profileId, expectedPolicyId: policyId, idempotencyKey: randomUUID() });
  assert.equal((await store.pool.query("SELECT collab_worker.claim_integration($1) AS result", [executor])).rows[0].result, null);
  assert.equal(await store.claimIntegration(executor), null);
  const c = await store.claimPromotion(executor); assert.ok(c); assert.equal(c.id, p.promotionId);
  await action(c.id, "cancel"); assert.equal(await executePromotion(store, c, root), "aborted");
  const i = await store.claimIntegration(executor); assert.ok(i); assert.equal(i.id, queued.integrationId);
  assert.equal(await executeIntegration(store, i, root), "checked");
  assert.equal((await prepareLocalPromotion(root, c.input, signal())).observation.decision, "aborted");
});

test("remote sync and every integration/promotion adapter share target occupancy", async () => {
  const f = await githubFixture(), master = randomBytes(32), operation = randomUUID();
  try {
    const connection = await registerGitHubInstallation(admin, master, { ...githubConfig, organizationId: organization, actorId: users[0], reason: "Verify shared target occupancy with remote sync", idempotencyKey: randomUUID() }, f.pem, f.transport);
    f.state.sha = repository.baseSha; f.state.branch = repository.defaultBranch;
    await bindGitHubRepository(admin, master, { repositoryId: repository.id, connectionId: connection.connectionId, githubRepositoryId: "1011", actorId: users[0], reason: "Bind exact local baseline for scheduling acceptance", idempotencyKey: randomUUID() }, f.transport);
    const id = await candidate(), requestKey = randomUUID();
    await admin.query("INSERT INTO collab.github_syncs(id,organization_id,project_id,repository_id,connection_id,github_repository_id,installation_version,actor_id,organization_version,project_version,idempotency_key,request,target_branch,old_sha) VALUES($1,$2,$3,$4,$5,'1011',1,$6,1,1,$7,'{}',$8,$9)", [operation, organization, project, repository.id, connection.connectionId, users[0], requestKey, repository.defaultBranch, repository.baseSha]);
    await assert.rejects(requestPromotion(users[0], id, request(await revision(id))), /promotion_target_busy/);
    const queued = await requestIntegration(users[1], project, { repositoryId: repository.id, targetSha: repository.baseSha, resultIds: [resultId], profileId, expectedPolicyId: policyId, idempotencyKey: randomUUID() });
    assert.equal((await store.pool.query("SELECT collab_worker.claim_integration($1) AS result", [executor])).rows[0].result, null);
    assert.equal(await store.claimIntegration(executor), null);
    await admin.query("UPDATE collab.github_syncs SET status='failed',finished_at=now() WHERE id=$1", [operation]);
    const c = await store.claimIntegration(executor); assert.ok(c); assert.equal(c.id, queued.integrationId);
    const syncInput = { repositoryId: repository.id, actorId: users[0], reason: "Synchronize only after existing target operations settle", idempotencyKey: randomUUID() };
    const count = f.calls.length;
    await assert.rejects(syncGitHubRepository(admin, root, master, syncInput, { transport: f.transport }), /github_sync_target_busy/);
    assert.equal(await executeIntegration(store, c, root), "checked");
    const promotion = await requestPromotion(users[0], id, request(await revision(id)));
    await assert.rejects(syncGitHubRepository(admin, root, master, syncInput, { transport: f.transport }), /github_sync_target_busy/);
    assert.equal(f.calls.length, count);
    const p = await store.claimPromotion(executor); assert.ok(p); assert.equal(p.id, promotion.promotionId);
    await action(p.id, "cancel"); assert.equal(await executePromotion(store, p, root), "aborted");
  } finally { master.fill(0); await f.close(); }
});

test("review changes after durable intent deny the final gate without writing the target", async () => {
  const c = await promotion();
  assert.equal(await executePromotion(store, c, root, undefined, 5000, { afterIntent: async () => { await review(c.input.integrationId, users[2], "withdraw"); } }), "aborted");
  assert.equal(await git("rev-parse", "HEAD"), repository.baseSha);
  assert.equal((await row(c.id)).effect_grant.approvalIds.length, 1);
});

test("source, requester and blocker authority are rechecked before an effect can be admitted", async () => {
  const c = await promotion();
  assert.equal(await executePromotion(store, c, root, undefined, 5000, { afterPreparation: async () => {
    await admin.query("UPDATE collab.project_memberships SET active=false WHERE project_id=$1 AND user_id=$2", [project, users[2]]);
  } }), "aborted");
  await admin.query("UPDATE collab.project_memberships SET active=true WHERE project_id=$1 AND user_id=$2", [project, users[2]]);
  const d = await promotion();
  assert.equal(await executePromotion(store, d, root, undefined, 5000, { afterIntent: async () => { await review(d.input.integrationId, users[1], "request_changes"); } }), "aborted");
});

test("expired workers retain occupancy; explicit reconciliation fences late preparation and rejects stale callbacks", async () => {
  const c = await promotion();
  await admin.query("UPDATE collab.promotions SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [c.id]);
  assert.equal(await store.claimPromotion(executor), null); assert.equal((await row(c.id)).status, "unknown");
  await assert.rejects(store.heartbeatPromotion(c), /promotion_lease_lost/);
  const next = await reconcile(c); assert.notEqual(next.epoch, c.epoch);
  assert.equal(await executePromotion(store, next, root), "aborted");
  assert.equal((await prepareLocalPromotion(root, c.input, signal())).observation.decision, "aborted");
  await assert.rejects(store.finishPromotion(c, await observeLocalPromotion(root, c.input, signal()), null), /promotion_lease_lost/);
});

test("a forged applied observation without a durable effect admission cannot advance the baseline", async () => {
  const c = await promotion();
  const observed = { decision: "applied" as const, receiptRef: `refs/pi-collab/promotions/${c.id}`, receiptOid: (await admin.query("SELECT collab_worker.promotion_oid($1,'applied') AS oid", [c.input])).rows[0].oid, promotionSha: c.promotionSha, applicationEvidence: "receipt" as const, targetSha: c.promotionSha, targetMatchesExpected: false, appliedTargetCurrent: true };
  await assert.rejects(store.finishPromotion(c, observed, null), /invalid_promotion/);
  await action(c.id, "cancel"); assert.equal(await executePromotion(store, c, root), "aborted");
});

test("Git write followed by a failed acknowledgement is reconciled once; the original source workspace stays pinned", async () => {
  const before = repository.baseSha, c = await promotion();
  assert.equal(await executePromotion(store, c, root, undefined, 5000, { afterTargetUpdate: async () => { throw new Error("promotion_simulated_crash"); } }), "unknown");
  assert.equal(await git("rev-parse", "HEAD"), c.promotionSha);
  assert.equal((await admin.query("SELECT base_sha FROM collab.repositories WHERE id=$1", [repository.id])).rows[0].base_sha, before);
  const next = await reconcile(c); assert.equal(await executePromotion(store, next, root), "applied");
  const observed = await observeLocalPromotion(root, c.input, signal());
  assert.equal(observed.receiptOid, (await admin.query("SELECT collab_worker.promotion_oid($1,'applied') AS oid", [c.input])).rows[0].oid);
  assert.equal(await store.finishPromotion(next, observed, null), "applied");
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM collab.repository_baselines WHERE promotion_id=$1", [c.id])).rows[0].n, 1);
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM collab.audit_events WHERE resource_id=$1 AND action='promotion.applied'", [c.id])).rows[0].n, 1);
  assert.equal((await exec("git", ["rev-parse", "HEAD"], { cwd: source })).stdout.trim(), before);
  assert.equal((await exec("git", ["rev-parse", "HEAD"], { cwd: path.join(root, "workspaces", sourceWorkspace, "checkout") })).stdout.trim(), before);
  assert.equal(await readFile(path.join(root, "workspaces", sourceWorkspace, "checkout/feature.txt"), "utf8"), "feature");
  assert.ok((await inbox(users[3])).items.some(n=>n.kind==="integration.checked"));
  const notifications=await inbox(users[1]);
  assert.ok(notifications.items.some(n=>n.kind==="repository.baseline"));
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM collab.inbox i JOIN collab.repository_baselines b ON i.event_key='baseline:'||b.project_id::text||':'||b.sequence::text||':'||i.task_id::text WHERE i.recipient_id=$1 AND b.promotion_id=$2",[users[1],c.id])).rows[0].n,1);
  const feed = await runFeed(users[1], project);
  assert.equal(feed.events.filter(e => e.kind === "repository.baseline_changed" && e.payload.promotionId === c.id).length, 1);
  repository.baseSha = c.promotionSha;
});

test("normal promotion settles the new baseline and a terminal retry cannot restore an older base", async () => {
  const c = await promotion(); assert.equal(await executePromotion(store, c, root), "applied");
  const previous = (await admin.query("SELECT * FROM collab.promotions WHERE status='applied' AND id<>$1 LIMIT 1", [c.id])).rows[0]; assert.ok(previous);
  assert.equal(await store.finishPromotion({ ...c, id: previous.id, executorId: previous.executor_id, epoch: String(previous.epoch) }, previous.observation, null), "applied");
  assert.equal((await admin.query("SELECT base_sha FROM collab.repositories WHERE id=$1", [repository.id])).rows[0].base_sha, c.promotionSha);
  assert.equal(await git("rev-parse", "HEAD^{tree}"), c.input.candidateTree);
  assert.equal(await git("show", "HEAD:.env"), "PRIVATE_FIXTURE=preserved");
  repository.baseSha = c.promotionSha;
});

test("old tasks receive a baseline notice at context reads; new runs start from the promoted baseline without rewriting old workspaces", async () => {
  const old = (await admin.query("SELECT id FROM collab.runs WHERE workspace_id=$1", [sourceWorkspace])).rows[0].id;
  const context = (await admin.query("SELECT collab_worker.coordination_context(r,$2,0) AS context FROM collab.runs r WHERE r.id=$1", [old, repository.id])).rows[0].context;
  assert.equal(context.baseline.changed, true); assert.equal(context.baseline.currentSha, repository.baseSha);
  const task = await createTask(users[1], project, { title: "New promoted baseline consumer", description: "", acceptance: "Uses current promoted code" });
  await startRun(users[1], task.id, { repositoryId: repository.id, baseSha: repository.baseSha, prompt: "New baseline diagnostic", expectedVersion: task.version, idempotencyKey: randomUUID() });
  const c = await store.claim(executor, "native"); assert.ok(c); assert.equal(c.workspace.base_sha, repository.baseSha);
  assert.equal(await executeClaim(store, executor, c, { dataRoot: root, backend: new NativeRuntimeBackend(), driver: async agent => {
    const next = await coordinate(store, executor, c.run.id, c.run.epoch, "get_context", {});
    assert.equal(next.baseline.changed, false); assert.equal(next.baseline.currentSha, repository.baseSha);
    await agent.peer.command("bash", { command: "test $(cat feature.txt) = feature" }); return { kind: "promoted-baseline", modelInference: false };
  } }), "completed");
  assert.equal((await exec("git", ["rev-parse", "HEAD"], { cwd: path.join(root, "workspaces", c.workspace.id, "checkout") })).stdout.trim(), repository.baseSha);
});

async function transport(dropCommit = false) {
  let online = true, dropped = false;
  const sockets = new Set<Socket>();
  const proxy = createServer(client => {
    if (!online) { client.destroy(); return; }
    const upstream = createConnection({ host: "127.0.0.1", port: config.databasePort });
    let tail = Buffer.alloc(0), commit = false;
    for (const socket of [client, upstream]) { sockets.add(socket); socket.on("error", () => { client.destroy(); upstream.destroy(); }); socket.on("close", () => sockets.delete(socket)); }
    client.on("data", chunk => { const probe = Buffer.concat([tail, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]); if (dropCommit && !dropped && probe.includes(Buffer.from("COMMIT\0"))) commit = true; tail = probe.subarray(Math.max(0, probe.length - 32)); upstream.write(chunk); });
    upstream.on("data", chunk => { if (commit) { dropped = true; client.destroy(); upstream.destroy(); } else client.write(chunk); });
    client.on("end", () => upstream.end()); upstream.on("end", () => client.end());
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const url = new URL(executorConnectionString(config, dbName)); url.port = String((proxy.address() as { port: number }).port);
  const remote = new ExecutionStore(url.toString());
  return { remote, dropped: () => dropped, cut: () => { online = false; for (const s of sockets) s.destroy(); }, async close() { for (const s of sockets) s.destroy(); await remote.close(); await new Promise<void>(resolve => proxy.close(() => resolve())); } };
}
async function until(predicate: () => Promise<boolean>) { const end = Date.now() + 10000; while (!await predicate()) { if (Date.now() > end) throw new Error("promotion_test_timeout"); await new Promise(resolve => setTimeout(resolve, 15)); } }

test("the final authority transaction holds concurrent review changes until Git and baseline settlement finish", async () => {
  const c = await promotion(); let change: Promise<unknown> | undefined, settled = false;
  const input = { revisionHash: c.input.revisionHash, expectedVersion: 1, decision: "withdraw" as const, note: "Concurrent review change must wait for the final authority gate", idempotencyKey: randomUUID() };
  assert.equal(await executePromotion(store, c, root, undefined, 30, { afterTargetUpdate: async () => {
    change = submitIntegrationReview(users[2], c.input.integrationId, input).then(() => "changed", error => error.message).finally(() => { settled = true; });
    await until(async () => (await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND wait_event='advisory' AND query LIKE '%submit_integration_review%'", [dbName])).rows[0].n > 0);
    assert.equal(settled, false);
  } }), "applied");
  assert.equal(await change, "integration_not_reviewable"); repository.baseSha = c.promotionSha;
});

test("an actual TCP cut after target CAS leaves durable intent and occupancy until terminal Git reconciliation", async () => {
  const c = await promotion(), t = await transport();
  try {
    await assert.rejects(executePromotion(t.remote, c, root, undefined, 30, { afterTargetUpdate: async () => { t.cut(); await new Promise(resolve => setTimeout(resolve, 50)); } }));
    assert.equal(await git("rev-parse", "HEAD"), c.promotionSha);
    assert.equal((await row(c.id)).status, "applying");
    assert.equal((await admin.query("SELECT base_sha FROM collab.repositories WHERE id=$1", [repository.id])).rows[0].base_sha, repository.baseSha);
  } finally { await t.close(); }
  await admin.query("UPDATE collab.promotions SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [c.id]);
  assert.equal(await store.claimPromotion(executor), null); assert.equal((await row(c.id)).status, "unknown");
  const next = await reconcile(c); assert.equal(await executePromotion(store, next, root), "applied"); repository.baseSha = c.promotionSha;
});

test("dropping the actual SQL COMMIT response cannot undo success or duplicate the baseline event", async () => {
  const c = await promotion(), t = await transport(true);
  try { assert.equal(await executePromotion(t.remote, c, root), "applied"); assert.equal(t.dropped(), true); }
  finally { await t.close(); }
  const p = await row(c.id); assert.equal(p.status, "applied");
  assert.equal(await store.finishPromotion(c, p.observation, null), "applied");
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM collab.repository_baselines WHERE promotion_id=$1", [c.id])).rows[0].n, 1);
  repository.baseSha = c.promotionSha;
});

test("managed revert binds a promoted delta, runs real Pi on an inverse commit, and requires fresh independent delivery", async () => {
  const source = (await admin.query("SELECT id,input,promotion_sha FROM collab.promotions WHERE status='applied' ORDER BY requested_at LIMIT 1")).rows[0]; assert.ok(source);
  const current = (await admin.query("SELECT base_sha FROM collab.repositories WHERE id=$1", [repository.id])).rows[0].base_sha;
  repository.baseSha = current;
  const input = { promotionId: source.id, baseSha: current, title: "Revert promoted feature", reason: "Revert the feature while retaining subsequent independent changes", idempotencyKey: randomUUID() };
  await assert.rejects(createRevertTask(users[1], input), /forbidden/);
  await assert.rejects(createRevertTask(users[3], input), /mfa_required/);
  await assert.rejects(createRevertTask(users[0], { ...input, baseSha: "e".repeat(40) }), /revert_source_unavailable/);
  const task = await createRevertTask(users[0], input); assert.equal((await createRevertTask(users[0], input)).taskId, task.taskId);
  await assert.rejects(createRevertTask(users[0], { ...input, reason: "Different requested reversal intent" }), /idempotency_conflict/);
  assert.ok((await revertCatalogue(users[1], project)).tasks.some(t => t.task_id === task.taskId));
  const t = (await admin.query("SELECT * FROM collab.tasks WHERE id=$1", [task.taskId])).rows[0];
  await assert.rejects(startRun(users[0], task.taskId, { repositoryId: repository.id, baseSha: "e".repeat(40), prompt: "Inspect managed revert", expectedVersion: t.version, idempotencyKey: randomUUID() }), /revert_source_unavailable|base_mismatch|repository_revision_unavailable/);
  await startRun(users[0], task.taskId, { repositoryId: repository.id, baseSha: current, prompt: "Inspect managed revert", expectedVersion: t.version, idempotencyKey: randomUUID() });
  await assert.rejects(store.pool.query("SELECT collab_worker.claim_resolution_aware($1,'native')", [executor]), /revert_executor_upgrade_required/);
  const c = await store.claim(executor, "native"); assert.ok(c); assert.equal(c.revert?.promotionId, source.id);
  assert.equal(await executeClaim(store, executor, c, { dataRoot: root, backend: new NativeRuntimeBackend(), driver: async agent => {
    await agent.peer.command("bash", { command: "test ! -e feature.txt && test -f code.txt" }); return { kind: "managed-revert", modelInference: false };
  } }), "completed");
  await assert.rejects(readFile(path.join(root, "workspaces", c.workspace.id, "checkout", "feature.txt")), /ENOENT/);
  assert.equal(await git("rev-parse", `refs/heads/${repository.defaultBranch}`), current);
  const run = (await runDetail(users[0], c.run.id)).run;
  const snapshot = await requestSnapshot(users[0], run.id, { expectedRevision: run.revision, idempotencyKey: randomUUID(), note: "Fixed managed revert for independent acceptance" });
  await processSnapshots(store, root); await requestValidation(users[0], snapshot.snapshotId, { profileId, idempotencyKey: randomUUID() });
  const v = await store.claimValidation(executor); assert.ok(v); assert.equal(await executeValidation(store, v, root), "passed");
  await assert.rejects(publishResult(users[0], task.taskId, { validationId: v.id, expectedVersion: (await admin.query("SELECT version FROM collab.tasks WHERE id=$1", [task.taskId])).rows[0].version, idempotencyKey: randomUUID(), note: "No acknowledgement must not publish the inverse" }), /revert_acknowledgement_required/);
  const published = await publishResult(users[0], task.taskId, { validationId: v.id, expectedVersion: (await admin.query("SELECT version FROM collab.tasks WHERE id=$1", [task.taskId])).rows[0].version, idempotencyKey: randomUUID(), acknowledgeResolution: true, note: "Fixed inverse passed required validation" });
  const i = await requestIntegration(users[0], project, { repositoryId: repository.id, targetSha: current, resultIds: [published.resultId], profileId, expectedPolicyId: policyId, idempotencyKey: randomUUID() });
  const ic = await store.claimIntegration(executor); assert.ok(ic); assert.equal(ic.id, i.integrationId); assert.equal(await executeIntegration(store, ic, root), "checked");
  await assert.rejects(requestPromotion(users[0], ic.id, request(await revision(ic.id))), /promotion_not_ready/);
  await review(ic.id); const p = await requestPromotion(users[0], ic.id, request(await revision(ic.id)));
  const staleTask = await createRevertTask(users[0], { ...input, idempotencyKey: randomUUID() });
  await startRun(users[0], staleTask.taskId, { repositoryId: repository.id, baseSha: current, prompt: "Queued revert must expire when the target advances", expectedVersion: 1, idempotencyKey: randomUUID() });
  const pc = await store.claimPromotion(executor); assert.ok(pc); assert.equal(pc.id, p.promotionId); assert.equal(await executePromotion(store, pc, root), "applied");
  assert.equal(await store.claim(executor, "native"), null);
  assert.equal((await admin.query("SELECT status FROM collab.runs WHERE task_id=$1", [staleTask.taskId])).rows[0].status, "cancelled");
  const final = await git("rev-parse", `refs/heads/${repository.defaultBranch}`); assert.notEqual(final, current); assert.notEqual(final, source.input.targetSha);
  repository.baseSha = final;
  await git("merge-base", "--is-ancestor", current, final);
  await assert.rejects(git("cat-file", "-e", `${final}:feature.txt`));
  assert.equal((await revertCatalogue(users[0], project)).tasks.find(t => t.task_id === task.taskId).current, false);
});


test("a divergent target after historical application remains blocked and is never adopted or reset", async () => {
  const c = await promotion(); await prepareLocalPromotion(root, c.input, signal()); assert.equal(await store.admitPromotion(c), true);
  await applyLocalPromotion(root, c.input, signal());
  const divergent = await git("commit-tree", c.input.candidateTree, "-p", c.promotionSha, "-m", "Out of band descendant");
  await git("update-ref", `refs/heads/${c.input.targetBranch}`, divergent, c.promotionSha);
  const observed = await abortLocalPromotion(root, c.input, signal()); assert.equal(observed.decision, "applied");
  assert.equal(await store.finishPromotion(c, observed, null), "blocked");
  assert.equal((await admin.query("SELECT base_sha FROM collab.repositories WHERE id=$1", [repository.id])).rows[0].base_sha, repository.baseSha);
  assert.equal(await git("rev-parse", "HEAD"), divergent);
  const next = await reconcile(c); assert.equal(await executePromotion(store, next, root), "blocked");
  const queued = await requestIntegration(users[1], project, { repositoryId: repository.id, targetSha: repository.baseSha, resultIds: [resultId], profileId, expectedPolicyId: policyId, idempotencyKey: randomUUID() });
  assert.equal(await store.claimIntegration(executor), null);
  await cancelIntegration(users[1], queued.integrationId, { reason: "Do not leave this test preview waiting", idempotencyKey: randomUUID() });
});
