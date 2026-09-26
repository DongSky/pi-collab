import { measureDirectory } from "../../lib/collab/runtime/storage-meter";
import { pullReleaseContext, reviewPullRevision, requestPullRelease } from "../../lib/collab/git/pull-releases";
import { processPullRelease } from "../../lib/collab/git/pull-release-broker";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { createServer, createConnection, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
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
import { processSnapshots, requestSnapshot } from "../../lib/collab/snapshots";
import { registerGitHubInstallation, bindGitHubRepository } from "../../lib/collab/git/github-registration";
import { requestWorkspaceGit } from "../../lib/collab/git/workspace-operations";
import { processWorkspaceGit } from "../../lib/collab/git/workspace-broker";
import { workspaceGitState, workspaceGitPreview } from "../../lib/collab/git/workspace-preview";
import { managedGit } from "../../lib/collab/git/github-pack";
import { requestTaskPushPreview, listTaskPushPreviews, taskPushPreviewDetail, cancelTaskPushPreview } from "../../lib/collab/git/push-previews";
import { processTaskPushPreview } from "../../lib/collab/git/push-preview-broker";
import { verifyTaskPushExport } from "../../lib/collab/git/task-push-export";
import { taskPushRef } from "../../lib/collab/git/task-push-protocol";
import { taskPushHistory, taskPushHistoryDownload } from "../../lib/collab/git/push-preview-history";
import type { TaskPushHistoryReader as HistoryReader } from "../../lib/collab/git/task-push-history";
// Match the CommonJS service graph on Node 22; an ESM import can create a
// second class instance, making race-injection mocks silently miss the read.
const { TaskPushHistoryReader } = createRequire(import.meta.url)("../../lib/collab/git/task-push-history.ts") as { TaskPushHistoryReader: typeof HistoryReader };
import { confirmTaskPush, taskPushConfirmationContext, withdrawTaskPushConfirmation } from "../../lib/collab/git/push-confirmations";
import { githubFixture, config as githubConfig } from "./fixtures/github";
import { githubPushFixture } from "./fixtures/github-push";
import { requestTaskPushDelivery, actOnTaskPushDelivery } from "../../lib/collab/git/push-deliveries";
import { processTaskPushDelivery } from "../../lib/collab/git/push-delivery-broker";
import { prepareExportedTaskPush } from "../../lib/collab/git/task-push-export";
import { PreparedTaskPull } from "../../lib/collab/git/github-task-pull";
import { requestTaskPullProposal, taskPullProposalContext, cancelTaskPullProposal } from "../../lib/collab/git/pull-proposals";
import { processTaskPullProposal } from "../../lib/collab/git/pull-proposal-broker";
import { githubPullFixture } from "./fixtures/github-pull";
import { requestTaskPullDelivery, taskPullDeliveryContext, actOnTaskPullDelivery } from "../../lib/collab/git/pull-deliveries";
import { processTaskPullDelivery } from "../../lib/collab/git/pull-delivery-broker";
import { processPullObservation } from "../../lib/collab/git/pull-observation-broker";
import { pullObservationContext, requestPullObservation, cancelPullObservation } from "../../lib/collab/git/pull-observations";
import { GitHubPullObserver } from "../../lib/collab/git/github-pull-observation";

import { processPullRevision } from "../../lib/collab/git/pull-revision-broker";
import { pullRevisionContext, requestPullRevision, cancelPullRevision, pullRevisionCode, pullRevisionFile } from "../../lib/collab/git/pull-revisions";
import { processPullChecks } from "../../lib/collab/git/pull-checks-broker";
import { pullChecksContext, publishPullChecksPolicy, requestPullChecks, cancelPullChecks } from "../../lib/collab/git/pull-checks";
import { githubWebhookResponse, pullRemoteEvents } from "../../lib/collab/git/github-webhook";
const config = await localConfig(), native = await startNativeDatabase(config), dbName = `pi_collab_test_${randomBytes(6).toString("hex")}`;
Object.assign(process.env, applicationEnvironment(config), { DATABASE_URL: connectionString(config, false, dbName) });
const admin = new Pool({ connectionString: connectionString(config, true, dbName) }), broker = new Pool({ connectionString: gitConnectionString(config, dbName) });
const store = new ExecutionStore(executorConnectionString(config, dbName)), root = await mkdtemp(path.join(tmpdir(), "pi-collab-preview-broker-"));
const executor = randomUUID(), organization = randomUUID(), master = randomBytes(32), users: string[] = [];
let project: string, connectionId: string, remoteId = 7000;
const git = async (directory: string, args: string[]) => (await managedGit(directory, args, AbortSignal.timeout(30000))).bytes.toString().trim();
before(async () => {
  await migrate(config, dbName); const auth = provisioningAuth(admin);
  for (let i = 0; i < 5; i++) users.push((await auth.api.signUpEmail({ body: { name: `Preview member ${i}`, email: `preview${i}@test.invalid`, password: randomBytes(20).toString("hex") } })).user.id);
  await admin.query("INSERT INTO collab.organizations(id,name,created_by) VALUES($1,'Preview team',$2)", [organization, users[0]]);
  for (let i = 0; i < 4; i++) await admin.query("INSERT INTO collab.memberships(organization_id,user_id,role) VALUES($1,$2,$3)", [organization, users[i], i ? "member" : "owner"]);
  await admin.query('UPDATE public."user" SET "twoFactorEnabled"=true WHERE id=ANY($1)', [[users[0], users[2]]]);
  project = (await createProject(users[0], { organizationId: organization, name: "Task push preview acceptance", description: "" })).id;
  for (let i = 1; i < 4; i++) await admin.query("INSERT INTO collab.project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,$4)", [organization, project, users[i], i === 1 ? "developer" : i === 2 ? "maintainer" : "reviewer"]);
  const f = await githubFixture();
  try { connectionId = (await registerGitHubInstallation(admin, master, { ...githubConfig, organizationId: organization, actorId: users[0], reason: "Register generated preview acceptance App", idempotencyKey: randomUUID() }, f.pem, f.transport)).connectionId; }
  finally { await f.close(); }
});
after(async () => {
  master.fill(0); await store.close(); await broker.end(); if (globalThis.__piCollabPool) { await database().end(); globalThis.__piCollabPool = undefined; } await admin.end();
  const cleanup = new Pool({ connectionString: connectionString(config, true, "postgres") }); await cleanup.query(`DROP DATABASE "${dbName}" WITH (FORCE)`); await cleanup.end();
  await native.stop(); await rm(root, { recursive: true, force: true });
});
async function scenario(multiple = false) {
  const directory = path.join(root, randomUUID()), original = path.join(directory, "original"); await mkdir(original, { recursive: true });
  await git(original, ["init", "--template=", "-b", "main"]); await git(original, ["config", "user.name", "Preview fixture"]); await git(original, ["config", "user.email", "preview@test.invalid"]);
  await writeFile(path.join(original, "code.txt"), "base\n"); await git(original, ["add", "."]); await git(original, ["commit", "-m", "Baseline"]);
  await git(directory, ["-c", "protocol.file.allow=always", "clone", "--bare", "--no-local", "--template=", original, "source.git"]);
  const imported = await importLocalRepository(admin, directory, { projectId: project, actorId: users[0], name: "Push preview repository", source: original });
  // Each scenario has its own data root and no artifact sweeper. Record the
  // actual bare repository size instead of retaining a 2 GiB fallback forever.
  await store.recordArtifactUsage("repository", imported.id, await measureDirectory(path.join(directory, "repositories", imported.id)));
  const api = await githubFixture(++remoteId); api.state.sha = imported.baseSha; api.state.branch = "main";
  try { await bindGitHubRepository(admin, master, { repositoryId: imported.id, connectionId, githubRepositoryId: String(remoteId), actorId: users[0], reason: "Bind the exact local baseline for push preview", idempotencyKey: randomUUID() }, api.transport); }
  finally { await api.close(); }
  const task = await createTask(users[1], project, { title: "Preview task history", description: "", acceptance: "" });
  await startRun(users[1], task.id, { repositoryId: imported.id, baseSha: imported.baseSha, prompt: "Commit using native Pi tools", expectedVersion: task.version, idempotencyKey: randomUUID() });
  const claim = await store.claim(executor, "native"); assert.ok(claim); assert.equal(claim.run.task_id, task.id);
  const outcome = await executeClaim(store, executor, claim, { dataRoot: directory, backend: new NativeRuntimeBackend(), driver: async agent => {
    if (multiple) await agent.peer.command("bash", { command: "printf 'intermediate\\n' > temporary.txt; git add temporary.txt; git commit -m 'Intermediate history'; rm temporary.txt; git add temporary.txt" });
    await agent.peer.command("bash", { command: "printf 'task committed\\n' > code.txt; git add code.txt; git commit -m 'Task preview'; printf 'remaining draft\\n' > code.txt" }); return { kind: "local-tool-fixture" };
  } });
  assert.equal(outcome, "completed", JSON.stringify((await runDetail(users[1], claim.run.id)).run.summary));
  const source = { workspaceId: claim.workspace.id, identity: { runId: claim.run.id, executorId: executor, epoch: claim.run.epoch } }, view = (await inspectWorkspaceGit(directory, source)).summary();
  const detail = await runDetail(users[1], claim.run.id), input = { idempotencyKey: randomUUID(), revision: view.revision, head: view.head, expectedRunRevision: detail.run.revision as string };
  const binding = { repositoryId: imported.id, githubRepositoryId: String(remoteId), nodeId: "R_example", ownerId: "789", ownerLogin: "example-org", name: "example-repo",
    defaultBranch: "main", private: true, visibility: "private" as const, integrationBranches: ["main"] };
  const ref = taskPushRef({ taskId: task.id, workspaceId: source.workspaceId }), f = await githubPushFixture(directory, binding, ref, "read");
  const process = (options: NonNullable<Parameters<typeof processTaskPushPreview>[3]> = {}) => processTaskPushPreview(broker, directory, async () => Buffer.from(master), { transport: f.transport, ...options });
  const request = (actor = users[1]) => requestTaskPushPreview(actor, claim.run.id, input);
  const row = async (id: string) => (await admin.query("SELECT * FROM collab_git.push_previews WHERE id=$1", [id])).rows[0];
  const cancel = (id: string, actor = users[1]) => cancelTaskPushPreview(actor, id, { reason: "Cancel the original read-only preview request", idempotencyKey: randomUUID() });
  return { directory, imported, source, input, f, process, request, row, cancel, task, claim, view, ref, binding,
    checkout: path.join(directory, "workspaces", source.workspaceId, "checkout"),
    async disconnect(id: string) { const p = await row(id); await admin.query("SELECT pg_terminate_backend($1)", [p.backend_pid]); await new Promise(resolve => setTimeout(resolve, 30)); } };
}

test("durable concurrent requests produce one authenticated immutable preview with SQL-checked hashes and no receive capability", async () => {
  const s = await scenario();
  try {
    const requests = await Promise.all([s.request(), s.request(), s.request()]), id = requests[0].jobId;
    assert.equal(new Set(requests.map(r => r.jobId)).size, 1); assert.equal(requests.filter(r => !r.replayed).length, 1); assert.equal(s.f.state.issued, 0);
    const result = await s.process(); assert.equal(result.status, "ready"); assert.equal(result.commitCount, 1);
    const stored = await s.row(id), checked = await verifyTaskPushExport(s.directory, id, stored.manifest_hash);
    assert.deepEqual(checked.manifest, stored.manifest); assert.equal(stored.manifest.input.intent.newSha, s.input.head);
    assert.equal(stored.observation_hash, stored.manifest.input.remoteBaseline.observationHash); assert.equal(stored.observation.target.ref, s.ref);
    assert.equal((await taskPushPreviewDetail(users[3], id)).manifestHash, stored.manifest_hash);
    assert.equal((await listTaskPushPreviews(users[3], s.claim.run.id)).previews.length, 1);
    assert.equal(await readFile(path.join(s.checkout, "code.txt"), "utf8"), "remaining draft\n");
    assert.equal(s.f.git.calls.receive, 0); assert.equal(s.f.state.issued, 1); assert.equal(s.f.state.revoked, 1);
    const calls = s.f.calls.length; assert.equal((await s.request()).replayed, true); assert.equal(await s.process(), null); assert.equal(s.f.calls.length, calls);
    assert.equal((await admin.query("SELECT 1 FROM collab.audit_events WHERE resource_id=$1 AND action='task_push_preview.ready'", [id])).rowCount, 1);
  } finally { await s.f.close(); }
});

async function confirmationScenario() {
  const s = await scenario(true), previous = process.env.PI_COLLAB_DATA_DIR; process.env.PI_COLLAB_DATA_DIR = s.directory;
  const job = await s.request(); await s.process();
  const scope = (await taskPushConfirmationContext(users[1], job.jobId)).scope; assert.ok(scope);
  const input = { ...scope, acknowledgeHistory: true as const, acknowledgeDestination: true as const, acknowledgeDisclosure: true as const, idempotencyKey: randomUUID() };
  return { ...s, job, confirmationInput: input,
    confirm: (actor = users[1], value = input) => confirmTaskPush(actor, job.jobId, value),
    context: (actor = users[1]) => taskPushConfirmationContext(actor, job.jobId),
    withdraw: (id: string, actor = users[1], idempotencyKey = randomUUID()) => withdrawTaskPushConfirmation(actor, id, { idempotencyKey, reason: "Withdraw explicit unsent destination reservation" }),
    async close() { if (previous === undefined) delete process.env.PI_COLLAB_DATA_DIR; else process.env.PI_COLLAB_DATA_DIR = previous; await s.f.close(); } };
}

async function deliveryScenario(dispatcher = 1, confirmer = 1, competingPreview = false) {
  const s = await confirmationScenario();
  let competitor: { jobId: string; input: typeof s.confirmationInput } | undefined;
  if (competingPreview) {
    const job = await requestTaskPushPreview(users[2], s.claim.run.id, { ...s.input, idempotencyKey: randomUUID() });
    const reader = await githubPushFixture(s.directory, s.binding, s.ref, "read");
    try { assert.equal((await processTaskPushPreview(broker, s.directory, async () => Buffer.from(master), { transport: reader.transport })).status, "ready"); }
    finally { await reader.close(); }
    const scope = (await taskPushConfirmationContext(users[2], job.jobId)).scope; assert.ok(scope);
    competitor = { jobId: job.jobId, input: { ...scope, acknowledgeHistory: true, acknowledgeDestination: true, acknowledgeDisclosure: true, idempotencyKey: randomUUID() } };
  }
  const confirmation = await s.confirm(users[confirmer]);
  const writer = await githubPushFixture(s.directory, s.binding, s.ref);
  const input = { idempotencyKey: randomUUID(), manifestHash: s.confirmationInput.manifestHash, acknowledgePush: true as const };
  const request = (actor = users[dispatcher], value = input) => requestTaskPushDelivery(actor, confirmation.id, value);
  const process = (options: NonNullable<Parameters<typeof processTaskPushDelivery>[3]> = {}, pool = broker) => processTaskPushDelivery(pool, s.directory, async () => Buffer.from(master), { transport: writer.transport, ...options });
  const row = async (id: string) => (await admin.query("SELECT * FROM collab_git.push_deliveries WHERE id=$1", [id])).rows[0];
  const action = (id: string, kind: "cancel" | "retire" = "cancel", actor = users[dispatcher], key = randomUUID()) => actOnTaskPushDelivery(actor, id, kind === "cancel"
    ? { idempotencyKey: key, action: "cancel", reason: "Stop this original exact delivery attempt", acknowledgeUnknown: false }
    : { idempotencyKey: key, action: "retire", reason: "Permanently fence this destination because its remote effect is still unknown", acknowledgeUnknown: true });
  return { ...s, competitor, confirmation, writer, sendInput: input, send: request, deliver: process, deliveryRow: row, action,
    async disconnectDelivery(id: string) { await admin.query("SELECT pg_terminate_backend($1)", [(await row(id)).backend_pid]); await new Promise(resolve => setTimeout(resolve, 30)); },
    async close() { await writer.close(); await s.close(); } };
}

async function pullProposalScenario(competingPreview = false) {
  const s = await deliveryScenario(1, 1, competingPreview), delivery = await s.send();
  assert.equal((await s.deliver()).status, "acknowledged");
  const context = await taskPullProposalContext(users[1], delivery.jobId);
  const input = { idempotencyKey: randomUUID(), expectedTaskVersion: context.taskVersion, title: "Reviewed task proposal", body: "Goal: expose the fixed delivered code.\nTests: no CI attestation.\nRisks: review pending." };
  const expected = PreparedTaskPull.prepare(s.binding, { operationId: randomUUID(), deliveryId: delivery.jobId, repositoryId: s.imported.id,
    taskId: s.task.id, workspaceId: s.source.workspaceId, headSha: s.input.head, baseSha: s.imported.baseSha,
    manifestHash: s.confirmationInput.manifestHash, title: input.title, body: input.body });
  const api = await githubPullFixture(s.directory, expected.attempt, "preview");
  const process = (options: NonNullable<Parameters<typeof processTaskPullProposal>[2]> = {}, pool = broker) => processTaskPullProposal(pool, async () => Buffer.from(master), { transport: api.transport, ...options });
  const row = async (id: string) => (await admin.query("SELECT * FROM collab_git.pull_proposals WHERE id=$1", [id])).rows[0];
  return { ...s, delivery, proposalInput: input, api, propose: (actor = users[1], value = input) => requestTaskPullProposal(actor, delivery.jobId, value),
    proposalContext: (actor = users[1]) => taskPullProposalContext(actor, delivery.jobId), processProposal: process, proposalRow: row,
    cancelProposal: (id: string, actor = users[1]) => cancelTaskPullProposal(actor, id, { idempotencyKey: randomUUID(), reason: "Cancel this read-only proposal observation" }),
    async close() { await api.close(); await s.close(); } };
}

async function pullCreationScenario(dispatcher = 1, competingPreview = false) {
  const s = await pullProposalScenario(competingPreview), proposal = await s.propose(), fixed = await s.processProposal();
  assert.equal(fixed.status, "ready");
  const creator = await githubPullFixture(s.directory, fixed.attempt, "create");
  const input = { idempotencyKey: randomUUID(), requestHash: fixed.attempt.requestHash, observationHash: fixed.observationHash,
    acknowledgeContent: true as const, acknowledgeNotification: true as const, acknowledgeVersions: true as const };
  return { ...s, proposal, fixed, creator, creationInput: input,
    requestPull: (actor = users[dispatcher], value = input) => requestTaskPullDelivery(actor, proposal.jobId, value),
    deliverPull: (options: NonNullable<Parameters<typeof processTaskPullDelivery>[2]> = {}, pool = broker) =>
      processTaskPullDelivery(pool, async () => Buffer.from(master), { transport: creator.transport, ...options }),
    pullContext: (actor = users[1]) => taskPullDeliveryContext(actor, proposal.jobId),
    pullAction: (action: "cancel" | "retire" = "cancel", actor = users[dispatcher], idempotencyKey = randomUUID()) =>
      actOnTaskPullDelivery(actor, proposal.jobId, action === "cancel"
        ? { idempotencyKey, action, reason: "Stop this exact draft creation request", acknowledgeUnknown: false }
        : { idempotencyKey, action, reason: "Permanently quarantine this branch because creation remains unknown", acknowledgeUnknown: true }),
    async anotherProposal() {
      const next = await s.propose(users[1], { ...s.proposalInput, idempotencyKey: randomUUID() });
      const reader = await githubPullFixture(s.directory, fixed.attempt, "preview");
      let observed: Awaited<ReturnType<typeof processTaskPullProposal>>;
      try { observed = await processTaskPullProposal(broker, async () => Buffer.from(master), { transport: reader.transport }); assert.equal(observed.status, "ready"); }
      finally { await reader.close(); }
      return { id: next.jobId, request: (actor = users[1]) => requestTaskPullDelivery(actor, next.jobId, { ...input, requestHash: observed.attempt.requestHash,
        observationHash: observed.observationHash, idempotencyKey: randomUUID() }) };
    },
    async close() { await creator.close(); await s.close(); } };
}

async function pullObservationScenario() {
  const s = await pullCreationScenario(); await s.requestPull(); assert.equal((await s.deliverPull()).status, "created");
  const readers: Awaited<ReturnType<typeof githubPullFixture>>[] = [];
  const context = (actor = users[1]) => pullObservationContext(actor, s.proposal.jobId);
  const input = { idempotencyKey: randomUUID(), expectedTaskVersion: (await context()).taskVersion, expectedObservationVersion: "0" };
  return { ...s, observationInput: input, observationContext: context,
    requestObservation: (actor = users[1], value = input) => requestPullObservation(actor, s.proposal.jobId, value),
    cancelObservation: (job: string, actor = users[1], key = randomUUID()) => cancelPullObservation(actor, job, { idempotencyKey: key, reason: "Cancel this exact read-only observation" }),
    async observer() {
      const api = await githubPullFixture(s.directory, s.fixed.attempt, "observe"); readers.push(api); api.created.push(structuredClone(s.creator.created[0]));
      return { api, process: (options: NonNullable<Parameters<typeof processPullObservation>[2]> = {}, pool = broker) =>
        processPullObservation(pool, async () => Buffer.from(master), { transport: api.transport, ...options }) };
    },
    async close() { for (const reader of readers) await reader.close(); await s.close(); } };
}

async function revisionScenario(webhook = false) {
  const s = await pullObservationScenario(); if (webhook) await configureWebhook(); await s.requestObservation(); const observer = await s.observer();
  assert.equal((await observer.process()).status, "observed");
  const codeReader = await githubPushFixture(s.directory, s.binding, s.ref, "read");
  const context = () => pullRevisionContext(users[1], s.proposal.jobId);
  const input = { idempotencyKey: randomUUID(), expectedTaskVersion: (await context()).taskVersion, expectedObservationVersion: "1" };
  return { ...s, codeReader, revisionInput: input, revisionContext: context,
    requestRevision: (actor = users[1], value = input) => requestPullRevision(actor, s.proposal.jobId, value),
    processRevision: (options: NonNullable<Parameters<typeof processPullRevision>[3]> = {}, pool = broker) =>
      processPullRevision(pool, s.directory, async () => Buffer.from(master), { transport: codeReader.transport, ...options }),
    async close() { await codeReader.close(); await s.close(); },
    revisionRow: async (id: string) => (await admin.query("SELECT * FROM collab_git.pull_revision_jobs WHERE id=$1", [id])).rows[0],
  };
}

async function checksScenario(webhook = false) {
  const s = await revisionScenario(webhook), revision = await s.requestRevision(); assert.equal((await s.processRevision()).status, "ready");
  const config = { version: 1 as const, required: [{ name: "build", appId: "41234" }], maxAgeSeconds: 600 };
  const policyInput = { idempotencyKey: randomUUID(), expectedVersion: 0, reason: "Trust the dedicated build App for this target branch", config };
  const policy = await publishPullChecksPolicy(users[2], revision.jobId, policyInput);
  const context = (actor = users[1]) => pullChecksContext(actor, revision.jobId);
  const input = { idempotencyKey: randomUUID(), expectedTaskVersion: (await context()).taskVersion, expectedPolicyId: policy.policyId };
  const readers: Awaited<ReturnType<typeof githubPullFixture>>[] = [];
  return { ...s, revision, policy, policyInput, checksInput: input, checksContext: context,
    requestChecks: (actor = users[1], value = input) => requestPullChecks(actor, revision.jobId, value),
    async checksReader() {
      const fixture = await githubPullFixture(s.directory, s.fixed.attempt, "checks"); await fixture.seedObservation(); readers.push(fixture);
      return { fixture, process: (options: NonNullable<Parameters<typeof processPullChecks>[2]> = {}, pool = broker) => processPullChecks(pool, async () => Buffer.from(master), { transport: fixture.transport, ...options }) };
    },
    async close() { for (const fixture of readers) await fixture.close(); await s.close(); },
  };
}

const webhookSecret = Buffer.from(randomBytes(32).toString("hex"));
async function configureWebhook(actor = users[0], secret = webhookSecret, enabled = true) {
  const db = await admin.connect();
  try {
    await db.query("BEGIN"); await db.query("SELECT set_config('collab.user_id',$1,true)", [actor]);
    const version = (await db.query("SELECT version FROM collab_git.webhook_keys WHERE connection_id=$1", [connectionId])).rows[0]?.version ?? "0";
    const result = (await db.query("SELECT collab_git.configure_webhook($1,$2,$3,$4,$5) AS result", [connectionId, version, randomUUID(), { enabled, reason: "Configure generated signature verification fixture" }, secret])).rows[0].result;
    await db.query("COMMIT"); return result;
  } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
}
function webhookBody(s: Awaited<ReturnType<typeof checksScenario>>, event = "check_run") {
  const scope = { installation: { id: Number(githubConfig.installationId) }, repository: { id: Number(s.binding.githubRepositoryId), owner: { id: Number(githubConfig.accountId) } } };
  if (event === "push") return { ...scope, ref: "refs/heads/"+s.fixed.attempt.request.head, before: s.imported.baseSha, after: s.input.head };
  if (event === "pull_request") return { ...scope, action: "synchronize", pull_request: { id: Number(s.creator.created[0].id), head: { sha: s.input.head }, base: { repo: { id: Number(s.binding.githubRepositoryId) } } } };
  return { ...scope, action: "completed", [event]: { id: 8191, head_sha: s.input.head } };
}
function webhookRequest(body: unknown, event = "check_run", delivery = randomUUID(), overrides: Record<string,string> = {}, secret = webhookSecret) {
  const bytes = Buffer.from(JSON.stringify(body));
  return new Request("http://127.0.0.1:30142/api/collab/github-webhooks/"+githubConfig.appId, { method: "POST", headers: { "content-type": "application/json", "x-github-event": event, "x-github-delivery": delivery,
    "x-hub-signature-256": "sha256="+createHmac("sha256",secret).update(bytes).digest("hex"), ...overrides }, body: bytes });
}

test("webhook signatures invalidate exact-head CI, deduplicate delivery and payload bytes, and preserve code history", async () => {
  const s = await checksScenario(true);
  try {
    await s.requestChecks(); const reader = await s.checksReader(); assert.equal((await reader.process()).eligible, true);
    const body = webhookBody(s), delivery = randomUUID();
    const receive = () => githubWebhookResponse(webhookRequest(body,"check_run",delivery),githubConfig.appId);
    const responses = await Promise.all([receive(),receive(),receive()]); assert.deepEqual(responses.map(r=>r.status),[202,202,202]);
    assert.equal((await s.checksContext()).jobs[0].eligible,false);
    const before = await pullRemoteEvents(users[3],s.proposal.jobId); assert.equal(before.events.length,1); assert.equal(before.needsRefresh,false);
    assert.equal((await githubWebhookResponse(webhookRequest(body),githubConfig.appId)).status,202);
    const after = await pullRemoteEvents(users[3],s.proposal.jobId); assert.equal(after.checksVersion,before.checksVersion); assert.equal(after.events.length,1);
    const code = await pullRevisionCode(users[3],s.revision.jobId,{}); assert.equal(code.record.current,true);
    await s.requestChecks(users[1],{...s.checksInput,idempotencyKey:randomUUID()}); const next = await s.checksReader(); assert.equal((await next.process()).eligible,true);
    assert.equal((await receive()).status,202); assert.equal((await s.checksContext()).jobs[0].eligible,true);
    const moved = {...body, action:"rerequested"}; assert.equal((await githubWebhookResponse(webhookRequest(moved,"check_run",delivery),githubConfig.appId)).status,409);
    await assert.rejects(pullRemoteEvents(users[4],s.proposal.jobId),/not_found/);
  } finally { await s.close(); }
});

test("webhook rejects browser credentials, wrong signatures, wrong installation or repository scope without invalidating evidence", async () => {
  const s = await checksScenario(true);
  try {
    const body = webhookBody(s), before = await pullRemoteEvents(users[1],s.proposal.jobId);
    for (const [headers,status] of [[{cookie:"session=ignored"},403],[{origin:"http://127.0.0.1:30142"},403],[{authorization:"Bearer ignored"},403],[{"x-hub-signature-256":"sha256="+"0".repeat(64)},401],[{"x-github-event":"pull_request"},400]] as const) {
      assert.equal((await githubWebhookResponse(webhookRequest(body,"check_run",randomUUID(),headers),githubConfig.appId)).status,status);
    }
    assert.equal((await githubWebhookResponse(webhookRequest({...body,installation:{id:9999}}),githubConfig.appId)).status,401);
    assert.equal((await githubWebhookResponse(webhookRequest({...body,repository:{id:Number(s.binding.githubRepositoryId),owner:{id:9999}}}),githubConfig.appId)).status,400);
    assert.equal((await githubWebhookResponse(webhookRequest(body),"9999")).status,401);
    assert.deepEqual(await pullRemoteEvents(users[1],s.proposal.jobId),before);
    await assert.rejects(asUser(users[0], db=>db.query("SELECT secret FROM collab_git.webhook_keys")),/permission/);
    await assert.rejects(broker.query("SELECT secret FROM collab_git.webhook_keys"),/permission/);
    await assert.rejects(configureWebhook(users[1]),/forbidden/);
  } finally { await s.close(); }
});

test("webhook code events invalidate old revisions and in-flight readers; fresh explicit observation restores only current evidence", async () => {
  const s = await checksScenario(true);
  try {
    await s.requestChecks(); const reader = await s.checksReader();
    assert.equal((await reader.process({beforeFinish:async()=>{ assert.equal((await githubWebhookResponse(webhookRequest(webhookBody(s,"pull_request"),"pull_request"),githubConfig.appId)).status,202); }})).status,"failed");
    assert.equal((await pullRemoteEvents(users[1],s.proposal.jobId)).needsRefresh,true);
    assert.equal((await pullRevisionCode(users[3],s.revision.jobId,{})).record.current,false);
    await assert.rejects(s.requestChecks(users[1],{...s.checksInput,idempotencyKey:randomUUID()}),/source_unavailable/);
    const ctx = await s.observationContext(); await s.requestObservation(users[1],{...s.observationInput,idempotencyKey:randomUUID(),expectedObservationVersion:ctx.observationVersion});
    const observer = await s.observer(); assert.equal((await observer.process()).status,"observed");
    assert.equal((await pullRemoteEvents(users[1],s.proposal.jobId)).needsRefresh,false);
    assert.equal((await pullRevisionCode(users[3],s.revision.jobId,{})).record.current,false);
    await s.requestObservation(users[1],{...s.observationInput,idempotencyKey:randomUUID(),expectedObservationVersion:(await s.observationContext()).observationVersion});
    const another = await s.observer(); assert.equal((await another.process({beforeFinish:async()=>{ assert.equal((await githubWebhookResponse(webhookRequest(webhookBody(s,"push"),"push"),githubConfig.appId)).status,202); }})).status,"failed");
  } finally { await s.close(); }
});

test("webhook configuration rotations revoke old signatures, ping verifies bytes, and old-SHA checks never change current CI", async () => {
  const s = await checksScenario(true);
  try {
    const body = webhookBody(s), old = {...body,check_run:{id:8191,head_sha:"0".repeat(40)}};
    const before = await pullRemoteEvents(users[1],s.proposal.jobId);
    assert.equal((await githubWebhookResponse(webhookRequest(old),githubConfig.appId)).status,202);
    assert.deepEqual(await pullRemoteEvents(users[1],s.proposal.jobId),before);
    assert.equal((await githubWebhookResponse(webhookRequest({zen:"fixture",hook_id:123},"ping"),githubConfig.appId)).status,202);
    await git(path.join(s.directory,"source.git"),["update-ref",s.ref,s.imported.baseSha,s.input.head]);
    const pushed = {...webhookBody(s,"push"),before:s.input.head,after:s.imported.baseSha};
    assert.equal((await githubWebhookResponse(webhookRequest(pushed,"push"),githubConfig.appId)).status,202);
    await s.requestObservation(users[1],{...s.observationInput,idempotencyKey:randomUUID(),expectedObservationVersion:(await s.observationContext()).observationVersion});
    const observer = await s.observer(); assert.equal((await observer.process()).status,"observed");
    const changed = await pullRemoteEvents(users[1],s.proposal.jobId);
    // A real older ready revision still has this head; it must not invalidate the new head.
    assert.equal((await githubWebhookResponse(webhookRequest(body),githubConfig.appId)).status,202);
    assert.deepEqual(await pullRemoteEvents(users[1],s.proposal.jobId),changed);
    const next = Buffer.from(randomBytes(32).toString("hex")); await configureWebhook(users[0],next);
    assert.equal((await githubWebhookResponse(webhookRequest(body),githubConfig.appId)).status,401);
    assert.equal((await githubWebhookResponse(webhookRequest(body,"check_run",randomUUID(),{},next),githubConfig.appId)).status,202);
    await configureWebhook(users[0],next,false);
    assert.equal((await githubWebhookResponse(webhookRequest(body,"check_run",randomUUID(),{},next),githubConfig.appId)).status,401);
  } finally { await s.close(); }
});

test("webhook byte validation, unrelated branches and storage-bounded replay do not create false notifications", async () => {
  const s = await checksScenario(true);
  try {
    const body = webhookBody(s), signed = webhookRequest(body), bytes = JSON.stringify(body);
    assert.equal((await githubWebhookResponse(new Request(signed.url,{method:"POST",headers:signed.headers,body:bytes+" "}),githubConfig.appId)).status,401);
    assert.equal((await githubWebhookResponse(new Request(signed.url,{method:"POST",headers:signed.headers,body:"x".repeat(2097153)}),githubConfig.appId)).status,413);
    const before = await pullRemoteEvents(users[1],s.proposal.jobId);
    for (const ref of ["refs/heads/unrelated","refs/tags/v1"]) assert.equal((await githubWebhookResponse(webhookRequest({...webhookBody(s,"push"),ref},"push"),githubConfig.appId)).status,202);
    assert.deepEqual(await pullRemoteEvents(users[1],s.proposal.jobId),before);
    assert.equal((await githubWebhookResponse(webhookRequest(body),githubConfig.appId)).status,202);
    const n = (await admin.query("SELECT count(*)::integer AS count FROM collab_git.webhook_deliveries")).rows[0].count;
    for(let i=0;i<10;i++) assert.equal((await githubWebhookResponse(webhookRequest(body),githubConfig.appId)).status,202);
    assert.equal((await admin.query("SELECT count(*)::integer AS count FROM collab_git.webhook_deliveries")).rows[0].count,n);
    const context = await asUser(users[0], db=>db.query("SELECT collab.github_webhook_state($1) AS result",[connectionId]));
    assert.equal(context.rows[0].result.enabled,true); assert.ok(context.rows[0].result.lastReceivedAt);
    assert.equal((await asUser(users[1], db=>db.query("SELECT collab.github_webhook_state($1) AS result",[connectionId]))).rows[0].result,null);
  } finally { await s.close(); }
});

test("webhook real database response loss replays one committed receipt and invalidation", async () => {
  const s = await checksScenario(true), sockets = new Set<Socket>(); let dropped = false;
  const proxy = createServer(client => {
    const upstream = createConnection({host:"127.0.0.1",port:config.databasePort}); sockets.add(client); sockets.add(upstream); let observing = false;
    client.on("data",chunk=>{ if(Buffer.from(chunk).includes(Buffer.from("receive_github_webhook"))) observing=true; upstream.write(chunk); });
    upstream.on("data",chunk=>{ if(observing && Buffer.from(chunk).includes(Buffer.from("SELECT 1"))) { dropped=true; client.destroy(); upstream.destroy(); return; } client.write(chunk); });
    for(const socket of [client,upstream]) { socket.on("error",()=>{}); socket.on("close",()=>{sockets.delete(socket);client.destroy();upstream.destroy();}); }
  });
  await new Promise<void>(resolve=>proxy.listen(0,"127.0.0.1",resolve));
  const url = new URL(connectionString(config,false,dbName)); url.port=String((proxy.address() as {port:number}).port);
  const through = new Pool({connectionString:url.toString(),query_timeout:5000}), original = database();
  try {
    const body = webhookBody(s), id=randomUUID(); globalThis.__piCollabPool=through;
    assert.equal((await githubWebhookResponse(webhookRequest(body,"check_run",id),githubConfig.appId)).status,503);
    globalThis.__piCollabPool=original; assert.equal(dropped,true);
    const before = await pullRemoteEvents(users[1],s.proposal.jobId); assert.equal(before.events.length,1);
    assert.equal((await githubWebhookResponse(webhookRequest(body,"check_run",id),githubConfig.appId)).status,202);
    assert.deepEqual(await pullRemoteEvents(users[1],s.proposal.jobId),before);
  } finally {globalThis.__piCollabPool=original; await through.end(); for(const socket of sockets) socket.destroy(); await new Promise<void>(resolve=>proxy.close(()=>resolve())); await s.close();}
});

test("webhook serialized after the CI publication transaction invalidates that just-committed result", async () => {
  const s = await checksScenario(true); let incoming: Promise<Response> | undefined, finished = false;
  try {
    await s.requestChecks(); const reader=await s.checksReader();
    const result = await reader.process({ beforeCommit:async()=>{
      incoming = githubWebhookResponse(webhookRequest(webhookBody(s)),githubConfig.appId).then(value=>{finished=true;return value;});
      await new Promise(resolve=>setTimeout(resolve,120)); assert.equal(finished,false);
    }});
    assert.equal(result.eligible,true); assert.equal((await incoming)!.status,202);
    assert.equal((await s.checksContext()).jobs[0].eligible,false);
  } finally { await incoming; await s.close(); }
});

test("pull checks bind trusted producer and exact revision, expose SQL-derived verdict and reuse one durable request", async () => {
  const s = await checksScenario();
  try {
    const jobs = await Promise.all([s.requestChecks(), s.requestChecks(), s.requestChecks()]); assert.equal(new Set(jobs.map(j=>j.jobId)).size, 1);
    const reader = await s.checksReader(); const result = await reader.process();
    assert.equal(result.status, "observed", JSON.stringify(result)); assert.equal(result.satisfied, true); assert.equal(result.eligible, true);
    assert.deepEqual(result.rules, [{ name: "build", appId: "41234", checkId: "71001", state: "passed" }]);
    assert.equal(reader.fixture.state.checkReads, 2); assert.equal(reader.fixture.state.revoked, 1); assert.equal(reader.fixture.state.creates, 0);
    assert.equal(reader.fixture.containsCredential(result), false);
    assert.equal((await s.requestChecks()).replayed, true); assert.equal(await reader.process(), null);
    assert.equal((await s.checksContext(users[3])).jobs[0].eligible, true); await assert.rejects(s.checksContext(users[4]), /not_found/);
    const job = await s.requestChecks(users[1], { ...s.checksInput, idempotencyKey: randomUUID() });
    assert.equal((await s.checksContext()).jobs.find(j=>j.jobId===jobs[0].jobId)?.eligible, false);
    await cancelPullChecks(users[1], job.jobId, { idempotencyKey: randomUUID(), reason: "Cancel replacement observation; old success must stay invalid" });
    const cancelled = await s.checksReader(); assert.equal((await cancelled.process()).status, "cancelled"); assert.equal(cancelled.fixture.state.issued, 0);
  } finally { await s.close(); }
});

test("pull checks never approve missing, foreign-producer, pending, failed, skipped or ambiguous checks", async () => {
  const s = await checksScenario();
  try {
    for (const mode of ["missing", "foreign", "pending", "failed", "skipped", "ambiguous"]) {
      await s.requestChecks(users[1], { ...s.checksInput, idempotencyKey: randomUUID() }); const reader = await s.checksReader();
      const checks = reader.fixture.state.checks;
      if (mode === "missing") checks.length = 0;
      if (mode === "foreign") checks[0].app = { id: 99999 };
      if (mode === "pending") Object.assign(checks[0], { status: "in_progress", conclusion: null, completed_at: null });
      if (mode === "failed" || mode === "skipped") checks[0].conclusion = mode === "failed" ? "failure" : "skipped";
      if (mode === "ambiguous") checks.push({ ...checks[0], id: 71002 });
      const result = await reader.process(); assert.equal(result.status, "observed", JSON.stringify(result));
      const count=(await admin.query("SELECT count(*)::int AS n FROM collab.inbox WHERE recipient_id=$1 AND kind='ci.failed' AND event_key LIKE $2",[users[1],`ci:${s.revision.jobId}:%`])).rows[0].n;
      assert.equal(count,["failed","skipped","ambiguous"].includes(mode)?1:0,`CI notification ${mode}; reread same check is deduplicated`);
      assert.equal(result.satisfied, false, mode); assert.equal(result.eligible, false, mode);
    }
  } finally { await s.close(); }
});

test("pull checks reject wrong SHA, unstable pages, missing permissions, broad tokens and failed cleanup", async () => {
  const s = await checksScenario();
  try {
    for (const mode of ["sha", "moving", "duplicate", "head", "permission", "token", "cleanup"]) {
      await s.requestChecks(users[1], { ...s.checksInput, idempotencyKey: randomUUID() }); const reader = await s.checksReader();
      const f = reader.fixture;
      if (mode === "sha") f.state.checks[0].head_sha = "0".repeat(40);
      if (mode === "moving") f.state.beforeChecks = async () => { if (f.state.checkReads === 2) f.state.checks[0].conclusion = "failure"; };
      if (mode === "duplicate") f.state.checks.push({ ...f.state.checks[0] });
      if (mode === "head") f.state.mutateRead = { head: { ref: "moved", sha: "0".repeat(40), repo: { id: Number(s.binding.githubRepositoryId), node_id: s.binding.nodeId, owner: { id: Number(s.binding.ownerId), login: s.binding.ownerLogin }, name: s.binding.name, private: true, visibility: "private", default_branch: "main", archived: false, disabled: false } } };
      if (mode === "permission") f.state.installChecks = "none";
      if (mode === "token") f.state.permissions.checks = "write";
      if (mode === "cleanup") f.state.fail = "revoke";
      const result = await reader.process(); assert.equal(result.status, "failed", mode + JSON.stringify(result)); assert.equal(result.eligible, false);
    }
  } finally { await s.close(); }
});

test("pull checks policies require maintainer MFA and exact versions; changes and expiry invalidate evidence", async () => {
  const s = await checksScenario();
  try {
    await assert.rejects(publishPullChecksPolicy(users[1], s.revision.jobId, { ...s.policyInput, idempotencyKey: randomUUID() }), /forbidden/);
    await assert.rejects(s.requestChecks(users[3]), /forbidden/);
    assert.equal((await publishPullChecksPolicy(users[2], s.revision.jobId, s.policyInput)).replayed, true);
    await assert.rejects(publishPullChecksPolicy(users[2], s.revision.jobId, { ...s.policyInput, idempotencyKey: randomUUID() }), /stale_revision/);
    const job = await s.requestChecks(); const reader = await s.checksReader(); assert.equal((await reader.process()).eligible, true);
    await admin.query("UPDATE collab_git.pull_checks_jobs SET finished_at=now()-interval '601 seconds' WHERE id=$1", [job.jobId]);
    assert.equal((await s.checksContext()).jobs[0].eligible, false);
    await admin.query("UPDATE collab_git.pull_checks_jobs SET finished_at=now() WHERE id=$1", [job.jobId]);
    assert.equal((await s.checksContext()).jobs[0].eligible, true);
    await publishPullChecksPolicy(users[2], s.revision.jobId, { ...s.policyInput, idempotencyKey: randomUUID(), expectedVersion: 1, reason: "Require the same producer under a new policy version" });
    assert.equal((await s.checksContext()).jobs[0].eligible, false);
    await assert.rejects(s.requestChecks(users[1], { ...s.checksInput, idempotencyKey: randomUUID() }), /stale_revision/);
  } finally { await s.close(); }
});

test("pull checks SQL independently rejects forged evidence, timestamps, types, scope and wrong ownership", async () => {
  const s = await checksScenario(), db = await broker.connect();
  try {
    const job = await s.requestChecks();
    await assert.rejects(broker.query("SELECT * FROM collab_git.pull_checks_jobs"), /permission/);
    await assert.rejects(asUser(users[1], c => c.query("SELECT collab_git.claim_pull_checks()")), /permission/);
    const claim = (await db.query("SELECT collab_git.claim_pull_checks() AS result")).rows[0].result;
    await assert.rejects(broker.query("SELECT collab_git.begin_pull_checks($1,$2)", [job.jobId, claim.claimId]), /claim_lost/);
    await db.query("SELECT collab_git.begin_pull_checks($1,$2)", [job.jobId, claim.claimId]);
    const reader = await s.checksReader(), { pair } = await import("./fixtures/github");
    const { GitHubPullChecksReader } = await import("../../lib/collab/git/github-pull-checks");
    const value = await new GitHubPullChecksReader(githubConfig, pair.privateKey, reader.fixture.transport).observe(s.binding, claim.admission.identity, claim.admission.input);
    const c = value.checks[0];
    for (const patch of [{ satisfied: true }, { snapshot: { ...value.snapshot, identity: { ...value.identity, id: "1" } } }, { snapshot: { ...value.snapshot, observedAt: new Date(0).toISOString() } }, { tokenExpiresAt: null }, { tokenExpiresAt: new Date(0).toISOString() }, { tokenRevoked: false },
      { completedAt: new Date(0).toISOString() }, { input: { ...value.input, headSha: "0".repeat(40) } },
      { installation: { ...value.installation, permissions: { checks: "read" } } },
      ...[{ id: 71001 }, { appId: "9999999999999999" }, { suiteId: null }, { startedAt: 1 }, { completedAt: "2099-01-01T00:00:00.000Z" },
        { startedAt: "2099-01-01T00:00:00.000Z" }, { conclusion: true }, { forged: true }].map(change => ({ checks: [{ ...c, ...change }] })),
      { checks: [c, c] }]) {
      await assert.rejects(db.query("SELECT collab_git.finish_pull_checks($1,$2,$3)", [job.jobId, claim.claimId, JSON.stringify({ ...value, ...patch })]), /invalid_pull_checks_evidence/);
    }
    assert.equal((await db.query("SELECT collab_git.finish_pull_checks($1,$2,$3) AS result", [job.jobId, claim.claimId, JSON.stringify(value)])).rows[0].result.eligible, true);
  } finally { db.release(true); await s.close(); }
});

test("pull checks complete paginated reads and fence cancellation or policy changes during reading", async () => {
  const s = await checksScenario();
  try {
    await s.requestChecks(); const reader = await s.checksReader(), check = reader.fixture.state.checks[0];
    for (let i = 1; i <= 100; i++) reader.fixture.state.checks.push({ ...check, id: 71001+i, name: "unrelated-"+i });
    assert.equal((await reader.process()).eligible, true); assert.equal(reader.fixture.state.checkReads, 4);
    for (const mode of ["cancel", "policy"]) {
      const job = await s.requestChecks(users[1], { ...s.checksInput, idempotencyKey: randomUUID() }), next = await s.checksReader();
      next.fixture.state.beforeChecks = async () => {
        if (next.fixture.state.checkReads !== 1) return;
        if (mode === "cancel") await cancelPullChecks(users[1], job.jobId, { idempotencyKey: randomUUID(), reason: "Cancel while provider read is already in flight" });
        else await publishPullChecksPolicy(users[2], s.revision.jobId, { ...s.policyInput, idempotencyKey: randomUUID(), expectedVersion: 1 });
      };
      const result = await next.process(); assert.equal(result.status, mode === "cancel" ? "cancelled" : "failed"); assert.equal(result.eligible, false);
      assert.equal(next.fixture.state.revoked, 1);
    }
  } finally { await s.close(); }
});

test("pull checks actual SQL owner loss before and after reading cannot replay or publish stale callbacks", async () => {
  for (const phase of ["afterBegin", "beforeFinish"] as const) {
    const s = await checksScenario();
    try {
      const job = await s.requestChecks(), reader = await s.checksReader(); let nonce = "";
      await assert.rejects(reader.process({ [phase]: async () => {
        const row = (await admin.query("SELECT backend_pid,claim_id FROM collab_git.pull_checks_jobs WHERE id=$1", [job.jobId])).rows[0]; nonce = row.claim_id;
        await admin.query("SELECT pg_terminate_backend($1)", [row.backend_pid]); await new Promise(resolve => setTimeout(resolve, 30));
      } }), /outcome_unknown/);
      assert.equal((await reader.process()).status, "failed"); assert.equal(reader.fixture.state.issued, phase === "beforeFinish" ? 1 : 0);
      assert.equal(reader.fixture.state.checkReads, phase === "beforeFinish" ? 2 : 0); assert.equal(await reader.process(), null);
      await assert.rejects(broker.query("SELECT collab_git.fail_pull_checks($1,$2,'late_callback')", [job.jobId, nonce]), /claim_lost/);
      assert.equal((await s.checksContext()).jobs[0].eligible, false); assert.equal((await s.requestChecks()).status, "failed");
    } finally { await s.close(); }
  }
});

test("pull checks dropped COMMIT acknowledgement preserves the committed version without another token or provider read", async () => {
  const s = await checksScenario(), sockets = new Set<Socket>(); let armed = false, dropped = false;
  const proxy = createServer(client => {
    const upstream = createConnection({ host: "127.0.0.1", port: config.databasePort }); sockets.add(client); sockets.add(upstream); let final = false;
    client.on("data", chunk => { if (armed && Buffer.from(chunk).includes(Buffer.from("COMMIT"))) final = true; upstream.write(chunk); });
    upstream.on("data", chunk => { if (final && Buffer.from(chunk).includes(Buffer.from("COMMIT"))) { dropped = true; client.destroy(); upstream.destroy(); return; } client.write(chunk); });
    for (const socket of [client, upstream]) { socket.on("error", () => {}); socket.on("close", () => { sockets.delete(socket); client.destroy(); upstream.destroy(); }); }
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const url = new URL(gitConnectionString(config, dbName)); url.port = String((proxy.address() as { port: number }).port);
  const through = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 5000, query_timeout: 5000 });
  try {
    await s.requestChecks(); const reader = await s.checksReader();
    await assert.rejects(reader.process({ beforeCommit: async () => { armed = true; } }, through), /outcome_unknown/);
    assert.equal(dropped, true); assert.equal((await s.checksContext()).jobs[0].eligible, true);
    assert.equal((await s.requestChecks()).status, "observed"); assert.equal(await reader.process(), null);
    assert.equal(reader.fixture.state.issued, 1); assert.equal(reader.fixture.state.checkReads, 2); assert.equal(reader.fixture.state.revoked, 1);
  } finally { await through.end(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => proxy.close(() => resolve())); await s.close(); }
});

test("pull revision durable capture joins exact observed Git commits, serves fixed diff, and replays without provider traffic", async () => {
  const s = await revisionScenario();
  try {
    const requests = await Promise.all([s.requestRevision(), s.requestRevision(), s.requestRevision()]);
    assert.equal(new Set(requests.map(j => j.jobId)).size, 1); const id = requests[0].jobId;
    const results = await Promise.all([s.processRevision(), s.processRevision()]); assert.equal(results.filter(Boolean).length, 1);
    const result = results.find(Boolean); assert.equal(result.status, "ready", JSON.stringify(result));
    const page = await pullRevisionCode(users[3], id, {}); assert.equal(page.record.headSha, s.input.head);
    assert.equal(page.record.baseSha, s.imported.baseSha); assert.ok(page.files.some(f => f.path === "code.txt"));
    const file = await pullRevisionFile(users[3], id, { path: "code.txt", diffHash: page.record.diffHash! });
    assert.equal(file.after, "task committed\n"); assert.ok(file.lines.some(l => l.kind === "added" && l.text.includes("task committed")));
    await assert.rejects(pullRevisionFile(users[3], id, { path: "../private", diffHash: page.record.diffHash! }), /不属于/);
    await assert.rejects(pullRevisionFile(users[3], id, { path: "code.txt", diffHash: "0".repeat(64) }), /不匹配/);
    await assert.rejects(pullRevisionCode(users[4], id, {}), /not_found/);
    const calls = s.codeReader.calls.length; assert.equal((await s.requestRevision()).replayed, true); assert.equal(await s.processRevision(), null);
    assert.equal(s.codeReader.calls.length, calls); assert.equal(s.codeReader.git.calls.receive, 0);
    assert.equal((await s.revisionRow(id)).transport_evidence.tokenRevoked, true);
    await assert.rejects(database().query("SELECT * FROM collab_git.pull_revision_jobs"), /permission denied/);
  } finally { await s.close(); }
});

test("pull revision authority, stale observations and cancellation never publish or fetch implicitly", async () => {
  const s = await revisionScenario();
  try {
    await assert.rejects(s.requestRevision(users[3]), /forbidden/);
    await assert.rejects(s.requestRevision(users[4]), /not_found/);
    await assert.rejects(s.requestRevision(users[1], { ...s.revisionInput, expectedObservationVersion: "0" }), /stale_revision/);
    const job = await s.requestRevision(), calls = s.codeReader.calls.length;
    await cancelPullRevision(users[1], job.jobId, { idempotencyKey: randomUUID(), reason: "Cancel the exact fixed code download" });
    assert.equal((await s.processRevision()).status, "cancelled"); assert.equal(s.codeReader.calls.length, calls);
    const next = await s.requestRevision(users[1], { ...s.revisionInput, idempotencyKey: randomUUID() });
    const result = await s.processRevision({ beforeFinish: async () => {
      await s.requestObservation(users[1], { ...s.observationInput, expectedObservationVersion: "1", idempotencyKey: randomUUID() });
      const observer = await s.observer(); assert.equal((await observer.process()).status, "observed");
    } });
    assert.equal(result.status, "failed"); assert.equal((await s.revisionRow(next.jobId)).manifest, null);
    await assert.rejects(pullRevisionCode(users[1], next.jobId, {}), /unavailable/);
  } finally { await s.close(); }
});

test("pull revision retains immutable history on new observations and refuses corrupted artifacts", async () => {
  const s = await revisionScenario();
  try {
    const job = await s.requestRevision(); assert.equal((await s.processRevision()).status, "ready");
    await s.requestObservation(users[1], { ...s.observationInput, expectedObservationVersion: "1", idempotencyKey: randomUUID() });
    const observer = await s.observer(); assert.equal((await observer.process()).status, "observed");
    const page = await pullRevisionCode(users[3], job.jobId, {}); assert.equal(page.record.current, false);
    assert.equal(page.record.observationVersion, "1");
    await writeFile(path.join(s.directory, "pull-revisions", job.jobId, "manifest.json"), "{}");
    await assert.rejects(pullRevisionCode(users[3], job.jobId, {}), /校验失败/);
    assert.equal((await s.revisionContext()).jobs[0].status, "ready");
  } finally { await s.close(); }
});

test("pull revision loses SQL ownership without refetching or accepting late finish", async () => {
  const s = await revisionScenario();
  try {
    const job = await s.requestRevision(); let claim = "";
    await assert.rejects(s.processRevision({ beforeFinish: async id => {
      const row = await s.revisionRow(id); claim = row.claim_id;
      await admin.query("SELECT pg_terminate_backend($1)", [row.backend_pid]); await new Promise(r => setTimeout(r, 40));
    } }), /outcome_unknown/);
    const calls = s.codeReader.calls.length;
    assert.equal((await s.processRevision()).failure, "pull_revision_reader_lost"); assert.equal(s.codeReader.calls.length, calls);
    await assert.rejects(broker.query("SELECT collab_git.finish_pull_revision($1,$2,'{}',$3,'{}')", [job.jobId, claim, "0".repeat(64)]), /claim_lost/);
    assert.equal((await s.requestRevision()).status, "failed");
  } finally { await s.close(); }
});

test("pull revision publication rechecks member, task, binding, installation and cancellation", async () => {
  for (const mode of ["member", "task", "binding", "installation", "cancel"]) {
    const s = await revisionScenario();
    try {
      const job = await s.requestRevision();
      const result = await s.processRevision({ beforeFinish: async () => {
        if (mode === "member") await admin.query("UPDATE collab.project_memberships SET authorization_version=authorization_version+2 WHERE project_id=$1 AND user_id=$2", [project, users[1]]);
        else if (mode === "task") await admin.query("UPDATE collab.tasks SET version=version+1 WHERE id=$1", [s.task.id]);
        else if (mode === "binding") await admin.query("UPDATE collab.github_bindings SET verified_at=now() WHERE repository_id=$1", [s.imported.id]);
        else if (mode === "installation") await admin.query("UPDATE collab.github_installations SET enabled=false WHERE id=$1", [connectionId]);
        else await cancelPullRevision(users[1], job.jobId, { idempotencyKey: randomUUID(), reason: "Cancel before fixed code publication" });
      } });
      assert.equal(result.status, mode === "cancel" ? "cancelled" : "failed");
      assert.equal((await s.revisionRow(job.jobId)).manifest_hash, null); assert.equal(s.codeReader.state.revoked, 1);
    } finally { if (mode === "installation") await admin.query("UPDATE collab.github_installations SET enabled=true WHERE id=$1", [connectionId]); await s.close(); }
  }
});

test("pull revision SQL binds manifest bytes and observed identities and denies a second owner", async () => {
  const s = await revisionScenario(), db = await broker.connect();
  try {
    const job = await s.requestRevision();
    for (const sql of ["SELECT * FROM collab_git.pull_revision_jobs", "SELECT * FROM collab_git.credentials"])
      await assert.rejects(broker.query(sql), /permission/);
    await assert.rejects(asUser(users[1], c => c.query("SELECT collab_git.claim_pull_revision()")), /permission/);
    const claim = (await db.query("SELECT collab_git.claim_pull_revision() AS result")).rows[0].result;
    await assert.rejects(broker.query("SELECT collab_git.begin_pull_revision($1,$2)", [job.jobId, claim.claimId]), /claim_lost/);
    await db.query("SELECT collab_git.begin_pull_revision($1,$2)", [job.jobId, claim.claimId]);
    const { capturePullRevision } = await import("../../lib/collab/git/pull-revision");
    const a = claim.admission, snapshot = a.snapshot;
    const captured = await s.codeReader.readClient.readGitRepository(s.binding.githubRepositoryId, (_e, read, signal) => capturePullRevision(s.directory, {
      version: 1, revisionId: job.jobId, changeId: s.proposal.jobId, repositoryId: s.imported.id,
      githubRepositoryId: s.binding.githubRepositoryId, pullId: a.identity.id, pullNumber: a.identity.number,
      observationId: a.observationId, observationHash: a.observationHash, headSha: snapshot.headSha, baseSha: snapshot.baseSha, headRef: snapshot.headRef, baseRef: snapshot.baseRef,
    }, read, signal));
    const { manifest, manifestHash } = captured.value;
    for (const patch of [{ headSha: "0".repeat(40) }, { observationId: randomUUID() }, { observationHash: "0".repeat(64) }, { pullNumber: 900 }]) {
      const bytes = JSON.stringify({ ...manifest, input: { ...manifest.input, ...patch } });
      await assert.rejects(db.query("SELECT collab_git.finish_pull_revision($1,$2,$3,$4,$5)", [job.jobId, claim.claimId, bytes, createHash("sha256").update(bytes).digest("hex"), captured.evidence]), /invalid_pull_revision_evidence/);
    }
    for (const patch of [{ tokenRevoked: false }, { repositoryId: "1" }, { ownerId: "1" }, { verifiedAt: new Date(0).toISOString() }])
      await assert.rejects(db.query("SELECT collab_git.finish_pull_revision($1,$2,$3,$4,$5)", [job.jobId, claim.claimId, JSON.stringify(manifest), manifestHash, { ...captured.evidence, ...patch }]), /invalid_pull_revision_evidence/);
    await assert.rejects(db.query("SELECT collab_git.finish_pull_revision($1,$2,$3,$4,$5)", [job.jobId, claim.claimId, JSON.stringify(manifest), "0".repeat(64), captured.evidence]), /invalid_pull_revision_evidence/);
    assert.equal((await db.query("SELECT collab_git.finish_pull_revision($1,$2,$3,$4,$5) AS result", [job.jobId, claim.claimId, JSON.stringify(manifest), manifestHash, captured.evidence])).rows[0].result.status, "ready");
    await assert.rejects(db.query("SELECT collab_git.finish_pull_revision($1,$2,$3,$4,$5)", [job.jobId, claim.claimId, JSON.stringify(manifest), manifestHash, captured.evidence]), /claim_lost/);
  } finally { db.release(true); await s.close(); }
});

test("pull observation concurrent requests and owners append one read-only snapshot with exact evidence and ordered versions", async () => {
  const s = await pullObservationScenario();
  try {
    const initial = await s.observationContext(); assert.equal(initial.observationVersion, "0"); assert.equal(initial.latest, null);
    const replies = await Promise.all([s.requestObservation(), s.requestObservation(), s.requestObservation()]);
    assert.equal(new Set(replies.map(r => r.jobId)).size, 1); assert.equal(replies.filter(r => !r.replayed).length, 1);
    const reader = await s.observer(); reader.api.state.installPulls = "read"; reader.api.state.installContents = "read";
    const workers = await Promise.all([reader.process(), reader.process()]); assert.equal(workers.filter(Boolean).length, 1);
    const result = workers.find(Boolean); assert.equal(result.status, "observed", JSON.stringify(result)); assert.equal(result.observationVersion, "1");
    assert.equal(createHash("sha256").update(result.observationText).digest("hex"), result.observationHash);
    assert.deepEqual(JSON.parse(result.observationText), result.observation);
    assert.equal(result.observation.snapshot.headSha, s.input.head); assert.equal(reader.api.state.reads, 1);
    assert.equal(reader.api.state.issued, 1); assert.equal(reader.api.state.revoked, 1); assert.equal(reader.api.state.creates, 0);
    assert.equal(reader.api.containsCredential(result), false); assert.equal((await s.requestObservation()).replayed, true);
    assert.equal(await reader.process(), null); assert.equal((await s.observationContext(users[3])).latest?.jobId, result.jobId);
    await assert.rejects(s.requestObservation(users[1], { ...s.observationInput, idempotencyKey: randomUUID() }), /stale_revision/);
    const next = await s.requestObservation(users[1], { ...s.observationInput, idempotencyKey: randomUUID(), expectedObservationVersion: "1" });
    const second = await s.observer(); second.api.state.mutateRead = { state: "closed", merged: true, merge_commit_sha: s.input.head, draft: false };
    assert.equal((await second.process()).observationVersion, "2");
    const after = await s.observationContext(); assert.equal(after.latest?.jobId, next.jobId); assert.equal(after.latest?.observation?.snapshot.merged, true);
    assert.equal(after.jobs.find(j => j.jobId === result.jobId)?.observation?.snapshot.merged, false);
    assert.deepEqual(after.initial, initial.initial); assert.equal((await s.pullContext()).delivery?.status, "created");
  } finally { await s.close(); }
});

test("pull observation current task authority survives original author departure but denies viewers, stale payloads and cross-project readers", async () => {
  const s = await pullObservationScenario();
  try {
    await assert.rejects(s.requestObservation(users[3]), /forbidden/); await assert.rejects(s.observationContext(users[4]), /not_found/);
    await assert.rejects(s.requestObservation(users[4]), /not_found/);
    await admin.query("UPDATE collab.project_memberships SET active=false WHERE project_id=$1 AND user_id=$2", [project, users[1]]);
    const job = await s.requestObservation(users[2]); assert.equal(job.status, "queued");
    const reader = await s.observer(); assert.equal((await reader.process()).status, "observed");
    await assert.rejects(s.requestObservation(users[2], { ...s.observationInput, expectedTaskVersion: s.observationInput.expectedTaskVersion+1 }), /idempotency_conflict/);
    await assert.rejects(s.requestObservation(users[2], { ...s.observationInput, idempotencyKey: randomUUID() }), /stale_revision/);
  } finally {
    await admin.query("UPDATE collab.project_memberships SET active=true WHERE project_id=$1 AND user_id=$2", [project, users[1]]); await s.close();
  }
});

test("pull observation admission validates MFA and exact payloads; queued cancellation uses no credentials and never revives", async () => {
  const s = await pullObservationScenario();
  try {
    await admin.query('UPDATE public."user" SET "twoFactorEnabled"=false WHERE id=$1', [users[2]]);
    await admin.query("UPDATE collab.memberships SET role='admin' WHERE organization_id=$1 AND user_id=$2", [organization, users[2]]);
    await assert.rejects(s.requestObservation(users[2]), /forbidden/);
    const { idempotencyKey, ...payload } = s.observationInput;
    for (const patch of [{ expectedObservationVersion: 0 }, { expectedTaskVersion: "1" }, { expectedObservationVersion: "-1" }, { identity: {} }])
      await assert.rejects(asUser(users[1], db => db.query("SELECT collab.request_pull_observation($1,$2,$3)", [s.proposal.jobId, idempotencyKey, { ...payload, ...patch }])), /invalid_pull_observation/);
    const job = await s.requestObservation();
    await assert.rejects(s.requestObservation(users[1], { ...s.observationInput, idempotencyKey: randomUUID() }), /observation_busy/);
    const key = randomUUID(); await s.cancelObservation(job.jobId, users[1], key); assert.equal((await s.cancelObservation(job.jobId, users[1], key)).replayed, true);
    await assert.rejects(s.cancelObservation(job.jobId, users[3]), /forbidden/);
    const reader = await s.observer(); assert.equal((await reader.process()).status, "cancelled"); assert.equal(reader.api.state.issued, 0);
    assert.equal((await s.requestObservation()).status, "cancelled"); assert.equal((await s.observationContext()).observationVersion, "0"); assert.equal(await reader.process(), null);
  } finally {
    await admin.query("UPDATE collab.memberships SET role='member' WHERE organization_id=$1 AND user_id=$2", [organization, users[2]]);
    await admin.query('UPDATE public."user" SET "twoFactorEnabled"=true WHERE id=$1', [users[2]]); await s.close();
  }
});

test("pull observation records actual head/base movement, retargeting and deleted closed branches without rewriting creation history", async () => {
  const s = await pullObservationScenario();
  try {
    const original = path.join(s.directory, "original"), remote = path.join(s.directory, "source.git");
    await writeFile(path.join(original, "remote-change.txt"), "New remote base\n"); await git(original, ["add", "."]); await git(original, ["commit", "-m", "Remote base advances"]);
    const base = await git(original, ["rev-parse", "HEAD"]); await git(remote, ["-c", "protocol.file.allow=always", "fetch", original, "main:main"]);
    await git(remote, ["update-ref", s.ref, s.imported.baseSha]); // A real force-push back is a new observation, not an older local sequence.
    await s.requestObservation(); const first = await s.observer(); first.api.state.mutateRead = { title: "Remote title <b>literal</b>", body: "Remote description", draft: false };
    const a = await first.process(); assert.equal(a.status, "observed"); assert.equal(a.observation.snapshot.headSha, s.imported.baseSha); assert.equal(a.observation.snapshot.baseSha, base);
    assert.equal(a.observation.snapshot.titleHash, createHash("sha256").update("Remote title <b>literal</b>").digest("hex"));
    await s.requestObservation(users[1], { ...s.observationInput, idempotencyKey: randomUUID(), expectedObservationVersion: "1" });
    const second = await s.observer(), created = s.creator.created[0];
    second.api.state.mutateRead = { base: { ...(created.base as object), ref: "release/next", sha: base } };
    const b = await second.process(); assert.equal(b.observation.snapshot.baseRef, "release/next");
    await git(remote, ["update-ref", "-d", s.ref]);
    await s.requestObservation(users[1], { ...s.observationInput, idempotencyKey: randomUUID(), expectedObservationVersion: "2" });
    const third = await s.observer(); third.api.state.mutateRead = { head: created.head, state: "closed", merged: false };
    const c = await third.process(); assert.equal(c.status, "observed"); assert.equal(c.observation.snapshot.state, "closed");
    const history = await s.observationContext(); assert.equal(history.observationVersion, "3"); assert.equal(history.jobs.length, 3);
    assert.equal(history.initial.headSha, s.input.head); assert.equal(history.initial.baseSha, s.imported.baseSha);
    assert.equal(first.api.calls.some(call => /git\/ref|\/branches|git-receive-pack|\/merge|\/reviews/.test(call.route)), false);
  } finally { await s.close(); }
});

test("pull observation rejects missing, corrupt and wrong-scope provider evidence without deleting or replacing the last successful snapshot", async () => {
  const s = await pullObservationScenario();
  try {
    await s.requestObservation(); const initial = await s.observer(), good = await initial.process();
    for (const mode of ["read-missing", "read-cut", "read-large", "revoke", "id", "scope", "write-token", "permission", "repository"]) {
      await s.requestObservation(users[1], { ...s.observationInput, idempotencyKey: randomUUID(), expectedObservationVersion: "1" });
      const reader = await s.observer();
      if (mode === "id") reader.api.state.mutateRead = { id: 9876 };
      else if (mode === "scope") reader.api.state.mutateRead = { head: { ...(s.creator.created[0].head as object), repo: { ...(s.creator.created[0].head as { repo: object }).repo, id: 9876 } } };
      else if (mode === "write-token") reader.api.state.permissions.pull_requests = "write";
      else if (mode === "permission") reader.api.state.installPulls = "none";
      else if (mode === "repository") reader.api.state.nodeId = "R_other";
      else reader.api.state.fail = mode;
      assert.equal((await reader.process()).status, "failed", mode); assert.equal(reader.api.state.creates, 0);
      const context = await s.observationContext(); assert.equal(context.observationVersion, "1"); assert.equal(context.latest?.jobId, good.jobId);
      assert.equal(context.latest?.observation?.snapshot.state, "open"); assert.equal(context.jobs[0].status, "failed");
      assert.equal(reader.api.containsCredential(context), false);
      if (mode !== "revoke") assert.equal(reader.api.state.revoked, reader.api.state.issued);
    }
  } finally { await s.close(); }
});

test("pull observation publication rechecks member, task, binding, installation and cancellation after the remote read", async () => {
  for (const mode of ["member", "task", "binding", "installation", "cancel"]) {
    const s = await pullObservationScenario();
    try {
      const job = await s.requestObservation(), reader = await s.observer();
      const result = await reader.process({ beforeFinish: async () => {
        if (mode === "member") await admin.query("UPDATE collab.project_memberships SET authorization_version=authorization_version+2 WHERE project_id=$1 AND user_id=$2", [project, users[1]]);
        else if (mode === "task") await admin.query("UPDATE collab.tasks SET version=version+1 WHERE id=$1", [s.task.id]);
        else if (mode === "binding") await admin.query("UPDATE collab.github_bindings SET verified_at=now() WHERE repository_id=$1", [s.imported.id]);
        else if (mode === "installation") await admin.query("UPDATE collab.github_installations SET enabled=false WHERE id=$1", [connectionId]);
        else await s.cancelObservation(job.jobId);
      } });
      assert.equal(result.status, mode === "cancel" ? "cancelled" : "failed"); assert.equal(reader.api.state.reads, 1); assert.equal(reader.api.state.revoked, 1);
      assert.equal((await s.observationContext()).observationVersion, "0"); assert.equal((await s.requestObservation()).replayed, true);
    } finally { if (mode === "installation") await admin.query("UPDATE collab.github_installations SET enabled=true WHERE id=$1", [connectionId]); await s.close(); }
  }
});

test("pull observation restricted SQL and pinned identity reject forged snapshots, stale times, cleanup and claims", async () => {
  const s = await pullObservationScenario(), db = await broker.connect();
  try {
    const job = await s.requestObservation();
    for (const sql of ["SELECT * FROM collab_git.pull_observation_jobs", "UPDATE collab_git.pull_changes SET observation_version=900", "SELECT * FROM collab_git.credentials"])
      await assert.rejects(broker.query(sql), /permission/);
    await assert.rejects(asUser(users[1], c => c.query("SELECT collab_git.claim_pull_observation()")), /permission/);
    const claim = (await db.query("SELECT collab_git.claim_pull_observation() AS result")).rows[0].result;
    await assert.rejects(broker.query("SELECT collab_git.begin_pull_observation($1,$2)", [job.jobId, claim.claimId]), /claim_lost/);
    await assert.rejects(db.query("SELECT collab_git.begin_pull_observation($1,$2)", [job.jobId, randomUUID()]), /claim_lost/);
    await db.query("SELECT collab_git.begin_pull_observation($1,$2)", [job.jobId, claim.claimId]);
    const reader = await s.observer(), { pair } = await import("./fixtures/github");
    const value = await new GitHubPullObserver(githubConfig, pair.privateKey, reader.api.transport).observe(s.binding, claim.admission.identity);
    for (const patch of [{ identity: { ...value.identity, id: "1" } }, { binding: { ...s.binding, private: false } }, { tokenRevoked: false },
      { snapshot: { ...value.snapshot, headSha: "0".repeat(40) } }, { snapshot: { ...value.snapshot, draft: "true" } },
      ...["bad\nref", "bad..ref", "a/.hidden", "a.lock", "a//b", "a@{b", "bad[ref"].map(headRef => ({ snapshot: { ...value.snapshot, headRef } })),
      { snapshot: { ...value.snapshot, merged: true, state: "open" } }, { completedAt: new Date(0).toISOString() },
      { snapshot: { ...value.snapshot, observedAt: new Date(0).toISOString() } }, { tokenExpiresAt: null }]) {
      await assert.rejects(db.query("SELECT collab_git.finish_pull_observation($1,$2,$3)", [job.jobId, claim.claimId, JSON.stringify({ ...value, ...patch })]), /invalid_pull_observation_evidence/);
    }
    assert.equal((await s.observationContext()).observationVersion, "0");
    assert.equal((await db.query("SELECT collab_git.finish_pull_observation($1,$2,$3) AS result", [job.jobId, claim.claimId, JSON.stringify(value)])).rows[0].result.status, "observed");
    await assert.rejects(db.query("SELECT collab_git.finish_pull_observation($1,$2,$3)", [job.jobId, claim.claimId, JSON.stringify(value)]), /claim_lost/);
    assert.equal((await s.observationContext()).observationVersion, "1");
  } finally { db.release(true); await s.close(); }
});

test("pull observation actual SQL owner loss before and after reading cannot replay or publish stale callbacks", async () => {
  for (const phase of ["afterBegin", "beforeFinish"] as const) {
    const s = await pullObservationScenario();
    try {
      const job = await s.requestObservation(), reader = await s.observer(); let nonce = "";
      await assert.rejects(reader.process({ [phase]: async () => {
        const row = (await admin.query("SELECT backend_pid,claim_id FROM collab_git.pull_observation_jobs WHERE id=$1", [job.jobId])).rows[0]; nonce = row.claim_id;
        await admin.query("SELECT pg_terminate_backend($1)", [row.backend_pid]); await new Promise(resolve => setTimeout(resolve, 30));
      } }), /outcome_unknown/);
      assert.equal((await reader.process()).status, "failed"); assert.equal(reader.api.state.issued, phase === "beforeFinish" ? 1 : 0);
      assert.equal(reader.api.state.reads, phase === "beforeFinish" ? 1 : 0); assert.equal(await reader.process(), null);
      await assert.rejects(broker.query("SELECT collab_git.fail_pull_observation($1,$2,'late_callback')", [job.jobId, nonce]), /claim_lost/);
      assert.equal((await s.observationContext()).observationVersion, "0"); assert.equal((await s.requestObservation()).status, "failed");
    } finally { await s.close(); }
  }
});

test("pull observation dropped COMMIT acknowledgement preserves the committed version without another token or provider read", async () => {
  const s = await pullObservationScenario(), sockets = new Set<Socket>(); let armed = false, dropped = false;
  const proxy = createServer(client => {
    const upstream = createConnection({ host: "127.0.0.1", port: config.databasePort }); sockets.add(client); sockets.add(upstream); let final = false;
    client.on("data", chunk => { if (armed && Buffer.from(chunk).includes(Buffer.from("COMMIT"))) final = true; upstream.write(chunk); });
    upstream.on("data", chunk => { if (final && Buffer.from(chunk).includes(Buffer.from("COMMIT"))) { dropped = true; client.destroy(); upstream.destroy(); return; } client.write(chunk); });
    for (const socket of [client, upstream]) { socket.on("error", () => {}); socket.on("close", () => { sockets.delete(socket); client.destroy(); upstream.destroy(); }); }
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const url = new URL(gitConnectionString(config, dbName)); url.port = String((proxy.address() as { port: number }).port);
  const through = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 5000, query_timeout: 5000 });
  try {
    await s.requestObservation(); const reader = await s.observer();
    await assert.rejects(reader.process({ beforeCommit: async () => { armed = true; } }, through), /outcome_unknown/);
    assert.equal(dropped, true); assert.equal((await s.observationContext()).observationVersion, "1");
    assert.equal((await s.requestObservation()).status, "observed"); assert.equal(await reader.process(), null);
    assert.equal(reader.api.state.issued, 1); assert.equal(reader.api.state.reads, 1); assert.equal(reader.api.state.revoked, 1);
  } finally { await through.end(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => proxy.close(() => resolve())); await s.close(); }
});

test("pull observation live authority stops blocked provider reads after revocation or silent SQL", { timeout: 30000 }, async () => {
  for (const silent of [false, true]) {
    const s = await pullObservationScenario(), reader = await s.observer(), sockets = new Set<Socket>(); let held = false, release!: () => void, reached!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; }), observing = new Promise<void>(resolve => { reached = resolve; });
    reader.api.state.beforeRead = async () => { reached(); await blocked; };
    const proxy = createServer(client => {
      const upstream = createConnection({ host: "127.0.0.1", port: config.databasePort }); sockets.add(client); sockets.add(upstream); let mute = false;
      client.on("data", chunk => { if (silent && Buffer.from(chunk).includes(Buffer.from("pull_observation_live"))) { mute = true; held = true; } upstream.write(chunk); });
      upstream.on("data", chunk => { if (!mute) client.write(chunk); });
      for (const socket of [client, upstream]) { socket.on("error", () => {}); socket.on("close", () => { sockets.delete(socket); client.destroy(); upstream.destroy(); }); }
    });
    await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
    const url = new URL(gitConnectionString(config, dbName)); url.port = String((proxy.address() as { port: number }).port);
    const through = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
    let running: ReturnType<typeof reader.process> | undefined;
    try {
      await s.requestObservation(); const began = Date.now(); running = reader.process({}, through);
      const settled = running.then(value => ({ value }), error => ({ error }));
      await Promise.race([observing, settled.then(() => { throw new Error("Expected a held PR read"); })]);
      if (!silent) await admin.query("UPDATE collab.project_memberships SET active=false WHERE project_id=$1 AND user_id=$2", [project, users[1]]);
      const result = await settled; assert.ok(Date.now()-began<6000); assert.equal(reader.api.state.revoked, 1);
      if (silent) { assert.equal(held, true); assert.ok("error" in result); assert.match(result.error.message, /outcome_unknown/); assert.equal((await reader.process()).status, "failed"); }
      else { assert.ok("value" in result); assert.equal(result.value.status, "failed"); }
      assert.equal((await s.observationContext(users[2])).observationVersion, "0");
    } finally {
      release(); await running?.catch(() => {}); await through.end(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => proxy.close(() => resolve()));
      await admin.query("UPDATE collab.project_memberships SET active=true WHERE project_id=$1 AND user_id=$2", [project, users[1]]); await s.close();
    }
  }
});

test("pull observation final transaction holds task authority until evidence and the latest pointer commit together", async () => {
  const s = await pullObservationScenario(); let mutation: Promise<unknown> | undefined, changed = false;
  try {
    await s.requestObservation(); const reader = await s.observer();
    const result = await reader.process({ beforeCommit: async () => {
      mutation = admin.query("UPDATE collab.tasks SET owner_id=$1,version=version+1 WHERE id=$2", [users[2], s.task.id]).then(() => { changed = true; });
      await new Promise(resolve => setTimeout(resolve, 150)); assert.equal(changed, false);
      assert.equal((await s.observationContext(users[3])).observationVersion, "0");
    } });
    await mutation; assert.equal(changed, true); assert.equal(result.status, "observed");
    const context = await s.observationContext(users[2]); assert.equal(context.observationVersion, "1"); assert.equal(context.latest?.jobId, result.jobId);
    assert.equal(context.canRequest, true); assert.equal((await s.observationContext(users[1])).canRequest, false);
  } finally { await mutation; await s.close(); }
});

test("pull observation does not adopt unknown or pre-existing PRs through refresh", async () => {
  const s = await pullCreationScenario();
  try {
    s.creator.state.fail = "create-cut"; await s.requestPull(); assert.equal((await s.deliverPull()).status, "unknown");
    assert.equal(s.creator.created.length, 1);
    await assert.rejects(pullObservationContext(users[1], s.proposal.jobId), /not_found/);
    await assert.rejects(requestPullObservation(users[1], s.proposal.jobId, { idempotencyKey: randomUUID(), expectedTaskVersion: 1, expectedObservationVersion: "0" }), /not_found/);
    assert.equal((await s.pullContext()).occupied, true); assert.equal((await s.pullContext()).delivery?.changeRequest, null);
  } finally { await s.close(); }
});

test("pull observation actual broker SIGKILL before and after remote reading fails once without resetting creation history", async () => {
  for (const phase of ["afterBegin", "beforeFinish"]) {
    const s = await pullObservationScenario(); let child: ReturnType<typeof spawn> | undefined;
    try {
      const job = await s.requestObservation(), script = path.join(s.directory, "kill-observation.mts"), { pair } = await import("./fixtures/github");
      await writeFile(path.join(s.directory, "observation-master.key"), master, { mode: 0o600 });
      await writeFile(path.join(s.directory, "observation-app.pem"), pair.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
      await writeFile(path.join(s.directory, "observation-attempt.json"), JSON.stringify(s.fixed.attempt), { mode: 0o600 });
      const modulePath = (file: string) => JSON.stringify(pathToFileURL(path.resolve(file)).href);
      await writeFile(script, [
        "import pg from " + modulePath("node_modules/pg/lib/index.js") + ";",
        "import {readFile,writeFile} from 'node:fs/promises'; import {createPrivateKey,createPublicKey} from 'node:crypto';",
        "import {processPullObservation} from " + modulePath("lib/collab/git/pull-observation-broker.ts") + ";",
        "import {githubPullFixture} from " + modulePath("tests/collab/fixtures/github-pull.ts") + ";",
        "import {config} from " + modulePath("tests/collab/fixtures/github.ts") + ";",
        "const root=process.env.TEST_OBSERVATION_ROOT, privateKey=createPrivateKey(await readFile(root+'/observation-app.pem'));",
        "const fixture=await githubPullFixture(root,JSON.parse(await readFile(root+'/observation-attempt.json','utf8')),'observe',{privateKey,publicKey:createPublicKey(privateKey)},config);await fixture.seedObservation();",
        "const pool=new pg.Pool({connectionString:process.env.TEST_OBSERVATION_SQL});",
        "await processPullObservation(pool,()=>readFile(root+'/observation-master.key'),{transport:fixture.transport,[process.env.TEST_OBSERVATION_PHASE]:async(id)=>{",
        "await writeFile(root+'/observation-checkpoint.json',JSON.stringify({reads:fixture.state.reads,issued:fixture.state.issued,revoked:fixture.state.revoked}),{mode:0o600});process.send({id});await new Promise(()=>{});}});",
      ].join("\n"), { mode: 0o600 });
      child = spawn(process.execPath, ["--import", "tsx", script], { env: { ...process.env, TEST_OBSERVATION_ROOT: s.directory, TEST_OBSERVATION_SQL: gitConnectionString(config, dbName), TEST_OBSERVATION_PHASE: phase }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
      const [message] = await once(child, "message", { signal: AbortSignal.timeout(30000) }); assert.equal(message.id, job.jobId);
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
      const n = phase === "beforeFinish" ? 1 : 0;
      assert.deepEqual(JSON.parse(await readFile(path.join(s.directory, "observation-checkpoint.json"), "utf8")), { reads: n, issued: n, revoked: n });
      const reader = await s.observer(); assert.equal((await reader.process()).status, "failed"); assert.equal(await reader.process(), null); assert.equal(reader.api.state.issued, 0);
      assert.equal((await s.observationContext()).observationVersion, "0"); assert.equal((await s.pullContext()).delivery?.status, "created");
    } finally {
      if (child?.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
      await s.close();
    }
  }
});

test("pull observation upgrade preserves prior creation evidence and does not enqueue automatic provider reads", async () => {
  const s = await pullObservationScenario(), db = await admin.connect();
  try {
    const initial = await s.observationContext(), sql = await readFile(path.resolve("db/migrations/032-pull-observation-jobs.sql"), "utf8");
    const functions = [...sql.matchAll(/CREATE FUNCTION ((?:collab|collab_git)\.[a-z_]+)\(/g)].map(match => match[1]);
    await db.query("BEGIN");
    await db.query("DROP TABLE collab_git.pull_observation_actions,collab_git.pull_observation_jobs CASCADE");
    await db.query("ALTER TABLE collab_git.pull_changes DROP COLUMN observation_version,DROP COLUMN latest_observation_id");
    const existing = (await db.query("SELECT n.nspname||'.'||p.proname AS name,pg_get_function_identity_arguments(p.oid) AS args FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname||'.'||p.proname=ANY($1)", [functions])).rows;
    for (const item of existing) await db.query("DROP FUNCTION IF EXISTS " + item.name + "(" + item.args + ") CASCADE");
    await db.query(sql);
    const value = (await db.query("SELECT observation_version,latest_observation_id FROM collab_git.pull_changes WHERE id=$1", [s.proposal.jobId])).rows[0];
    assert.deepEqual(value, { observation_version: "0", latest_observation_id: null });
    assert.equal((await db.query("SELECT count(*)::int AS n FROM collab_git.pull_observation_jobs")).rows[0].n, 0);
    assert.deepEqual((await db.query("SELECT evidence FROM collab_git.pull_change_observations WHERE change_id=$1 ORDER BY sequence DESC LIMIT 1", [s.proposal.jobId])).rows[0].evidence, initial.initial);
    await db.query("ROLLBACK"); assert.equal((await s.observationContext()).observationVersion, "0");
  } finally { await db.query("ROLLBACK").catch(() => {}); db.release(); await s.close(); }
});

test("pull creation durable admission, concurrent owners and exact acknowledged draft yield immutable ChangeRequest observations", async () => {
  const s = await pullCreationScenario();
  try {
    const replies = await Promise.all([s.requestPull(), s.requestPull(), s.requestPull()]);
    assert.equal(replies.filter(r => !r.replayed).length, 1); assert.equal(new Set(replies.map(r => r.jobId)).size, 1);
    assert.equal(s.creator.state.issued, 0); assert.equal((await s.pullContext()).occupied, true);
    const workers = await Promise.all([s.deliverPull(), s.deliverPull()]); assert.equal(workers.filter(Boolean).length, 1);
    const result = workers.find(Boolean); assert.equal(result.status, "created", JSON.stringify(result));
    assert.equal(s.creator.state.creates, 1); assert.equal(s.creator.state.revoked, 1); assert.equal(result.outcome.revision, "matching");
    assert.equal(result.changeRequest.id, s.proposal.jobId); assert.equal(result.changeRequest.observations.length, 2);
    for (const observation of result.changeRequest.observations) {
      assert.equal(observation.sourceSha, s.fixed.attempt.intent.headSha); assert.equal(observation.targetSha, s.fixed.attempt.intent.baseSha);
      assert.equal(createHash("sha256").update(observation.evidenceText).digest("hex"), observation.evidenceHash);
      assert.deepEqual(JSON.parse(observation.evidenceText), observation.evidence);
    }
    assert.equal((await s.pullContext(users[3])).delivery?.changeRequest?.url, result.changeRequest.url);
    assert.equal((await s.pullContext()).occupied, false); assert.equal((await s.requestPull()).replayed, true);
    assert.equal(await s.deliverPull(), null); assert.equal(s.creator.state.creates, 1);
    const row = (await admin.query("SELECT result_text,result_hash FROM collab_git.pull_deliveries WHERE id=$1", [s.proposal.jobId])).rows[0];
    assert.equal(createHash("sha256").update(row.result_text).digest("hex"), row.result_hash);
    assert.equal(s.creator.containsCredential(result), false);
  } finally { await s.close(); }
});

test("pull creation requires current authority, every explicit acknowledgement and exact hashes before credentials", async () => {
  const s = await pullCreationScenario();
  try {
    await assert.rejects(s.requestPull(users[3]), /forbidden/); await assert.rejects(s.requestPull(users[4]), /not_found/);
    await assert.rejects(s.pullContext(users[4]), /not_found/);
    const { idempotencyKey, ...payload } = s.creationInput;
    for (const key of ["acknowledgeContent", "acknowledgeNotification", "acknowledgeVersions"]) {
      await assert.rejects(asUser(users[1], db => db.query("SELECT collab.request_task_pull_delivery($1,$2,$3)", [s.proposal.jobId, idempotencyKey, { ...payload, [key]: false }])), /invalid_task_pull_delivery/);
    }
    await assert.rejects(s.requestPull(users[1], { ...s.creationInput, requestHash: "f".repeat(64) }), /stale_task_pull_proposal/);
    await s.requestPull();
    await assert.rejects(s.requestPull(users[1], { ...s.creationInput, requestHash: "f".repeat(64) }), /idempotency_conflict/);
    await assert.rejects(s.requestPull(users[1], { ...s.creationInput, idempotencyKey: randomUUID() }), /delivery_exists/);
    await assert.rejects(s.requestPull(users[2]), /delivery_exists/);
    await s.pullAction(); assert.equal((await s.deliverPull()).status, "not_created");
    assert.equal(s.creator.state.issued, 0); assert.equal((await s.pullContext()).occupied, false);
    assert.equal((await s.requestPull()).status, "not_created"); assert.equal(await s.deliverPull(), null);
  } finally { await s.close(); }
});

test("pull creation and legacy push confirmation share a stable head fence in both directions and concurrent admission", async () => {
  for (const race of [false, true]) {
    const s = await pullCreationScenario(1, true);
    try {
      const competitor = s.competitor; assert.ok(competitor);
      const push = () => confirmTaskPush(users[2], competitor.jobId, competitor.input);
      if (race) {
        const results = await Promise.allSettled([s.requestPull(), push()]);
        assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
        const rejected = results.find(r => r.status === "rejected"); assert.ok(rejected); assert.match(String(rejected.reason), /destination_busy/);
        if (results[0].status === "fulfilled") { await s.pullAction(); await s.deliverPull(); }
        else { assert.equal(results[1].status, "fulfilled"); await s.withdraw(results[1].value.id, users[2]); }
      } else {
        await s.requestPull(); await assert.rejects(push(), /destination_busy/);
        assert.equal((await taskPushConfirmationContext(users[2], competitor.jobId)).occupied, true);
        await s.pullAction(); await s.deliverPull();
        const confirmation = await push(), next = await s.anotherProposal();
        await assert.rejects(next.request(), /destination_busy/); assert.equal((await taskPullDeliveryContext(users[1], next.id)).occupied, true);
        await s.withdraw(confirmation.id, users[2]); await next.request();
        await actOnTaskPullDelivery(users[1], next.id, { idempotencyKey: randomUUID(), action: "cancel", reason: "Stop unsent second proposal after fence test", acknowledgeUnknown: false });
        assert.equal((await s.deliverPull()).status, "not_created");
      }
      assert.equal((await s.pullContext()).occupied, false); assert.equal(s.creator.state.issued, 0);
    } finally { await s.close(); }
  }
});

test("pull creation validates both original and dispatch grants, scoped MFA and task or installation changes", async () => {
  for (const change of ["proposal_member", "dispatch_member", "mfa", "task", "binding", "installation"]) {
    const s = await pullCreationScenario(2);
    try {
      await s.requestPull();
      const result = await s.deliverPull({ afterBegin: async () => {
        if (change.endsWith("member")) await admin.query("UPDATE collab.project_memberships SET authorization_version=authorization_version+2 WHERE project_id=$1 AND user_id=$2",
          [project, change === "proposal_member" ? users[1] : users[2]]);
        else if (change === "mfa") {
          await admin.query("UPDATE collab.memberships SET role='admin' WHERE organization_id=$1 AND user_id=$2", [organization, users[2]]);
          await admin.query('UPDATE public."user" SET "twoFactorEnabled"=false WHERE id=$1', [users[2]]);
        } else if (change === "task") await admin.query("UPDATE collab.tasks SET version=version+1 WHERE id=$1", [s.task.id]);
        else if (change === "binding") await admin.query("UPDATE collab.github_bindings SET verified_at=now() WHERE repository_id=$1", [s.imported.id]);
        else await admin.query("UPDATE collab.github_installations SET enabled=false WHERE id=$1", [connectionId]);
      } });
      assert.equal(result.status, "not_created"); assert.equal(s.creator.state.creates, 0); assert.equal((await s.pullContext()).occupied, false);
    } finally {
      await admin.query("UPDATE collab.memberships SET role='member' WHERE organization_id=$1 AND user_id=$2", [organization, users[2]]);
      await admin.query('UPDATE public."user" SET "twoFactorEnabled"=true WHERE id=$1', [users[2]]);
      await admin.query("UPDATE collab.github_installations SET enabled=true WHERE id=$1", [connectionId]); await s.close();
    }
  }
});

test("pull creation refuses stale remote baselines and existing PRs without adopting them", async () => {
  for (const change of ["head", "base", "existing"]) {
    const s = await pullCreationScenario();
    try {
      await s.requestPull();
      if (change === "head") await git(path.join(s.directory, "source.git"), ["update-ref", s.ref, s.imported.baseSha]);
      if (change === "base") await git(path.join(s.directory, "source.git"), ["update-ref", "refs/heads/main", s.input.head]);
      if (change === "existing") s.creator.state.existing = true;
      const result = await s.deliverPull();
      assert.equal(result.status, "not_created"); assert.equal(result.changeRequest, null); assert.equal(s.creator.state.creates, 0);
      assert.equal(s.creator.state.revoked, 1); assert.equal((await s.pullContext()).occupied, false);
      if (change === "existing") assert.equal(result.outcome.existing.length, 1);
    } finally { await s.close(); }
  }
});

test("pull creation keeps confirmed drifted or unreadable creations and records cleanup independently", async () => {
  for (const failure of ["drift", "read-cut", "revoke"]) {
    const s = await pullCreationScenario();
    try {
      if (failure === "drift") {
        const directory = path.join(s.directory, "original");
        await writeFile(path.join(directory, "independent.txt"), "Independent target change\n"); await git(directory, ["add", "."]); await git(directory, ["commit", "-m", "Target moves after authority"]);
        const next = await git(directory, ["rev-parse", "HEAD"]);
        s.creator.state.beforeCreate = async () => { await git(path.join(s.directory, "source.git"), ["-c", "protocol.file.allow=always", "fetch", directory, "main:main"]); assert.notEqual(next, s.input.head); };
      } else s.creator.state.fail = failure;
      await s.requestPull(); const result = await s.deliverPull();
      assert.equal(result.status, "created", JSON.stringify(result)); assert.equal(s.creator.state.creates, 1); assert.ok(result.changeRequest);
      assert.equal(result.outcome.revision, failure === "drift" ? "changed" : failure === "read-cut" ? "unavailable" : "matching");
      assert.equal(result.changeRequest.observations.length, failure === "read-cut" ? 1 : 2);
      assert.equal(result.credential.status, failure === "revoke" ? "revocation_unconfirmed" : "revoked");
      assert.equal((await s.pullContext()).occupied, false); assert.equal((await s.requestPull()).status, "created"); assert.equal(await s.deliverPull(), null);
    } finally { await s.close(); }
  }
});

test("pull creation treats documented rejection separately from unknown, preserving permanent head quarantine", async () => {
  for (const failure of ["validation", "create-forbidden", "create-cut"]) {
    const s = await pullCreationScenario(1, true);
    try {
      s.creator.state.fail = failure; await s.requestPull(); const result = await s.deliverPull();
      assert.equal(result.status, failure === "create-cut" ? "unknown" : "rejected");
      assert.equal(result.changeRequest, null); assert.equal(s.creator.state.creates, 1); assert.equal(s.creator.state.revoked, 1);
      assert.equal(await s.deliverPull(), null); assert.equal((await s.requestPull()).status, result.status);
      if (failure === "create-cut") {
        const competitor = s.competitor; assert.ok(competitor);
        const next = await s.anotherProposal();
        await assert.rejects(next.request(), /destination_busy/);
        await assert.rejects(confirmTaskPush(users[2], competitor.jobId, competitor.input), /destination_busy/);
        await assert.rejects(s.pullAction("retire", users[2]), /forbidden/);
        const key = randomUUID(); assert.equal((await s.pullAction("retire", users[0], key)).status, "retired");
        assert.equal((await s.pullAction("retire", users[0], key)).replayed, true);
        assert.equal((await s.pullContext()).occupied, true); await assert.rejects(next.request(), /destination_busy/);
        await assert.rejects(confirmTaskPush(users[2], competitor.jobId, competitor.input), /destination_busy/);
        assert.equal(s.creator.created.length, 1); assert.equal((await s.requestPull()).status, "retired");
      } else assert.equal((await s.pullContext()).occupied, false);
    } finally { await s.close(); }
  }
});

test("pull creation SQL permissions, pinned identity and independent evidence validation reject forged gates and receipts", async () => {
  const s = await pullCreationScenario(), db = await broker.connect();
  try {
    await s.requestPull();
    for (const sql of ["SELECT * FROM collab_git.head_reservations", "UPDATE collab_git.pull_deliveries SET status='created'", "SELECT * FROM collab_git.pull_changes",
      "SELECT * FROM collab_git.credentials"]) await assert.rejects(broker.query(sql), /permission/);
    await assert.rejects(asUser(users[1], c => c.query("SELECT collab_git.claim_pull_delivery()")), /permission/);
    const claim = (await db.query("SELECT collab_git.claim_pull_delivery() AS result")).rows[0].result;
    assert.equal(await s.deliverPull(), null);
    const begin = (connection: typeof db | typeof broker, nonce = claim.claimId, text = s.fixed.requestText) => connection.query("SELECT collab_git.begin_pull_delivery($1,$2,$3,$4)", [s.proposal.jobId, nonce, s.fixed.attempt, text]);
    await assert.rejects(begin(broker), /claim_lost/); await assert.rejects(begin(db, randomUUID()), /claim_lost/);
    await assert.rejects(begin(db, claim.claimId, "{}"), /invalid_task_pull_evidence/); await begin(db);
    const prepared = PreparedTaskPull.prepare(s.binding, s.fixed.attempt.intent);
    const receipt = await s.creator.client.execute(prepared, async value => {
      const gate = (evidence: unknown, hash: string, attempt = value.attempt) => db.query("SELECT collab_git.gate_pull_delivery($1,$2,$3,$4,$5)", [s.proposal.jobId, claim.claimId, attempt, JSON.stringify(evidence), hash]);
      await assert.rejects(gate(value.evidence, "0".repeat(64)), /invalid_task_pull_evidence/);
      await assert.rejects(gate(value.evidence, value.evidenceHash, { ...value.attempt, requestHash: "0".repeat(64) }), /invalid_task_pull_evidence/);
      for (const patch of [{ headSha: "f".repeat(40) }, { baseSha: "f".repeat(40) }, { verifiedAt: new Date(0).toISOString() }, { repository: { ...s.binding, visibility: "public" } }]) {
        const evidence = { ...value.evidence, ...patch }; await assert.rejects(gate(evidence, createHash("sha256").update(JSON.stringify(evidence)).digest("hex")), /invalid_task_pull_evidence/);
      }
      await gate(value.evidence, value.evidenceHash); return true;
    });
    assert.equal(receipt.outcome.status, "created"); if (receipt.outcome.status !== "created") throw new Error("Expected fixture create");
    for (const patch of [{ createStarted: false }, { evidence: {} }, { credential: { status: "not_requested", expiresAt: null } },
      { outcome: { ...receipt.outcome, pull: { ...receipt.outcome.pull, url: "https://untrusted.invalid/pull/17" } } },
      { outcome: { ...receipt.outcome, creation: { ...receipt.outcome.creation, headSha: "f".repeat(40) } } },
      { outcome: { ...receipt.outcome, current: null, revision: "matching" } }, { failure: "arbitrary credential-like text" }, { failure: true }]) {
      await assert.rejects(db.query("SELECT collab_git.finish_pull_delivery($1,$2,$3)", [s.proposal.jobId, claim.claimId, JSON.stringify({ ...receipt, ...patch })]), /invalid_task_pull_evidence/);
    }
    for (const field of ["id", "number"]) {
      const identity = { ...receipt.outcome.pull, [field]: field === "id" ? "9007199254740992" : 9007199254740992 };
      if (field === "number") identity.url = "https://github.com/" + s.binding.ownerLogin + "/" + s.binding.name + "/pull/9007199254740992";
      const forged = { ...receipt, outcome: { ...receipt.outcome, pull: identity, creation: { ...receipt.outcome.creation, identity }, current: { ...receipt.outcome.current, identity } } };
      await assert.rejects(db.query("SELECT collab_git.finish_pull_delivery($1,$2,$3)", [s.proposal.jobId, claim.claimId, JSON.stringify(forged)]), /invalid_task_pull_evidence/);
    }
    assert.equal((await db.query("SELECT collab_git.finish_pull_delivery($1,$2,$3) AS result", [s.proposal.jobId, claim.claimId, JSON.stringify(receipt)])).rows[0].result.status, "created");
    assert.equal(s.creator.state.creates, 1);
  } finally { db.release(true); await s.close(); }
});

test("pull creation dropped gate and settlement COMMIT replies never replay a POST", async () => {
  for (const phase of ["gate", "finish"]) {
    const s = await pullCreationScenario(), sockets = new Set<Socket>(); let armed = false, dropped = false;
    const proxy = createServer(client => {
      const upstream = createConnection({ host: "127.0.0.1", port: config.databasePort }); sockets.add(client); sockets.add(upstream); let final = false;
      client.on("data", chunk => { if (armed && Buffer.from(chunk).includes(Buffer.from("COMMIT"))) final = true; upstream.write(chunk); });
      upstream.on("data", chunk => { if (final && Buffer.from(chunk).includes(Buffer.from("COMMIT"))) { dropped = true; client.destroy(); upstream.destroy(); return; } client.write(chunk); });
      for (const socket of [client, upstream]) { socket.on("error", () => {}); socket.on("close", () => { sockets.delete(socket); client.destroy(); upstream.destroy(); }); }
    });
    await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
    const url = new URL(gitConnectionString(config, dbName)); url.port = String((proxy.address() as { port: number }).port);
    const through = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 5000, query_timeout: 5000 });
    try {
      await s.requestPull();
      await assert.rejects(s.deliverPull({ beforeGateCommit: async () => { if (phase === "gate") armed = true; }, beforeFinishCommit: async () => { if (phase === "finish") armed = true; } }, through), /outcome_unknown/);
      assert.equal(dropped, true); assert.equal(s.creator.state.creates, phase === "gate" ? 0 : 1);
      if (phase === "gate") assert.equal((await s.deliverPull()).status, "unknown"); else assert.equal(await s.deliverPull(), null);
      const context = await s.pullContext();
      assert.equal(context.delivery?.status, phase === "gate" ? "unknown" : "created"); assert.equal(context.occupied, phase === "gate");
      assert.equal((await s.requestPull()).replayed, true); assert.equal(await s.deliverPull(), null); assert.equal(s.creator.state.issued, 1);
      assert.equal(context.delivery?.changeRequest?.observations.length ?? 0, phase === "gate" ? 0 : 2);
    } finally { await through.end(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => proxy.close(() => resolve())); await s.close(); }
  }
});

test("pull creation SQL owner loss before or after its gate cannot transfer execution to a second owner", async () => {
  for (const phase of ["afterBegin", "afterGateCommit", "afterExecute"] as const) {
    const s = await pullCreationScenario(); let nonce = "";
    try {
      await s.requestPull();
      await assert.rejects(s.deliverPull({ [phase]: async (id: string) => {
        const row = (await admin.query("SELECT backend_pid,claim_id FROM collab_git.pull_deliveries WHERE id=$1", [id])).rows[0]; nonce = row.claim_id;
        await admin.query("SELECT pg_terminate_backend($1)", [row.backend_pid]); await new Promise(resolve => setTimeout(resolve, 30));
      } }), /outcome_unknown/);
      const result = await s.deliverPull(); assert.equal(result.status, phase === "afterBegin" ? "not_created" : "unknown");
      assert.equal(s.creator.state.creates, phase === "afterExecute" ? 1 : 0);
      await assert.rejects(broker.query("SELECT collab_git.fail_pull_delivery($1,$2,'late_callback')", [s.proposal.jobId, nonce]), /claim_lost/);
      assert.equal(await s.deliverPull(), null); assert.equal((await s.pullContext()).occupied, phase !== "afterBegin");
    } finally { await s.close(); }
  }
});

test("pull creation live authority bounds blocked provider reads and silent SQL without leaking a create", { timeout: 30000 }, async () => {
  for (const silent of [false, true]) {
    const s = await pullCreationScenario(), sockets = new Set<Socket>(); let armed = false, held = false, release!: () => void, reached!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; }), observing = new Promise<void>(resolve => { reached = resolve; });
    s.creator.state.afterList = async () => { reached(); await blocked; };
    const proxy = createServer(client => {
      const upstream = createConnection({ host: "127.0.0.1", port: config.databasePort }); sockets.add(client); sockets.add(upstream); let mute = false;
      client.on("data", chunk => { if (silent && armed && Buffer.from(chunk).includes(Buffer.from("pull_delivery_live"))) { mute = true; held = true; } upstream.write(chunk); });
      upstream.on("data", chunk => { if (!mute) client.write(chunk); });
      for (const socket of [client, upstream]) { socket.on("error", () => {}); socket.on("close", () => { sockets.delete(socket); client.destroy(); upstream.destroy(); }); }
    });
    await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
    const url = new URL(gitConnectionString(config, dbName)); url.port = String((proxy.address() as { port: number }).port);
    const through = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
    let running: ReturnType<typeof s.deliverPull> | undefined;
    try {
      await s.requestPull(); const began = Date.now();
      running = s.deliverPull({ afterBegin: async () => { armed = true; } }, through);
      const settled = running.then(value => ({ value }), error => ({ error }));
      await Promise.race([observing, settled.then(() => { throw new Error("Expected held provider read"); })]);
      if (!silent) await admin.query("UPDATE collab.project_memberships SET active=false WHERE project_id=$1 AND user_id=$2", [project, users[1]]);
      const result = await settled; assert.ok(Date.now() - began < 6000); assert.equal(s.creator.state.creates, 0); assert.equal(s.creator.state.revoked, 1);
      if (silent) { assert.equal(held, true); assert.ok("error" in result); assert.match(result.error.message, /outcome_unknown/); assert.equal((await s.deliverPull()).status, "not_created"); }
      else { assert.ok("value" in result); assert.equal(result.value.status, "not_created"); }
      assert.equal((await s.pullContext(users[2])).occupied, false);
    } finally {
      release(); await running?.catch(() => {}); await through.end(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => proxy.close(() => resolve()));
      await admin.query("UPDATE collab.project_memberships SET active=true WHERE project_id=$1 AND user_id=$2", [project, users[1]]); await s.close();
    }
  }
});

test("pull creation final authority holds task rows through commit; post-gate cancellation never erases acknowledged creation", async () => {
  for (const change of ["task", "cancel"]) {
    const s = await pullCreationScenario(); let mutation: Promise<unknown> | undefined, changed = false;
    try {
      await s.requestPull();
      const result = await s.deliverPull(change === "task" ? { beforeGateCommit: async () => {
        mutation = admin.query("UPDATE collab.tasks SET owner_id=$1,version=version+1 WHERE id=$2", [users[2], s.task.id]).then(() => { changed = true; });
        await new Promise(resolve => setTimeout(resolve, 150)); assert.equal(changed, false);
      } } : { afterGateCommit: async () => { assert.equal((await s.pullAction()).stopRequested, true); } });
      await mutation; assert.equal(result.status, "created"); assert.equal(s.creator.state.creates, 1);
      assert.ok((await s.pullContext(users[2])).delivery?.changeRequest); assert.equal((await s.pullContext(users[2])).occupied, false);
      if (change === "task") assert.equal(changed, true);
    } finally { await mutation; await s.close(); }
  }
});

test("pull creation may arrive after cancellation and token revocation; unknown retirement still permanently fences the head", async () => {
  const s = await pullCreationScenario(), controller = new AbortController();
  let reached!: () => void, release!: () => void, created!: () => void;
  const sending = new Promise<void>(resolve => { reached = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; }), applied = new Promise<void>(resolve => { created = resolve; });
  s.creator.state.beforeCreate = async () => { reached(); await blocked; };
  s.creator.state.afterCreate = async () => { created(); };
  let running: ReturnType<typeof s.deliverPull> | undefined;
  try {
    await s.requestPull(); running = s.deliverPull({ signal: controller.signal }); const settled = running.then(value => ({ value }), error => ({ error }));
    await Promise.race([sending, settled.then(() => { throw new Error("Expected a pending create POST"); })]);
    controller.abort(); const outcome = await settled; assert.ok("value" in outcome); assert.equal(outcome.value.status, "unknown");
    assert.equal(s.creator.state.revoked, 1); assert.equal(s.creator.created.length, 0);
    await s.pullAction("retire", users[0]); release(); await applied;
    assert.equal(s.creator.created.length, 1); assert.equal((await s.pullContext()).delivery?.status, "retired");
    assert.equal((await s.pullContext()).occupied, true); assert.equal((await s.pullContext()).delivery?.changeRequest, null);
    assert.equal(await s.deliverPull(), null); assert.equal(s.creator.state.creates, 1);
  } finally { release(); controller.abort(); await running?.catch(() => {}); await s.close(); }
});

test("pull creation actual broker SIGKILL before gate, after gate and after remote creation never replays", async () => {
  for (const phase of ["afterBegin", "afterGateCommit", "afterExecute"]) {
    const s = await pullCreationScenario(); let child: ReturnType<typeof spawn> | undefined;
    try {
      await s.requestPull(); const script = path.join(s.directory, "kill-pull.mts");
      const { pair } = await import("./fixtures/github");
      await writeFile(path.join(s.directory, "pull-master.key"), master, { mode: 0o600 });
      await writeFile(path.join(s.directory, "pull-app.pem"), pair.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
      await writeFile(path.join(s.directory, "pull-attempt.json"), JSON.stringify(s.fixed.attempt), { mode: 0o600 });
      const modulePath = (file: string) => JSON.stringify(pathToFileURL(path.resolve(file)).href);
      const source = [
        "import pg from " + modulePath("node_modules/pg/lib/index.js") + ";",
        "import {readFile,writeFile} from 'node:fs/promises'; import {createPrivateKey,createPublicKey} from 'node:crypto';",
        "import {processTaskPullDelivery} from " + modulePath("lib/collab/git/pull-delivery-broker.ts") + ";",
        "import {githubPullFixture} from " + modulePath("tests/collab/fixtures/github-pull.ts") + ";",
        "import {config} from " + modulePath("tests/collab/fixtures/github.ts") + ";",
        "const root=process.env.TEST_PULL_ROOT, privateKey=createPrivateKey(await readFile(root+'/pull-app.pem'));",
        "const fixture=await githubPullFixture(root,JSON.parse(await readFile(root+'/pull-attempt.json','utf8')),'create',{privateKey,publicKey:createPublicKey(privateKey)},config);",
        "const pool=new pg.Pool({connectionString:process.env.TEST_PULL_SQL});",
        "await processTaskPullDelivery(pool,()=>readFile(root+'/pull-master.key'),{transport:fixture.transport,[process.env.TEST_PULL_PHASE]:async(id)=>{",
        "await writeFile(root+'/pull-checkpoint.json',JSON.stringify({creates:fixture.state.creates}),{mode:0o600});process.send({id});await new Promise(()=>{});}});",
      ].join("\n");
      await writeFile(script, source, { mode: 0o600 });
      child = spawn(process.execPath, ["--import", "tsx", script], { env: { ...process.env, TEST_PULL_ROOT: s.directory, TEST_PULL_SQL: gitConnectionString(config, dbName), TEST_PULL_PHASE: phase }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
      const [message] = await once(child, "message", { signal: AbortSignal.timeout(30000) }); assert.equal(message.id, s.proposal.jobId);
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
      assert.equal(JSON.parse(await readFile(path.join(s.directory, "pull-checkpoint.json"), "utf8")).creates, phase === "afterExecute" ? 1 : 0);
      const result = await s.deliverPull(); assert.equal(result.status, phase === "afterBegin" ? "not_created" : "unknown");
      assert.equal(await s.deliverPull(), null); assert.equal(s.creator.state.issued, 0); assert.equal(s.creator.state.creates, 0);
      assert.equal((await s.pullContext()).occupied, phase !== "afterBegin");
    } finally {
      if (child?.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
      await s.close();
    }
  }
});

test("pull creation migration preserves legacy reserved and quarantined push heads during upgrade", async () => {
  const reserved = await confirmationScenario(), confirmation = await reserved.confirm();
  const unknown = await deliveryScenario(), db = await admin.connect();
  try {
    const send = await unknown.send(); unknown.writer.git.state.loseReply = true;
    assert.equal((await unknown.deliver()).status, "unknown"); await unknown.action(send.jobId, "retire", users[0]);
    const sql = await readFile(path.resolve("db/migrations/031-task-pull-deliveries.sql"), "utf8");
    const functions = [...sql.matchAll(/CREATE FUNCTION ((?:collab|collab_git)\.[a-z_]+)\(/g)].map(match => match[1]);
    // Reconstruct the preceding schema boundary transactionally, retaining real
    // older push rows. ROLLBACK restores all current PR records after the check.
    await db.query("BEGIN");
    await db.query("DROP TRIGGER shared_push_head ON collab_git.push_confirmations");
    await db.query("DROP TABLE collab_git.pull_change_observations,collab_git.pull_changes,collab_git.head_reservations,collab_git.pull_delivery_actions,collab_git.pull_deliveries CASCADE");
    const existing = (await db.query("SELECT n.nspname||'.'||p.proname AS name,pg_get_function_identity_arguments(p.oid) AS args FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname||'.'||p.proname=ANY($1)", [functions])).rows;
    for (const item of existing) await db.query("DROP FUNCTION IF EXISTS " + item.name + "(" + item.args + ") CASCADE");
    await db.query(sql);
    const rows = (await db.query("SELECT push_confirmation_id,quarantined FROM collab_git.head_reservations WHERE push_confirmation_id=ANY($1) ORDER BY quarantined", [[confirmation.id, unknown.confirmation.id]])).rows;
    assert.deepEqual(rows, [{ push_confirmation_id: confirmation.id, quarantined: false }, { push_confirmation_id: unknown.confirmation.id, quarantined: true }]);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM collab_git.push_confirmations p LEFT JOIN collab_git.head_reservations h ON h.push_confirmation_id=p.id WHERE p.status IN ('reserved','quarantined') AND h.push_confirmation_id IS NULL")).rows[0].n, 0);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM collab_git.head_reservations h JOIN collab_git.push_confirmations p ON p.id=h.push_confirmation_id WHERE p.status NOT IN ('reserved','quarantined')")).rows[0].n, 0);
    await db.query("ROLLBACK"); await reserved.withdraw(confirmation.id);
  } finally { await db.query("ROLLBACK").catch(() => {}); db.release(); await unknown.close(); await reserved.close(); }
});

test("pull proposal concurrent admission and pinned readers persist one SQL-verified exact draft without creation", async () => {
  const s = await pullProposalScenario();
  try {
    const replies = await Promise.all([s.propose(), s.propose(), s.propose()]), id = replies[0].jobId;
    assert.equal(new Set(replies.map(r => r.jobId)).size, 1); assert.equal(replies.filter(r => !r.replayed).length, 1);
    assert.equal(s.api.state.issued, 0);
    const workers = await Promise.all([s.processProposal(), s.processProposal()]); assert.equal(workers.filter(Boolean).length, 1);
    const result = workers.find(Boolean); assert.equal(result.status, "ready"); assert.equal(result.valid, true);
    assert.equal(s.api.state.issued, 1); assert.equal(s.api.state.revoked, 1); assert.equal(s.api.state.creates, 0);
    assert.equal(result.attempt.intent.operationId, id); assert.equal(result.attempt.intent.deliveryId, s.delivery.jobId);
    assert.deepEqual(JSON.parse(result.requestText), result.attempt.request);
    assert.equal(createHash("sha256").update(result.requestText).digest("hex"), result.attempt.requestHash);
    assert.equal(Buffer.byteLength(result.requestText), result.attempt.requestBytes);
    assert.deepEqual(result.attempt, PreparedTaskPull.prepare(s.binding, result.attempt.intent).attempt);
    const stored = await s.proposalRow(id);
    assert.equal(stored.observation_hash, createHash("sha256").update(result.observationText).digest("hex"));
    assert.deepEqual(JSON.parse(result.observationText), stored.observation);
    assert.equal((await s.proposalContext(users[3])).proposals[0].jobId, id);
    assert.equal((await s.propose()).replayed, true); assert.equal(await s.processProposal(), null); assert.equal(s.api.state.issued, 1);
    assert.equal(await readFile(path.join(s.checkout, "code.txt"), "utf8"), "remaining draft\n");
  } finally { await s.close(); }
});

test("pull proposal roles, MFA, exact retry payload and current task version are required before credential access", async () => {
  const s = await pullProposalScenario();
  try {
    await assert.rejects(s.propose(users[3]), /forbidden/); await assert.rejects(s.propose(users[4]), /not_found/);
    await assert.rejects(s.proposalContext(users[4]), /not_found/);
    await admin.query('UPDATE public."user" SET "twoFactorEnabled"=false WHERE id=$1', [users[2]]);
    await admin.query("UPDATE collab.memberships SET role='admin' WHERE organization_id=$1 AND user_id=$2", [organization, users[2]]);
    await assert.rejects(s.propose(users[2]), /forbidden/);
    await assert.rejects(s.propose(users[1], { ...s.proposalInput, expectedTaskVersion: s.proposalInput.expectedTaskVersion + 1 }), /stale_revision/);
    const job = await s.propose();
    await assert.rejects(s.propose(users[1], { ...s.proposalInput, body: "Different reviewed instructions" }), /idempotency_conflict/);
    await assert.rejects(s.propose(users[1], { ...s.proposalInput, idempotencyKey: randomUUID() }), /proposal_busy/);
    assert.equal(s.api.state.issued, 0); await s.cancelProposal(job.jobId); assert.equal((await s.processProposal()).status, "cancelled");
  } finally {
    await admin.query("UPDATE collab.memberships SET role='member' WHERE organization_id=$1 AND user_id=$2", [organization, users[2]]);
    await admin.query('UPDATE public."user" SET "twoFactorEnabled"=true WHERE id=$1', [users[2]]); await s.close();
  }
});

test("pull proposal cannot use an unacknowledged, unknown or retired delivery even when the remote has its exact SHA", async () => {
  const s = await deliveryScenario();
  try {
    const delivery = await s.send(), version = (await taskPullProposalContext(users[1], delivery.jobId)).taskVersion;
    const input = { idempotencyKey: randomUUID(), expectedTaskVersion: version, title: "Not attributable", body: "Unknown must remain unknown" };
    await assert.rejects(requestTaskPullProposal(users[1], delivery.jobId, input), /source_unavailable/);
    s.writer.git.state.loseReply = true; assert.equal((await s.deliver()).status, "unknown");
    assert.equal(await git(path.join(s.directory, "source.git"), ["rev-parse", s.ref]), s.input.head);
    await assert.rejects(requestTaskPullProposal(users[1], delivery.jobId, input), /source_unavailable/);
    await s.action(delivery.jobId, "retire", users[0]);
    await assert.rejects(requestTaskPullProposal(users[1], delivery.jobId, input), /source_unavailable/);
    assert.equal((await taskPullProposalContext(users[3], delivery.jobId)).canRequest, false);
  } finally { await s.close(); }
});

test("pull proposal observes a new base without repushing or consulting changed source files; existing PRs are never adopted", async () => {
  for (const existing of [false, true]) {
    const s = await pullProposalScenario();
    try {
      const original = path.join(s.directory, "original");
      await writeFile(path.join(original, "upstream.txt"), "independent upstream commit\n"); await git(original, ["add", "."]); await git(original, ["commit", "-m", "Later baseline"]);
      const nextBase = await git(original, ["rev-parse", "HEAD"]);
      await git(path.join(s.directory, "source.git"), ["-c", "protocol.file.allow=always", "fetch", original, "main:main"]);
      await writeFile(path.join(s.checkout, "code.txt"), "new local draft that must not enter this PR\n");
      s.api.state.existing = existing;
      const job = await s.propose(), result = await s.processProposal();
      assert.equal(result.status, existing ? "existing" : "ready"); assert.equal(result.valid, !existing);
      assert.equal(result.attempt.intent.baseSha, nextBase); assert.equal(result.attempt.intent.headSha, s.input.head);
      assert.equal(result.observation.existing.length, existing ? 1 : 0);
      assert.equal(s.writer.git.calls.receive, 1); assert.equal(s.api.state.creates, 0);
      assert.equal((await s.proposalRow(job.jobId)).observation.tokenRevoked, true);
      assert.equal(await readFile(path.join(s.checkout, "code.txt"), "utf8"), "new local draft that must not enter this PR\n");
    } finally { await s.close(); }
  }
});

test("pull proposal queued and post-read cancellation never publishes a usable draft and original retries remain terminal", async () => {
  for (const queued of [true, false]) {
    const s = await pullProposalScenario();
    try {
      const job = await s.propose();
      if (queued) await s.cancelProposal(job.jobId);
      const result = await s.processProposal(queued ? {} : { beforeFinish: async id => { await s.cancelProposal(id); } });
      assert.equal(result.status, "cancelled"); assert.equal(result.attempt, null);
      assert.equal(s.api.state.issued, queued ? 0 : 1); assert.equal(s.api.state.revoked, queued ? 0 : 1);
      assert.equal((await s.propose()).replayed, true); assert.equal((await s.propose()).status, "cancelled");
      assert.equal(await s.processProposal(), null); assert.equal(s.api.state.creates, 0);
    } finally { await s.close(); }
  }
});

test("pull proposal revoke and regrant, task changes and installation/binding changes invalidate final publication", async () => {
  for (const change of ["membership", "task", "binding", "installation"]) {
    const s = await pullProposalScenario();
    try {
      await s.propose();
      const result = await s.processProposal({ beforeFinish: async () => {
        if (change === "membership") await admin.query("UPDATE collab.project_memberships SET authorization_version=authorization_version+2 WHERE project_id=$1 AND user_id=$2", [project, users[1]]);
        else if (change === "task") await admin.query("UPDATE collab.tasks SET version=version+1 WHERE id=$1", [s.task.id]);
        else if (change === "binding") await admin.query("UPDATE collab.github_bindings SET verified_at=now() WHERE repository_id=$1", [s.imported.id]);
        else await admin.query("UPDATE collab.github_installations SET enabled=false WHERE id=$1", [connectionId]);
      } });
      assert.equal(result.status, "failed"); assert.match(result.failure, /authority_changed/); assert.equal(result.attempt, null);
      assert.equal(s.api.state.revoked, 1); assert.equal(s.api.state.creates, 0);
    } finally { await admin.query("UPDATE collab.github_installations SET enabled=true WHERE id=$1", [connectionId]); await s.close(); }
  }
});

test("pull proposal SQL independently checks target, reviewed content, request hash and fresh cleaned-up evidence", async () => {
  for (const mutation of ["target", "body", "hash", "cleanup", "stale"]) {
    const s = await pullProposalScenario();
    try {
      await s.propose();
      const result = await s.processProposal({ beforeFinish: async (_id, evidence, attempt) => {
        if (mutation === "target") evidence.target.headSha = s.imported.baseSha;
        if (mutation === "body") { attempt.request.body += "changed after human input"; attempt.requestHash = createHash("sha256").update(JSON.stringify(attempt.request)).digest("hex"); attempt.requestBytes = Buffer.byteLength(JSON.stringify(attempt.request)); }
        if (mutation === "hash") attempt.requestHash = "f".repeat(64);
        if (mutation === "cleanup") Object.assign(evidence, { tokenRevoked: false });
        if (mutation === "stale") evidence.target.verifiedAt = new Date(0).toISOString();
      } });
      assert.equal(result.status, "failed"); assert.equal(result.failure, "invalid_task_pull_evidence"); assert.equal(result.attempt, null);
      assert.equal(s.api.state.creates, 0); assert.equal(s.api.state.revoked, 1);
    } finally { await s.close(); }
  }
});

test("pull proposal SQL grants and pinned connection exclude forged callbacks and later workers", async () => {
  const s = await pullProposalScenario(), db = await broker.connect();
  try {
    const job = await s.propose();
    for (const sql of ["SELECT * FROM collab_git.pull_proposals", "UPDATE collab_git.pull_proposals SET status='ready'", "SELECT * FROM collab_git.credentials"])
      await assert.rejects(broker.query(sql), /permission/);
    await assert.rejects(asUser(users[1], c => c.query("SELECT collab_git.claim_pull_proposal()")), /permission/);
    const claim = (await db.query("SELECT collab_git.claim_pull_proposal() AS result")).rows[0].result;
    assert.equal(claim.jobId, job.jobId); assert.equal(await s.processProposal(), null);
    await assert.rejects(broker.query("SELECT collab_git.begin_pull_proposal($1,$2)", [job.jobId, claim.claimId]), /claim_lost/);
    await assert.rejects(db.query("SELECT collab_git.begin_pull_proposal($1,$2)", [job.jobId, randomUUID()]), /claim_lost/);
    await db.query("SELECT collab_git.begin_pull_proposal($1,$2)", [job.jobId, claim.claimId]);
    await assert.rejects(db.query("SELECT collab_git.begin_pull_proposal($1,$2)", [job.jobId, claim.claimId]), /authority_changed/);
    await db.query("SELECT collab_git.fail_pull_proposal($1,$2,'test_completed')", [job.jobId, claim.claimId]);
    assert.equal(s.api.state.issued, 0);
  } finally { db.release(true); await s.close(); }
});

test("pull proposal owner loss after a completed read fails once and never replays the provider call", async () => {
  const s = await pullProposalScenario();
  try {
    const job = await s.propose(); let nonce = "";
    await assert.rejects(s.processProposal({ beforeFinish: async id => {
      const row = await s.proposalRow(id); nonce = row.claim_id;
      await admin.query("SELECT pg_terminate_backend($1)", [row.backend_pid]); await new Promise(resolve => setTimeout(resolve, 30));
    } }), /outcome_unknown/);
    assert.equal(s.api.state.revoked, 1);
    const recovered = await s.processProposal(); assert.equal(recovered.status, "failed"); assert.equal(recovered.failure, "task_pull_proposal_reader_lost");
    await assert.rejects(broker.query("SELECT collab_git.fail_pull_proposal($1,$2,'late_callback')", [job.jobId, nonce]), /claim_lost/);
    assert.equal((await s.propose()).replayed, true); assert.equal(await s.processProposal(), null); assert.equal(s.api.state.issued, 1);
  } finally { await s.close(); }
});

test("pull proposal publication holds task ownership until the exact evidence commits, then displays stale local authority", async () => {
  const s = await pullProposalScenario(); let changed = false, mutation: Promise<unknown> | undefined;
  try {
    await s.propose();
    const result = await s.processProposal({ beforeCommit: async () => {
      mutation = admin.query("UPDATE collab.tasks SET owner_id=$1,version=version+1 WHERE id=$2", [users[2], s.task.id]).then(() => { changed = true; });
      await new Promise(resolve => setTimeout(resolve, 150)); assert.equal(changed, false);
    } });
    assert.equal(result.status, "ready"); await mutation; assert.equal(changed, true);
    const context = await s.proposalContext(users[3]); assert.equal(context.proposals[0].valid, false);
    assert.equal(context.proposals[0].requestText, result.requestText);
  } finally { await mutation; await s.close(); }
});

test("pull proposal live authority ends a blocked provider read after revocation or a silent SQL connection", { timeout: 30000 }, async () => {
  for (const silent of [false, true]) {
    const s = await pullProposalScenario(), sockets = new Set<Socket>(); let held = false, release!: () => void, reached!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; }), observing = new Promise<void>(resolve => { reached = resolve; });
    s.api.state.afterList = async () => { reached(); await blocked; };
    const proxy = createServer(client => {
      const upstream = createConnection({ host: "127.0.0.1", port: config.databasePort }); sockets.add(client); sockets.add(upstream); let mute = false;
      client.on("data", chunk => { if (silent && Buffer.from(chunk).includes(Buffer.from("pull_proposal_live"))) { mute = true; held = true; } upstream.write(chunk); });
      upstream.on("data", chunk => { if (!mute) client.write(chunk); });
      for (const socket of [client, upstream]) { socket.on("error", () => {}); socket.on("close", () => { sockets.delete(socket); client.destroy(); upstream.destroy(); }); }
    });
    await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
    const url = new URL(gitConnectionString(config, dbName)); url.port = String((proxy.address() as { port: number }).port);
    const through = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
    let running: ReturnType<typeof s.processProposal> | undefined;
    try {
      const job = await s.propose(), began = Date.now();
      running = s.processProposal({}, through);
      // Observe failures immediately while the provider is intentionally held.
      const settled = running.then(value => ({ value }), error => ({ error }));
      await Promise.race([observing, settled.then(() => { throw new Error("Expected the proposal provider to pause before completion"); })]);
      if (!silent) await admin.query("UPDATE collab.project_memberships SET active=false WHERE project_id=$1 AND user_id=$2", [project, users[1]]);
      const result = await settled;
      assert.ok(Date.now() - began < 6000); assert.equal(s.api.state.revoked, 1); assert.equal(s.api.state.creates, 0);
      if (silent) { assert.equal(held, true); assert.ok("error" in result); assert.match(result.error.message, /outcome_unknown/); assert.equal((await s.processProposal()).status, "failed"); }
      else { assert.ok("value" in result); assert.equal(result.value.status, "failed"); assert.match(result.value.failure, /authority_changed/); }
      assert.equal((await s.proposalRow(job.jobId)).attempt, null); assert.equal(s.api.state.issued, 1);
    } finally {
      release(); await running?.catch(() => {}); await through.end(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => proxy.close(() => resolve()));
      await admin.query("UPDATE collab.project_memberships SET active=true WHERE project_id=$1 AND user_id=$2", [project, users[1]]); await s.close();
    }
  }
});

test("pull proposal dropped COMMIT acknowledgement recovers the ready record without a second token", async () => {
  const s = await pullProposalScenario(), sockets = new Set<Socket>(); let armed = false, dropped = false;
  const proxy = createServer(client => {
    const upstream = createConnection({ host: "127.0.0.1", port: config.databasePort }); sockets.add(client); sockets.add(upstream); let final = false;
    client.on("data", chunk => { if (armed && Buffer.from(chunk).includes(Buffer.from("COMMIT"))) final = true; upstream.write(chunk); });
    upstream.on("data", chunk => { if (final && Buffer.from(chunk).includes(Buffer.from("COMMIT"))) { dropped = true; client.destroy(); upstream.destroy(); return; } client.write(chunk); });
    for (const socket of [client, upstream]) { socket.on("error", () => {}); socket.on("close", () => { sockets.delete(socket); client.destroy(); upstream.destroy(); }); }
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const url = new URL(gitConnectionString(config, dbName)); url.port = String((proxy.address() as { port: number }).port);
  const through = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 5000, query_timeout: 5000 });
  try {
    const job = await s.propose();
    await assert.rejects(s.processProposal({ beforeCommit: async () => { armed = true; } }, through), /outcome_unknown/);
    assert.equal(dropped, true); assert.equal((await s.proposalRow(job.jobId)).status, "ready");
    assert.equal((await s.propose()).status, "ready"); assert.equal(await s.processProposal(), null);
    assert.equal(s.api.state.issued, 1); assert.equal(s.api.state.revoked, 1); assert.equal(s.api.state.creates, 0);
  } finally { await through.end(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => proxy.close(() => resolve())); await s.close(); }
});

test("delivery explicitly admits once, concurrently sends exact immutable history once and persists Git acknowledgement separately from cleanup", async () => {
  const s = await deliveryScenario();
  try {
    assert.equal(await s.deliver(), null); assert.equal(s.writer.state.issued, 0);
    const requests = await Promise.all([s.send(), s.send(), s.send()]), id = requests[0].jobId;
    assert.equal(new Set(requests.map(r => r.jobId)).size, 1); assert.equal(requests.filter(r => !r.replayed).length, 1);
    assert.equal(s.writer.state.issued, 0); await assert.rejects(s.withdraw(s.confirmation.id), /task_push_delivery_owned/);
    await assert.rejects(s.send(users[1], { ...s.sendInput, manifestHash: "0".repeat(64) }), /idempotency_conflict/);
    await assert.rejects(s.send(users[2], { ...s.sendInput, idempotencyKey: randomUUID() }), /task_push_delivery_exists/);
    s.writer.state.fail = "revoke";
    const replies = await Promise.all([s.deliver(), s.deliver()]); assert.equal(replies.filter(Boolean).length, 1);
    const result = replies.find(Boolean); assert.equal(result.status, "acknowledged"); assert.equal(result.credential.status, "revocation_unconfirmed");
    assert.equal(s.writer.git.calls.receive, 1); assert.equal(s.writer.state.issued, 1);
    assert.equal(await git(path.join(s.directory, "source.git"), ["rev-parse", s.ref]), s.input.head);
    assert.equal(await readFile(path.join(s.checkout, "code.txt"), "utf8"), "remaining draft\n");
    const stored = await s.deliveryRow(id); assert.equal(stored.gate_attempt.requestHash, createHash("sha256").update(s.writer.git.requests[0]).digest("hex"));
    assert.equal(s.writer.containsCredential(stored), false); assert.equal((await s.context()).occupied, false);
    assert.equal((await s.context(users[3])).confirmations[0].delivery?.status, "acknowledged");
    assert.equal((await s.send()).replayed, true); assert.equal(await s.deliver(), null); assert.equal(s.writer.state.issued, 1);
    await assert.rejects(s.send(users[1], { ...s.sendInput, idempotencyKey: randomUUID() }), /task_push_delivery_exists/);
  } finally { await s.close(); }
});

test("delivery admission enforces roles, exact SQL payloads and cancellation before preparation avoids credentials", async () => {
  const s = await deliveryScenario();
  try {
    await assert.rejects(s.send(users[3]), /forbidden/); await assert.rejects(s.send(users[4]), /not_found/);
    for (const payload of [{}, { manifestHash: s.sendInput.manifestHash, acknowledgePush: false }, { manifestHash: s.sendInput.manifestHash, acknowledgePush: true, ref: "refs/heads/main" }])
      await assert.rejects(asUser(users[1], db => db.query("SELECT collab.request_task_push_delivery($1,$2,$3)", [s.confirmation.id, randomUUID(), payload])), /invalid_task_push_delivery/);
    const job = await s.send(), key = randomUUID(); await assert.rejects(s.action(job.jobId, "cancel", users[3]), /forbidden/);
    assert.equal((await s.action(job.jobId, "cancel", users[1], key)).stopRequested, true); assert.equal((await s.action(job.jobId, "cancel", users[1], key)).replayed, true);
    const result = await s.deliver(); assert.equal(result.status, "not_sent"); assert.equal(s.writer.state.issued, 0); assert.equal(s.writer.git.calls.receive, 0);
    assert.equal((await s.context()).occupied, false);
  } finally { await s.close(); }
});

test("delivery rechecks BOTH original human grants; revoke and regrant never renew the queued job", async () => {
  for (const actor of [1, 2]) {
    const s = await deliveryScenario(2, 1);
    try {
      const job = await s.send();
      await admin.query("UPDATE collab.project_memberships SET active=false WHERE project_id=$1 AND user_id=$2", [project, users[actor]]);
      await admin.query("UPDATE collab.project_memberships SET active=true WHERE project_id=$1 AND user_id=$2", [project, users[actor]]);
      assert.equal((await s.deliver()).status, "not_sent"); assert.equal(s.writer.state.issued, 0); assert.equal(s.writer.git.calls.receive, 0);
      assert.equal((await s.send()).jobId, job.jobId);
    } finally { await admin.query("UPDATE collab.project_memberships SET active=true WHERE project_id=$1 AND user_id=$2", [project, users[actor]]); await s.close(); }
  }
});

test("corrupt immutable export never opens credentials; late authority changes and changed provider evidence never send", async () => {
  for (const change of ["export", "permission", "rules", "baseline", "cancel"]) {
    const s = await deliveryScenario();
    try {
      const job = await s.send();
      if (change === "export") await rm(path.join(s.directory, "task-push-exports", s.job.jobId), { recursive: true });
      s.writer.state.afterAdvertise = async () => {
        if (change === "permission") await admin.query("UPDATE collab.project_memberships SET active=false WHERE project_id=$1 AND user_id=$2", [project, users[1]]);
        if (change === "rules") s.writer.state.rules = [{ type: "required_signatures" }];
        if (change === "cancel") await s.action(job.jobId);
      };
      // A different baseline commit is installed without altering the task export.
      if (change === "baseline") s.writer.state.afterAdvertise = async () => {
        const original = path.join(s.directory, "original"); await writeFile(path.join(original, "later.txt"), "later baseline\n"); await git(original, ["add", "."]); await git(original, ["commit", "-m", "Later baseline"]);
        await git(path.join(s.directory, "source.git"), ["-c", "protocol.file.allow=always", "fetch", original, "main:main"]);
      };
      assert.equal((await s.deliver()).status, "not_sent"); assert.equal(s.writer.git.calls.receive, 0);
      assert.equal(s.writer.state.issued, change === "export" ? 0 : 1); assert.equal(s.writer.state.revoked, change === "export" ? 0 : 1);
    } finally { await admin.query("UPDATE collab.project_memberships SET active=true WHERE project_id=$1 AND user_id=$2", [project, users[1]]); await s.close(); }
  }
});

test("unknown delivery retains destination; withdrawal/replay cannot clear it and only an MFA org admin maintainer can permanently quarantine it", async () => {
  const s = await deliveryScenario();
  try {
    const job = await s.send(); s.writer.git.state.loseReply = true;
    assert.equal((await s.deliver()).status, "unknown"); assert.equal(await git(path.join(s.directory, "source.git"), ["rev-parse", s.ref]), s.input.head);
    assert.equal((await s.context()).occupied, true); await assert.rejects(s.withdraw(s.confirmation.id, users[0]), /task_push_delivery_owned/);
    await assert.rejects(s.action(job.jobId, "retire", users[1]), /forbidden/); await assert.rejects(s.action(job.jobId, "retire", users[2]), /forbidden/);
    // Organizational owner MFA cannot be removed while privileged.
    await assert.rejects(admin.query('UPDATE public."user" SET "twoFactorEnabled"=false WHERE id=$1', [users[0]]), /mfa_required/);
    const key = randomUUID(); assert.equal((await s.action(job.jobId, "retire", users[0], key)).status, "retired"); assert.equal((await s.action(job.jobId, "retire", users[0], key)).replayed, true);
    const context = await s.context(); assert.equal(context.occupied, true); assert.equal(context.confirmations[0].status, "quarantined");
    await assert.rejects(s.withdraw(s.confirmation.id, users[0]), /task_push_delivery_owned/);
    await assert.rejects(s.confirm(users[2], { ...s.confirmationInput, idempotencyKey: randomUUID() }), /task_push_destination_busy/);
    assert.equal((await s.send()).status, "retired"); assert.equal(await s.deliver(), null); assert.equal(s.writer.git.calls.receive, 1);
  } finally { await admin.query('UPDATE public."user" SET "twoFactorEnabled"=true WHERE id=$1', [users[0]]); await s.close(); }
});

test("SQL owner loss before gate never sends, after actual receive remains unknown and recovery never retries", async () => {
  for (const stage of ["preparation", "gate", "received"]) {
    const s = await deliveryScenario();
    try {
      const job = await s.send();
      await assert.rejects(s.deliver(stage === "preparation" ? { afterBegin: s.disconnectDelivery } : stage === "gate" ? { afterGateCommit: s.disconnectDelivery } : { afterExecute: s.disconnectDelivery }), /task_push_outcome_unknown/);
      const recovered = await s.deliver(); assert.equal(recovered.status, stage === "preparation" ? "not_sent" : "unknown");
      assert.equal(s.writer.git.calls.receive, stage === "received" ? 1 : 0); assert.equal(await s.deliver(), null);
      assert.equal((await s.send()).jobId, job.jobId);
    } finally { await s.close(); }
  }
});

test("delivery SQL restricts roles and pinned nonce, validates prepared intent and refuses malformed receipts before any gate", async () => {
  const s = await deliveryScenario(), db = await broker.connect();
  try {
    const job = await s.send();
    for (const sql of ["SELECT * FROM collab_git.push_deliveries", "SELECT collab_git.push_delivery_result($1)"])
      await assert.rejects(broker.query(sql, sql.includes("$1") ? [job.jobId] : undefined), /permission/);
    await assert.rejects(asUser(users[1], c => c.query("SELECT collab_git.claim_task_push_delivery()")), /permission/);
    const claim = (await db.query("SELECT collab_git.claim_task_push_delivery() AS result")).rows[0].result;
    assert.equal(claim.jobId, job.jobId); const prepared = await prepareExportedTaskPush(s.directory, s.job.jobId, s.sendInput.manifestHash);
    await assert.rejects(broker.query("SELECT collab_git.begin_task_push_delivery($1,$2,$3)", [job.jobId, claim.claimId, prepared.attempt]), /task_push_claim_lost/);
    for (const patch of [{ ref: "refs/heads/main" }, { newSha: s.imported.baseSha }, { requestHash: "x" }, { requestBytes: 0 }, { extra: true }])
      await assert.rejects(db.query("SELECT collab_git.begin_task_push_delivery($1,$2,$3)", [job.jobId, claim.claimId, { ...prepared.attempt, ...patch }]), /invalid_task_push_evidence/);
    await db.query("SELECT collab_git.begin_task_push_delivery($1,$2,$3)", [job.jobId, claim.claimId, prepared.attempt]);
    for (const receipt of [null, {}, { outcome: { status: "unknown", reason: "response_unconfirmed" }, receiveStarted: false, evidence: null, failure: null, credential: { status: "revoked", expiresAt: null } },
      { outcome: null, receiveStarted: false, evidence: null, failure: null, credential: { status: "not_requested" } }])
      await assert.rejects(db.query("SELECT collab_git.finish_task_push_delivery($1,$2,$3)", [job.jobId, claim.claimId, receipt]), /invalid_task_push_evidence/);
    assert.equal((await db.query("SELECT collab_git.fail_task_push_delivery($1,$2,'task_push_test_complete') AS result", [job.jobId, claim.claimId])).rows[0].result.status, "not_sent");
  } finally { db.release(true); await s.close(); }
});

test("actual dropped gate COMMIT acknowledgement never sends; dropped settlement acknowledgement returns the original result without replay", async () => {
  for (const phase of ["gate", "finish"]) {
    const s = await deliveryScenario(), sockets = new Set<Socket>(); let dropped = false;
    const proxy = createServer(client => {
      const upstream = createConnection({ host: "127.0.0.1", port: config.databasePort }); sockets.add(client); sockets.add(upstream); let recording = false, final = false;
      client.on("data", chunk => { if (Buffer.from(chunk).includes(Buffer.from(`SELECT collab_git.${phase}_task_push_delivery(`))) recording = true; if (recording && Buffer.from(chunk).includes(Buffer.from("COMMIT"))) final = true; upstream.write(chunk); });
      upstream.on("data", chunk => { if (final && Buffer.from(chunk).includes(Buffer.from("COMMIT"))) { dropped = true; client.destroy(); upstream.destroy(); return; } client.write(chunk); });
      for (const socket of [client, upstream]) { socket.on("error", () => {}); socket.on("close", () => { sockets.delete(socket); client.destroy(); upstream.destroy(); }); }
    });
    await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
    const url = new URL(gitConnectionString(config, dbName)); url.port = String((proxy.address() as { port: number }).port);
    const through = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 5000, query_timeout: 5000 });
    try {
      await s.send(); await assert.rejects(s.deliver({}, through), /task_push_outcome_unknown/); assert.equal(dropped, true);
      const recovery = await s.deliver(); if (phase === "gate") assert.equal(recovery.status, "unknown"); else assert.equal(recovery, null);
      assert.equal(s.writer.git.calls.receive, phase === "gate" ? 0 : 1); assert.equal(s.writer.state.issued, 1); assert.equal(s.writer.state.revoked, 1);
      assert.equal((await s.send()).status, phase === "gate" ? "unknown" : "acknowledged"); assert.equal(await s.deliver(), null);
    } finally { await through.end(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => proxy.close(() => resolve())); await s.close(); }
  }
});

test("cancellation after gate cannot undo Git, and old-SHA observation plus token revocation cannot release a delayed unknown receive", async () => {
  const s = await deliveryScenario(), abort = new AbortController();
  let reached!: () => void, release!: () => void, finished!: () => void;
  const received = new Promise<void>(resolve => { reached = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; }), applied = new Promise<void>(resolve => { finished = resolve; });
  let running: Promise<unknown> | undefined;
  try {
    const job = await s.send(); s.writer.git.state.beforeReceive = async () => { reached(); await barrier; }; s.writer.git.state.afterReceive = finished;
    running = s.deliver({ signal: abort.signal }); await received;
    const cancel = await s.action(job.jobId); assert.equal(cancel.stopRequested, true); assert.ok(cancel.gateAt);
    abort.abort(); const result = await running; assert.equal((result as { status: string }).status, "unknown"); assert.equal(s.writer.state.revoked, 1);
    assert.equal((await managedGit(path.join(s.directory, "source.git"), ["rev-parse", "--verify", s.ref], AbortSignal.timeout(10000), { codes: [0, 128] })).code, 128);
    await s.action(job.jobId, "retire", users[0]); assert.equal((await s.context()).occupied, true); assert.equal(await s.deliver(), null);
    release(); await applied; assert.equal(await git(path.join(s.directory, "source.git"), ["rev-parse", s.ref]), s.input.head);
    assert.equal((await s.send()).status, "retired"); assert.equal(s.writer.git.calls.receive, 1); assert.equal((await s.context()).occupied, true);
  } finally { release(); abort.abort(); await running; await s.close(); }
});

test("final SQL gate binds fresh evidence and exact bytes; invalid receipts never replace a known Git acknowledgement", async () => {
  const s = await deliveryScenario(), db = await broker.connect();
  try {
    const job = await s.send(), claim = (await db.query("SELECT collab_git.claim_task_push_delivery() AS result")).rows[0].result;
    const prepared = await prepareExportedTaskPush(s.directory, s.job.jobId, s.sendInput.manifestHash);
    await db.query("SELECT collab_git.begin_task_push_delivery($1,$2,$3)", [job.jobId, claim.claimId, prepared.attempt]);
    const receipt = await s.writer.client.execute(prepared, s.binding, async value => {
      const gate = (evidence: unknown, hash: string, attempt = value.attempt) => db.query("SELECT collab_git.gate_task_push_delivery($1,$2,$3,$4,$5)", [job.jobId, claim.claimId, attempt, JSON.stringify(evidence), hash]);
      await assert.rejects(gate(value.evidence, "0".repeat(64)), /invalid_task_push_evidence/);
      await assert.rejects(gate(value.evidence, value.evidenceHash, { ...value.attempt, requestHash: "0".repeat(64) }), /invalid_task_push_evidence/);
      for (const patch of [{ verifiedAt: new Date(Date.now() - 60000).toISOString() }, { defaultSha: "0".repeat(40) }, { activeRules: 1 }, { repository: { ...s.binding, visibility: "public" } }]) {
        const evidence = { ...value.evidence, ...patch }; await assert.rejects(gate(evidence, createHash("sha256").update(JSON.stringify(evidence)).digest("hex")), /invalid_task_push_evidence/);
      }
      await gate(value.evidence, value.evidenceHash); return true;
    });
    assert.equal(receipt.outcome?.status, "acknowledged");
    for (const patch of [{ receiveStarted: false }, { evidence: {} }, { outcome: { status: "acknowledged", newSha: s.imported.baseSha, responseHash: "0".repeat(64) } },
      { outcome: { status: "acknowledged", newSha: s.input.head } }, { outcome: { status: "rejected", reason: "invented", responseHash: "0".repeat(64) } },
      { credential: { status: "not_requested", expiresAt: null } }, { failure: "credential material must not be accepted" }])
      await assert.rejects(db.query("SELECT collab_git.finish_task_push_delivery($1,$2,$3)", [job.jobId, claim.claimId, { ...receipt, ...patch }]), /invalid_task_push_evidence/);
    assert.equal((await db.query("SELECT collab_git.finish_task_push_delivery($1,$2,$3) AS result", [job.jobId, claim.claimId, receipt])).rows[0].result.status, "acknowledged");
    assert.equal(s.writer.git.calls.receive, 1);
  } finally { db.release(true); await s.close(); }
});

test("SIGKILL of a separate delivery broker before and after gate never causes takeover to repeat an attempt", async () => {
  for (const phase of ["afterBegin", "afterGateCommit", "afterExecute"]) {
    const s = await deliveryScenario(); let child: ReturnType<typeof spawn> | undefined;
    try {
      const job = await s.send(), script = path.join(s.directory, "kill-delivery.mts"), key = path.join(s.directory, "generated-master.key");
      await writeFile(key, master, { mode: 0o600 });
      // The child has its own loopback fixture and only generated test auth.
      const brokerModule = pathToFileURL(path.resolve("lib/collab/git/push-delivery-broker.ts")).href;
      const fixtureModule = pathToFileURL(path.resolve("tests/collab/fixtures/github-push.ts")).href;
      const credentialsModule = pathToFileURL(path.resolve("tests/collab/fixtures/github.ts")).href;
      const pgModule = pathToFileURL(path.resolve("node_modules/pg/lib/index.js")).href;
      // Fixture keys are generated per process, so create a sealed connection
      // key using the parent's generated private key, never an installed key.
      const pemPath = path.join(s.directory, "generated-app.pem");
      const { pair } = await import("./fixtures/github"); await writeFile(pemPath, pair.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
      await writeFile(script, `import pg from ${JSON.stringify(pgModule)}; import {readFile} from 'node:fs/promises'; import {createPrivateKey,createPublicKey} from 'node:crypto';
import {processTaskPushDelivery} from ${JSON.stringify(brokerModule)}; import {githubPushFixture} from ${JSON.stringify(fixtureModule)}; import {config} from ${JSON.stringify(credentialsModule)};
const root=process.env.TEST_DELIVERY_ROOT; const privateKey=createPrivateKey(await readFile(root+'/generated-app.pem'));
const fixture=await githubPushFixture(root,JSON.parse(process.env.TEST_DELIVERY_BINDING),process.env.TEST_DELIVERY_REF,'write',{privateKey,publicKey:createPublicKey(privateKey)},config);
const pool=new pg.Pool({connectionString:process.env.TEST_DELIVERY_SQL});
await processTaskPushDelivery(pool,root,()=>readFile(root+'/generated-master.key'),{transport:fixture.transport,${phase}:async(id)=>{process.send({id});await new Promise(()=>{});}});
`, { mode: 0o600 });
      child = spawn(process.execPath, ["--import", "tsx", script], { env: { ...process.env, TEST_DELIVERY_ROOT: s.directory, TEST_DELIVERY_SQL: gitConnectionString(config, dbName), TEST_DELIVERY_BINDING: JSON.stringify(s.binding), TEST_DELIVERY_REF: s.ref }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
      const [message] = await once(child, "message", { signal: AbortSignal.timeout(30000) }); assert.equal(message.id, job.jobId);
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
      const recovered = await s.deliver(); assert.equal(recovered.status, phase === "afterBegin" ? "not_sent" : "unknown");
      assert.equal(await s.deliver(), null); assert.equal(s.writer.state.issued, 0); assert.equal(s.writer.git.calls.receive, 0);
      if (phase === "afterExecute") assert.equal(await git(path.join(s.directory, "source.git"), ["rev-parse", s.ref]), s.input.head);
    } finally { if (child?.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; } await s.close(); }
  }
});

test("the remote expected-old gate rejects a competing ref, while cancellation after local authorization cannot promise unsent", async () => {
  for (const change of ["competing_ref", "cancel"]) {
    const s = await deliveryScenario();
    try {
      const job = await s.send();
      const result = await s.deliver({ afterGateCommit: async () => {
        if (change === "competing_ref") await git(path.join(s.directory, "source.git"), ["update-ref", s.ref, s.imported.baseSha]);
        else assert.equal((await s.action(job.jobId)).stopRequested, true);
      } });
      assert.equal(result.status, change === "competing_ref" ? "rejected" : "acknowledged");
      assert.equal(result.credential.status, "revoked"); assert.equal((await s.context()).occupied, false); assert.equal(s.writer.git.calls.receive, 1);
      assert.equal(await git(path.join(s.directory, "source.git"), ["rev-parse", s.ref]), change === "competing_ref" ? s.imported.baseSha : s.input.head);
    } finally { await s.close(); }
  }
});

test("durable full-history confirmation fixes exact destination and metadata, deduplicates concurrently and never issues write credentials", async () => {
  const s = await confirmationScenario();
  try {
    assert.equal(s.confirmationInput.commits.length, 2);
    const calls = s.f.calls.length, results = await Promise.all([s.confirm(), s.confirm()]);
    assert.equal(new Set(results.map(r => r.id)).size, 1); assert.equal(results.filter(r => !r.replayed).length, 1);
    const record = results[0]; assert.equal(record.status, "reserved"); assert.equal(record.valid, true); assert.equal(record.actorId, users[1]); assert.equal(record.commitCount, 2);
    await assert.rejects(s.confirm(users[1], { ...s.confirmationInput, destination: { ...s.confirmationInput.destination, newSha: s.imported.baseSha } }), /idempotency_conflict/);
    assert.deepEqual(record.destination, s.confirmationInput.destination);
    const state = await s.context(users[3]); assert.equal(state.canConfirm, false); assert.equal(state.occupied, true); assert.equal(state.confirmations[0].id, record.id);
    const persisted = (await admin.query("SELECT request FROM collab_git.push_confirmations WHERE id=$1", [record.id])).rows[0].request;
    assert.equal(persisted.manifestHash, s.confirmationInput.manifestHash); assert.deepEqual(persisted.commits, s.confirmationInput.commits);
    await writeFile(path.join(s.checkout, "code.txt"), "later draft is not newly disclosed\n"); assert.deepEqual((await s.context()).confirmations[0].destination, record.destination);
    assert.equal(s.f.calls.length, calls); assert.equal(s.f.git.calls.receive, 0);
    assert.equal((await admin.query("SELECT 1 FROM collab.audit_events WHERE resource_id=$1 AND action='task_push.confirmed'", [record.id])).rowCount, 1);
    await s.withdraw(record.id);
  } finally { await s.close(); }
});

test("confirmation SQL rejects incomplete, duplicated and forged history or destination; controls enforce scope, MFA and narrow grants", async () => {
  const s = await confirmationScenario();
  try {
    const { idempotencyKey, ...payload } = s.confirmationInput;
    for (const patch of [{ commits: payload.commits.slice(0, 1) }, { commits: [payload.commits[0], payload.commits[0]] },
      { commits: payload.commits.map(c => ({ ...c, hash: "f".repeat(64) })) }, { commits: payload.commits.map(c => ({ ...c, changedPaths: 0 })) },
      { manifestHash: "0".repeat(64) }, { observationHash: "0".repeat(64) }, { destination: { ...payload.destination, ref: "refs/heads/main" } },
      { destination: { ...payload.destination, repository: { ...payload.destination.repository, visibility: "public" } } },
      { acknowledgeHistory: false }, { acknowledgeDisclosure: false }, { actorId: users[0] }]) {
      await assert.rejects(asUser(users[1], db => db.query("SELECT collab.confirm_task_push($1,$2,$3)", [s.job.jobId, idempotencyKey, { ...payload, ...patch }])), /invalid_task_push_confirmation/);
    }
    await assert.rejects(s.confirm(users[3]), /forbidden/); await assert.rejects(s.confirm(users[4]), /not_found/); await assert.rejects(s.context(users[4]), /not_found/);
    await admin.query("UPDATE collab.memberships SET role='admin' WHERE organization_id=$1 AND user_id=$2", [organization, users[1]]);
    await assert.rejects(s.confirm(), /forbidden/); await admin.query("UPDATE collab.memberships SET role='member' WHERE organization_id=$1 AND user_id=$2", [organization, users[1]]);
    for (const sql of ["SELECT * FROM collab_git.push_confirmations", "SELECT collab_git.push_confirmation_scope($1)"]) {
      await assert.rejects(asUser(users[1], db => db.query(sql, sql.includes("$1") ? [s.job.jobId] : undefined)), /permission/);
    }
    await assert.rejects(broker.query("SELECT collab.confirm_task_push($1,$2,$3)", [s.job.jobId, idempotencyKey, payload]), /permission/);
    const result = await s.confirm(); await s.withdraw(result.id);
  } finally { await s.close(); }
});

test("one stable remote destination excludes different members and previews; withdrawal is scoped, idempotent and never revives old confirmation", async () => {
  const s = await confirmationScenario();
  try {
    const second = await requestTaskPushPreview(users[2], s.claim.run.id, { ...s.input, idempotencyKey: randomUUID() });
    const nextReader = await githubPushFixture(s.directory, s.binding, s.ref, "read");
    try { assert.equal((await processTaskPushPreview(broker, s.directory, async () => Buffer.from(master), { transport: nextReader.transport })).status, "ready"); }
    finally { await nextReader.close(); }
    const scope = (await taskPushConfirmationContext(users[2], second.jobId)).scope; assert.ok(scope);
    const secondInput = { ...scope, acknowledgeHistory: true as const, acknowledgeDestination: true as const, acknowledgeDisclosure: true as const, idempotencyKey: randomUUID() };
    const competing = await Promise.allSettled([s.confirm(), confirmTaskPush(users[2], second.jobId, secondInput)]);
    assert.equal(competing.filter(r => r.status === "fulfilled").length, 1);
    const winner = competing.find(r => r.status === "fulfilled"); assert.ok(winner); assert.equal(winner.status, "fulfilled");
    const loser = competing.find(r => r.status === "rejected"); assert.ok(loser); assert.match(String(loser.reason), /task_push_destination_busy/);
    const record = winner.value; await assert.rejects(s.withdraw(record.id, users[3]), /forbidden/); const key = randomUUID();
    assert.equal((await s.withdraw(record.id, users[2], key)).status, "withdrawn"); assert.equal((await s.withdraw(record.id, users[2], key)).replayed, true);
    await assert.rejects(withdrawTaskPushConfirmation(users[2], record.id, { idempotencyKey: key, reason: "A different explanation under the same request key" }), /idempotency_conflict/);
    const replay = record.previewId === s.job.jobId ? await s.confirm() : await confirmTaskPush(users[2], second.jobId, secondInput);
    assert.equal(replay.status, "withdrawn"); assert.equal(replay.replayed, true); assert.equal((await s.context()).occupied, false);
    const next = await s.confirm(users[1], { ...s.confirmationInput, idempotencyKey: randomUUID() }); assert.notEqual(next.id, record.id); await s.withdraw(next.id);
  } finally { await s.close(); }
});

test("revocation and regrant cannot revive confirmation versions; stale records retain their target until an authorized withdrawal", async () => {
  const s = await confirmationScenario();
  try {
    const first = await s.confirm();
    await admin.query("UPDATE collab.project_memberships SET active=false WHERE project_id=$1 AND user_id=$2", [project, users[1]]);
    assert.equal((await s.context(users[2])).confirmations[0].valid, false); await assert.rejects(s.confirm(), /not_found/);
    await admin.query("UPDATE collab.project_memberships SET active=true WHERE project_id=$1 AND user_id=$2", [project, users[1]]);
    const replay = await s.confirm(); assert.equal(replay.valid, false); assert.equal(replay.id, first.id); assert.equal((await s.context()).occupied, true);
    await assert.rejects(s.confirm(users[2], { ...s.confirmationInput, idempotencyKey: randomUUID() }), /task_push_destination_busy/);
    await s.withdraw(first.id, users[2]);
    const next = await s.confirm(users[2], { ...s.confirmationInput, idempotencyKey: randomUUID() }); assert.equal(next.valid, true);
    await admin.query("UPDATE collab.github_bindings SET verified_at=verified_at WHERE repository_id=$1", [s.imported.id]);
    assert.equal((await s.context()).canConfirm, false); assert.equal((await s.context()).confirmations[0].valid, false);
    await assert.rejects(s.confirm(users[2], { ...s.confirmationInput, idempotencyKey: randomUUID() }), /stale_task_push_confirmation/);
    await admin.query("DELETE FROM collab.github_bindings WHERE repository_id=$1", [s.imported.id]);
    const missingBinding = await s.context(users[2]); assert.equal(missingBinding.canConfirm, false); assert.equal(missingBinding.confirmations[0].valid, false); assert.equal(missingBinding.occupied, true);
    await s.withdraw(next.id, users[2]);
  } finally { await admin.query("UPDATE collab.project_memberships SET active=true WHERE project_id=$1 AND user_id=$2", [project, users[1]]); await s.close(); }
});

test("original export corruption blocks new confirmation, while terminal retries survive missing artifacts without provider calls", async () => {
  const s = await confirmationScenario();
  try {
    const manifest = path.join(s.directory, "task-push-exports", s.job.jobId, "manifest.json"), bytes = await readFile(manifest), calls = s.f.calls.length;
    await writeFile(manifest, "{}"); await assert.rejects(s.confirm(), /读取失败/);
    assert.equal((await s.context()).confirmations.length, 0); await writeFile(manifest, bytes);
    const record = await s.confirm(); await rm(path.join(s.directory, "task-push-exports", s.job.jobId), { recursive: true });
    assert.equal((await s.confirm()).id, record.id); await s.withdraw(record.id); assert.equal((await s.confirm()).status, "withdrawn");
    assert.equal(s.f.calls.length, calls); assert.equal(s.f.git.calls.receive, 0);
  } finally { await s.close(); }
});

test("authorization and task changes during actual export verification cannot cross final confirmation admission", async t => {
  const s = await confirmationScenario();
  try {
    const original = TaskPushHistoryReader.open;
    for (const change of ["member", "task"] as const) {
      const mocked = t.mock.method(TaskPushHistoryReader, "open", async (...args: Parameters<typeof TaskPushHistoryReader.open>) => {
        const reader = await original(...args);
        if (change === "member") await admin.query("UPDATE collab.project_memberships SET active=false WHERE project_id=$1 AND user_id=$2", [project, users[1]]);
        else await admin.query("UPDATE collab.tasks SET version=version+1 WHERE id=$1", [s.task.id]);
        return reader;
      });
      await assert.rejects(s.confirm(), change === "member" ? /not_found/ : /stale_task_push_confirmation/); mocked.mock.restore();
      await admin.query("UPDATE collab.project_memberships SET active=true WHERE project_id=$1 AND user_id=$2", [project, users[1]]);
    }
    assert.equal((await s.context()).confirmations.length, 0);
  } finally { await admin.query("UPDATE collab.project_memberships SET active=true WHERE project_id=$1 AND user_id=$2", [project, users[1]]); await s.close(); }
});

test("a dropped confirmation COMMIT reply returns the original durable reservation without reading artifacts or repeating provider work", async () => {
  const s = await confirmationScenario(), sockets = new Set<Socket>(); let dropped = false;
  const proxy = createServer(client => {
    const upstream = createConnection({ host: "127.0.0.1", port: config.databasePort }); sockets.add(client); sockets.add(upstream); let recording = false, final = false;
    client.on("data", chunk => { if (Buffer.from(chunk).includes(Buffer.from("SELECT collab.confirm_task_push("))) recording = true; if (recording && Buffer.from(chunk).includes(Buffer.from("COMMIT"))) final = true; upstream.write(chunk); });
    upstream.on("data", chunk => { if (final && Buffer.from(chunk).includes(Buffer.from("COMMIT"))) { dropped = true; client.destroy(); upstream.destroy(); return; } client.write(chunk); });
    for (const socket of [client, upstream]) { socket.on("error", () => {}); socket.on("close", () => { sockets.delete(socket); client.destroy(); upstream.destroy(); }); }
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const url = new URL(connectionString(config, false, dbName)); url.port = String((proxy.address() as { port: number }).port);
  const through = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 5000, query_timeout: 5000 }), originalPool = database();
  try {
    globalThis.__piCollabPool = through; await assert.rejects(s.confirm()); assert.equal(dropped, true); globalThis.__piCollabPool = originalPool;
    await rm(path.join(s.directory, "task-push-exports", s.job.jobId), { recursive: true }); const calls = s.f.calls.length;
    const replay = await s.confirm(); assert.equal(replay.replayed, true); assert.equal(replay.status, "reserved"); assert.equal((await s.context()).confirmations.length, 1);
    assert.equal(s.f.calls.length, calls); await s.withdraw(replay.id);
  } finally { globalThis.__piCollabPool = originalPool; await through.end(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => proxy.close(() => resolve())); await s.close(); }
});

test("confirmation final transaction holds current task ownership until its attestation and reservation commit", async () => {
  const s = await confirmationScenario(); let changed = false, mutation: Promise<unknown> | undefined;
  try {
    const { idempotencyKey, ...payload } = s.confirmationInput;
    const result = await asUser(users[1], async db => {
      const record = (await db.query("SELECT collab.confirm_task_push($1,$2,$3) AS result", [s.job.jobId, idempotencyKey, payload])).rows[0].result;
      mutation = admin.query("UPDATE collab.tasks SET owner_id=$2,version=version+1 WHERE id=$1", [s.task.id, users[2]]).then(() => { changed = true; });
      await new Promise(resolve => setTimeout(resolve, 150)); assert.equal(changed, false); return record;
    });
    assert.equal(result.valid, true); await mutation; assert.equal(changed, true);
    const context = await s.context(users[2]); assert.equal(context.confirmations[0].valid, false); assert.equal(context.occupied, true);
    await s.withdraw(result.id, users[2]);
  } finally { await mutation; await s.close(); }
});

test("current task ownership, project scope, MFA and immutable retry payload gate preview admission", async () => {
  const s = await scenario();
  try {
    for (const actor of [users[3], users[4]]) await assert.rejects(s.request(actor), /forbidden|not_found/);
    await admin.query("UPDATE collab.tasks SET owner_id=$2,version=version+1 WHERE id=$1", [s.task.id, users[2]]);
    await assert.rejects(s.request(), /forbidden/); await admin.query("UPDATE collab.tasks SET owner_id=$2,version=version+1 WHERE id=$1", [s.task.id, users[1]]);
    await admin.query("UPDATE collab.memberships SET role='admin' WHERE organization_id=$1 AND user_id=$2", [organization, users[1]]);
    await assert.rejects(s.request(), /forbidden/); await admin.query("UPDATE collab.memberships SET role='member' WHERE organization_id=$1 AND user_id=$2", [organization, users[1]]);
    const job = await s.request();
    assert.equal((await workspaceGitState(users[1], s.claim.run.id)).occupied, true);
    await assert.rejects(workspaceGitPreview(users[1], s.claim.run.id), /已有 Git/);
    await assert.rejects(requestTaskPushPreview(users[1], s.claim.run.id, { ...s.input, head: s.imported.baseSha }), /idempotency_conflict/);
    await assert.rejects(requestTaskPushPreview(users[1], s.claim.run.id, { ...s.input, idempotencyKey: randomUUID() }), /workspace_git_busy/);
    await assert.rejects(taskPushPreviewDetail(users[4], job.jobId), /not_found/); await assert.rejects(s.cancel(job.jobId, users[3]), /forbidden/);
    await s.cancel(job.jobId); assert.equal((await s.process()).status, "cancelled"); assert.equal(s.f.state.issued, 0);
  } finally { await s.f.close(); }
});

test("preview, workspace Git and snapshot capture are mutually exclusive in both admission orders", async () => {
  const s = await scenario();
  try {
    const stage = { kind: "stage" as const, selections: [{ path: "code.txt", direction: "stage" as const, hunks: "file" as const }],
      revision: s.input.revision, expectedRunRevision: s.input.expectedRunRevision, acknowledge: true as const, idempotencyKey: randomUUID() };
    const snapshot = { expectedRevision: s.input.expectedRunRevision, note: "Snapshot source occupancy", idempotencyKey: randomUUID() };
    const job = await s.request();
    await assert.rejects(requestWorkspaceGit(users[1], s.claim.run.id, stage), /workspace_git_busy/);
    await assert.rejects(requestSnapshot(users[1], s.claim.run.id, snapshot), /workspace_git_busy/);
    await s.cancel(job.jobId); await s.process();
    await requestSnapshot(users[1], s.claim.run.id, snapshot);
    await assert.rejects(requestTaskPushPreview(users[1], s.claim.run.id, { ...s.input, idempotencyKey: randomUUID() }), /workspace_git_busy/);
    await processSnapshots(store, s.directory);
    await requestWorkspaceGit(users[1], s.claim.run.id, stage);
    await assert.rejects(requestTaskPushPreview(users[1], s.claim.run.id, { ...s.input, idempotencyKey: randomUUID() }), /workspace_git_busy/);
    assert.equal((await processWorkspaceGit(broker, s.directory))?.status, "applied");
  } finally { await s.f.close(); }
});

test("simultaneous preview and source operation admission has exactly one owner across independent SQL sessions", async () => {
  for (const kind of ["stage", "snapshot"]) {
    const s = await scenario();
    try {
      const operation = () => kind === "stage" ? requestWorkspaceGit(users[1], s.claim.run.id, { kind: "stage",
        selections: [{ path: "code.txt", direction: "stage", hunks: "file" }], revision: s.input.revision,
        expectedRunRevision: s.input.expectedRunRevision, acknowledge: true, idempotencyKey: randomUUID() })
        : requestSnapshot(users[1], s.claim.run.id, { expectedRevision: s.input.expectedRunRevision, note: "Competing capture", idempotencyKey: randomUUID() });
      const results = await Promise.allSettled([s.request(), operation()]);
      assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
      const rejected = results.find(r => r.status === "rejected"); assert.ok(rejected); assert.match(String(rejected.reason), /workspace_git_busy/);
      if (results[0].status === "fulfilled") { await s.cancel(results[0].value.jobId); await s.process(); }
      else if (kind === "stage") assert.equal((await processWorkspaceGit(broker, s.directory))?.status, "applied");
      else await processSnapshots(store, s.directory);
      assert.equal((await workspaceGitState(users[1], s.claim.run.id)).occupied, false);
    } finally { await s.f.close(); }
  }
});

test("restricted roles cannot read secrets, directly write previews or claim another connection's nonce", async () => {
  const s = await scenario();
  try {
    const job = await s.request();
    for (const sql of ["SELECT * FROM collab_git.push_previews", "SELECT * FROM collab_git.credentials", "SELECT collab_git.push_preview_result($1)"])
      await assert.rejects(broker.query(sql, sql.includes("$1") ? [job.jobId] : undefined), /permission/);
    await assert.rejects(asUser(users[1], db => db.query("SELECT collab_git.claim_push_preview()")), /permission/);
    const db = await admin.connect();
    try { for (const role of ["pi_collab_executor", "pi_collab_gateway", "pi_collab_broker"]) { await db.query(`SET ROLE ${role}`); await assert.rejects(db.query("SELECT collab_git.claim_push_preview()"), /permission/); await db.query("RESET ROLE"); } }
    finally { db.release(); }
    assert.equal((await s.process({ afterClaim: async id => {
      const record = await s.row(id); assert.equal(await s.process(), null);
      await assert.rejects(broker.query("SELECT collab_git.begin_push_preview($1,$2)", [id, record.claim_id]), /claim_lost/);
    } })).status, "ready");
  } finally { await s.f.close(); }
});

test("queued cancellation never reads a key, and cancellation after export prevents publication", async () => {
  for (const queued of [true, false]) {
    const s = await scenario();
    try {
      const job = await s.request(); if (queued) await s.cancel(job.jobId);
      const result = queued ? await processTaskPushPreview(broker, s.directory, async () => { throw new Error("Key access forbidden"); })
        : await s.process({ afterPreview: async id => { await s.cancel(id); } });
      assert.equal(result.status, "cancelled"); assert.equal((await s.row(job.jobId)).manifest_hash, null);
      assert.equal(s.f.state.issued, queued ? 0 : 1); assert.equal(s.f.git.calls.receive, 0);
    } finally { await s.f.close(); }
  }
});

test("authorization regrant, task changes, binding versions and installation disable invalidate final publication", async () => {
  for (const change of ["membership", "task", "binding", "installation"]) {
    const s = await scenario();
    try {
      const job = await s.request();
      const result = await s.process({ beforeFinish: async () => {
        if (change === "membership") await admin.query("UPDATE collab.project_memberships SET authorization_version=authorization_version+2 WHERE project_id=$1 AND user_id=$2", [project, users[1]]);
        else if (change === "task") await admin.query("UPDATE collab.tasks SET version=version+1 WHERE id=$1", [s.task.id]);
        else if (change === "binding") await admin.query("UPDATE collab.github_bindings SET verified_at=now() WHERE repository_id=$1", [s.imported.id]);
        else await admin.query("UPDATE collab.github_installations SET enabled=false WHERE id=$1", [connectionId]);
      } });
      assert.equal(result.status, "failed"); assert.match(result.failure, /authority_changed/); assert.equal((await s.row(job.jobId)).manifest_hash, null);
    } finally { await admin.query("UPDATE collab.github_installations SET enabled=true WHERE id=$1", [connectionId]); await s.f.close(); }
  }
});

test("source changes or export corruption refuse publication and do not rewrite or delete the original evidence", async () => {
  for (const change of ["source", "manifest", "result"]) {
    const s = await scenario();
    try {
      const job = await s.request();
      const result = await s.process(change === "source" ? { afterBegin: async () => { await writeFile(path.join(s.checkout, "code.txt"), "later draft\n"); } }
        : { afterPreview: async (id, value) => {
          if (change === "manifest") await writeFile(path.join(s.directory, "task-push-exports", id, "manifest.json"), "{}");
          else value.observation.target.repository.repositoryId = randomUUID();
        } });
      assert.equal(result.status, "failed"); assert.equal((await s.row(job.jobId)).manifest_hash, null); assert.equal(s.f.git.calls.receive, 0);
    } finally { await s.f.close(); }
  }
});

test("lost SQL owner after export is failed without replay, while stale callbacks cannot publish abandoned artifacts", async () => {
  const s = await scenario();
  try {
    const job = await s.request(); let nonce = "", observation = "", manifest = "", hash = "";
    await assert.rejects(s.process({ afterPreview: async (id, value) => {
      nonce = (await s.row(id)).claim_id; observation = JSON.stringify(value.observation); manifest = JSON.stringify(value.manifest); hash = value.manifestHash;
      await s.disconnect(id);
    } }), /outcome_unknown/);
    const calls = s.f.calls.length;
    assert.equal((await s.process()).status, "failed"); assert.equal((await s.row(job.jobId)).failure, "task_push_preview_reader_lost");
    await assert.rejects(broker.query("SELECT collab_git.finish_push_preview($1,$2,$3,$4,$5)", [job.jobId, nonce, observation, manifest, hash]), /claim_lost/);
    assert.equal((await s.request()).replayed, true); assert.equal(await s.process(), null); assert.equal(s.f.calls.length, calls);
    assert.equal((await verifyTaskPushExport(s.directory, job.jobId, hash)).manifest.input.intent.newSha, s.input.head);
    const next = await requestTaskPushPreview(users[1], s.claim.run.id, { ...s.input, idempotencyKey: randomUUID() }); assert.notEqual(next.jobId, job.jobId);
    await s.cancel(next.jobId); await s.process();
  } finally { await s.f.close(); }
});

test("SQL independently binds observation and exact manifest bytes after filesystem verification", async () => {
  for (const change of ["hash", "observation"]) {
    const s = await scenario();
    try {
      const job = await s.request(); let captured: Parameters<NonNullable<NonNullable<Parameters<typeof processTaskPushPreview>[3]>["afterPreview"]>>[1] | undefined;
      const result = await s.process({ afterPreview: async (_id, value) => { captured = value; }, beforeFinish: async () => {
        assert.ok(captured);
        if (change === "hash") captured.manifestHash = createHash("sha256").update("wrong").digest("hex");
        else captured.observation.target.observedOld = s.imported.baseSha;
      } });
      assert.equal(result.status, "failed"); assert.equal((await s.row(job.jobId)).manifest_hash, null);
    } finally { await s.f.close(); }
  }
});

test("revocation during a live upload cancels the read without waiting for the full transfer deadline", async () => {
  const s = await scenario(); let revoked = false;
  try {
    const job = await s.request(); s.f.git.state.afterUpload = async () => {
      if (revoked) return; revoked = true;
      await admin.query("UPDATE collab.project_memberships SET active=false WHERE project_id=$1 AND user_id=$2", [project, users[1]]);
      await new Promise(resolve => setTimeout(resolve, 900));
    };
    const result = await s.process(); assert.equal(revoked, true); assert.equal(result.status, "failed");
    assert.equal(result.failure, "task_push_preview_authority_changed"); assert.equal(s.f.state.revoked, 1);
    assert.equal((await s.row(job.jobId)).manifest_hash, null); assert.equal(s.f.git.calls.receive, 0);
  } finally { await admin.query("UPDATE collab.project_memberships SET active=true WHERE project_id=$1 AND user_id=$2", [project, users[1]]); await s.f.close(); }
});

test("the final publication transaction holds task ownership until preview evidence commits", async () => {
  const s = await scenario(); let changed = false, mutation: Promise<unknown> | undefined;
  try {
    await s.request();
    const result = await s.process({ beforeCommit: async () => {
      mutation = admin.query("UPDATE collab.tasks SET owner_id=$2,version=version+1 WHERE id=$1", [s.task.id, users[2]]).then(() => { changed = true; });
      await new Promise(resolve => setTimeout(resolve, 150)); assert.equal(changed, false);
    } });
    assert.equal(result.status, "ready"); await mutation; assert.equal(changed, true);
  } finally { await mutation; await s.f.close(); }
});

test("a silent SQL owner connection bounds live read authority and cannot publish a late preview", { timeout: 15000 }, async () => {
  const s = await scenario(), sockets = new Set<Socket>(); let held = false, beginAt = 0, releaseUpload!: () => void;
  const upload = new Promise<void>(resolve => { releaseUpload = resolve; });
  s.f.git.state.afterUpload = () => upload;
  const proxy = createServer(client => {
    const upstream = createConnection({ host: "127.0.0.1", port: config.databasePort }); sockets.add(client); sockets.add(upstream); let silent = false;
    client.on("data", chunk => { if (Buffer.from(chunk).includes(Buffer.from("push_preview_live"))) { silent = true; held = true; } upstream.write(chunk); });
    upstream.on("data", chunk => { if (!silent) client.write(chunk); });
    for (const socket of [client, upstream]) { socket.on("error", () => {}); socket.on("close", () => { sockets.delete(socket); client.destroy(); upstream.destroy(); }); }
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const url = new URL(gitConnectionString(config, dbName)); url.port = String((proxy.address() as { port: number }).port);
  const through = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
  try {
    const job = await s.request();
    await assert.rejects(processTaskPushPreview(through, s.directory, async () => Buffer.from(master), { transport: s.f.transport, afterBegin: async () => { beginAt = Date.now(); } }), /outcome_unknown/);
    assert.equal(held, true); assert.ok(Date.now() - beginAt < 5000); assert.equal(s.f.state.revoked, 1);
    assert.equal((await s.process()).status, "failed"); assert.equal((await s.row(job.jobId)).manifest_hash, null); assert.equal(s.f.git.calls.receive, 0);
  } finally { releaseUpload(); await through.end(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => proxy.close(() => resolve())); await s.f.close(); }
});

test("a real dropped final COMMIT response replays the ready record without downloading or requesting another token", async () => {
  const s = await scenario(), sockets = new Set<Socket>(); let armed = false, dropped = false;
  const proxy = createServer(client => {
    const upstream = createConnection({ host: "127.0.0.1", port: config.databasePort }); sockets.add(client); sockets.add(upstream); let final = false;
    client.on("data", chunk => { if (armed && Buffer.from(chunk).includes(Buffer.from("COMMIT"))) final = true; upstream.write(chunk); });
    upstream.on("data", chunk => { if (final && Buffer.from(chunk).includes(Buffer.from("COMMIT"))) { dropped = true; client.destroy(); upstream.destroy(); return; } client.write(chunk); });
    for (const socket of [client, upstream]) { socket.on("error", () => {}); socket.on("close", () => { sockets.delete(socket); client.destroy(); upstream.destroy(); }); }
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const url = new URL(gitConnectionString(config, dbName)); url.port = String((proxy.address() as { port: number }).port);
  const through = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 5000, query_timeout: 5000 });
  try {
    const job = await s.request();
    await assert.rejects(processTaskPushPreview(through, s.directory, async () => Buffer.from(master), { transport: s.f.transport, beforeCommit: async () => { armed = true; } }), /outcome_unknown/);
    assert.equal(dropped, true); assert.equal((await s.row(job.jobId)).status, "ready");
    const calls = s.f.calls.length; assert.equal((await s.request()).replayed, true); assert.equal(await s.process(), null); assert.equal(s.f.calls.length, calls);
    assert.equal(s.f.state.issued, 1); assert.equal(s.f.git.calls.receive, 0);
  } finally { await through.end(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => proxy.close(() => resolve())); await s.f.close(); }
});

test("scoped history requires the SQL ready hash, retains original bytes after source edits and reads no provider credentials", async () => {
  const s = await scenario(), previous = process.env.PI_COLLAB_DATA_DIR; process.env.PI_COLLAB_DATA_DIR = s.directory;
  try {
    const job = await s.request(); await assert.rejects(taskPushHistory(users[1], job.jobId, { kind: "commits", manifestHash: "0".repeat(64) }), /已完成/);
    const ready = await s.process(), query = { manifestHash: ready.manifestHash }, calls = s.f.calls.length;
    const history = await taskPushHistory(users[3], job.jobId, { ...query, kind: "commits" }); assert.equal(history.kind, "commits"); if (history.kind !== "commits") throw new Error("Wrong history page");
    assert.equal(history.identity.head, s.input.head); assert.equal(history.total, 1);
    const file = await taskPushHistory(users[1], job.jobId, { ...query, kind: "file", commit: s.input.head, path: "code.txt" });
    assert.equal(file.kind, "file"); if (file.kind !== "file") throw new Error("Wrong history file"); assert.equal(file.after?.text, "task committed\n");
    await writeFile(path.join(s.checkout, "code.txt"), "new source draft\n");
    assert.deepEqual(await taskPushHistory(users[3], job.jobId, { ...query, kind: "file", commit: s.input.head, path: "code.txt" }), file);
    const download = await taskPushHistoryDownload(users[3], job.jobId, { ...query, kind: "file", commit: s.input.head, path: "code.txt", side: "after" });
    assert.equal(Buffer.from(download.bytesBase64, "base64").toString(), "task committed\n"); assert.equal(s.f.calls.length, calls);
    await assert.rejects(taskPushHistory(users[4], job.jobId, { ...query, kind: "commits" }), /not_found/);
    await assert.rejects(taskPushHistoryDownload(users[4], job.jobId, { ...query, kind: "commit", commit: s.input.head }), /not_found/);
    await assert.rejects(taskPushHistory(users[1], job.jobId, { kind: "commits", manifestHash: "0".repeat(64) }), /版本不匹配/);
    const manifest = path.join(s.directory, "task-push-exports", job.jobId, "manifest.json"); await writeFile(manifest, "{}");
    await assert.rejects(taskPushHistory(users[1], job.jobId, { ...query, kind: "commits" }), /读取失败/); assert.equal(await readFile(manifest, "utf8"), "{}");
  } finally { if (previous === undefined) delete process.env.PI_COLLAB_DATA_DIR; else process.env.PI_COLLAB_DATA_DIR = previous; await s.f.close(); }
});

test("project access revoked during actual history or raw-byte reading prevents the already-read response from escaping", async t => {
  const s = await scenario(), previous = process.env.PI_COLLAB_DATA_DIR; process.env.PI_COLLAB_DATA_DIR = s.directory;
  try {
    const job = await s.request(), ready = await s.process();
    for (const method of ["read", "download"] as const) {
      const original = TaskPushHistoryReader.prototype[method] as (this: HistoryReader, raw: never) => Promise<unknown>;
      const mocked = t.mock.method(TaskPushHistoryReader.prototype, method, async function(this: HistoryReader, raw: never) {
        const value = await original.call(this, raw);
        await admin.query("UPDATE collab.project_memberships SET active=false WHERE project_id=$1 AND user_id=$2", [project, users[3]]);
        return value;
      });
      const work = method === "read" ? taskPushHistory(users[3], job.jobId, { kind: "commits", manifestHash: ready.manifestHash })
        : taskPushHistoryDownload(users[3], job.jobId, { kind: "commit", commit: s.input.head, manifestHash: ready.manifestHash });
      await assert.rejects(work, /not_found/); mocked.mock.restore();
      await admin.query("UPDATE collab.project_memberships SET active=true WHERE project_id=$1 AND user_id=$2", [project, users[3]]);
    }
  } finally { await admin.query("UPDATE collab.project_memberships SET active=true WHERE project_id=$1 AND user_id=$2", [project, users[3]]); if (previous === undefined) delete process.env.PI_COLLAB_DATA_DIR; else process.env.PI_COLLAB_DATA_DIR = previous; await s.f.close(); }
});

// F4: one primary remote delivery flow, with authority/version rejection and unknown-write handling.
test("PR release foundation: draft readiness, independent fixed review, CI and protected merge form a complete local protocol flow",async()=>{
 const s=await checksScenario();let releaseApi:Awaited<ReturnType<typeof githubPullFixture>>|undefined,mergeApi:Awaited<ReturnType<typeof githubPullFixture>>|undefined;
 try{
  const first=await pullReleaseContext(users[2],s.revision.jobId);
  const ready=await requestPullRelease(users[2],s.revision.jobId,{idempotencyKey:randomUUID(),action:"ready",diffHash:first.diffHash,expectedTaskVersion:first.taskVersion,reason:"Publish this reviewed draft for the team",acknowledge:true});
  releaseApi=await githubPullFixture(s.directory,s.fixed.attempt,"ready");await releaseApi.seedObservation();
  assert.equal((await processPullRelease(broker,async()=>Buffer.from(master),{transport:releaseApi.transport})).status,"ready");assert.equal(releaseApi.state.releases,1);
  assert.equal((await pullReleaseContext(users[2],s.revision.jobId)).jobs.find(j=>j.jobId===ready.jobId)?.status,"ready");
  s.creator.created[0]=structuredClone(releaseApi.created[0]);
  const observation=await s.observationContext();await s.requestObservation(users[1],{idempotencyKey:randomUUID(),expectedTaskVersion:observation.taskVersion,expectedObservationVersion:observation.observationVersion});
  const observer=await s.observer();await observer.process();
  const context=await s.revisionContext();const revision=await s.requestRevision(users[1],{idempotencyKey:randomUUID(),expectedTaskVersion:context.taskVersion,expectedObservationVersion:context.observationVersion});
  const codeReader=await githubPushFixture(s.directory,s.binding,s.ref,"read");
  try{assert.equal((await processPullRevision(broker,s.directory,async()=>Buffer.from(master),{transport:codeReader.transport})).status,"ready");}finally{await codeReader.close();}
  const review=await pullReleaseContext(users[2],revision.jobId);
  const vote={idempotencyKey:randomUUID(),diffHash:review.diffHash,decision:"approve" as const,body:"Read the fixed code and verified the intended behavior"};
  await assert.rejects(reviewPullRevision(users[1],revision.jobId,vote),/independent_review_required/);
  await reviewPullRevision(users[3],revision.jobId,vote);assert.equal((await reviewPullRevision(users[3],revision.jobId,vote)).replayed,true);
  const ciContext=await pullChecksContext(users[1],revision.jobId);await requestPullChecks(users[1],revision.jobId,{idempotencyKey:randomUUID(),expectedTaskVersion:ciContext.taskVersion,expectedPolicyId:s.policy.policyId});
  const ci=await s.checksReader();ci.fixture.created[0]=structuredClone(releaseApi.created[0]);assert.equal((await ci.process()).eligible,true);
  const current=await pullReleaseContext(users[2],revision.jobId);assert.equal(current.eligible,true);assert.equal(current.draft,false);
  const payload={idempotencyKey:randomUUID(),action:"merge" as const,diffHash:current.diffHash,expectedTaskVersion:current.taskVersion,reason:"Merge the independently reviewed fixed version",acknowledge:true as const};
  await assert.rejects(requestPullRelease(users[1],revision.jobId,payload),/forbidden/);
  const job=await requestPullRelease(users[2],revision.jobId,payload);assert.equal((await requestPullRelease(users[2],revision.jobId,payload)).jobId,job.jobId);
  const unsafe=await githubPullFixture(s.directory,s.fixed.attempt,"merge");await unsafe.seedObservation();unsafe.created[0]=structuredClone(releaseApi.created[0]);unsafe.state.protection.enforce_admins={enabled:false};
  try{assert.equal((await processPullRelease(broker,async()=>Buffer.from(master),{transport:unsafe.transport})).status,"not_sent");assert.equal(unsafe.state.releases,0);}finally{await unsafe.close();}
  await requestPullRelease(users[2],revision.jobId,{...payload,idempotencyKey:randomUUID()});
  mergeApi=await githubPullFixture(s.directory,s.fixed.attempt,"merge");await mergeApi.seedObservation();mergeApi.created[0]=structuredClone(releaseApi.created[0]);
  const merged=await processPullRelease(broker,async()=>Buffer.from(master),{transport:mergeApi.transport});assert.equal(merged.status,"merged");assert.match(merged.result.sha,/^[a-f0-9]{40}$/);
  assert.equal(await git(path.join(s.directory,"source.git"),["rev-parse","refs/heads/main"]),merged.result.sha);assert.equal(mergeApi.state.releases,1);assert.equal(mergeApi.state.revoked,1);
  assert.equal(mergeApi.containsCredential(merged),false);
 }finally{await releaseApi?.close();await mergeApi?.close();await s.close();}
});

test("PR release foundation: a new independent change request cancels queued authority before any remote write",async()=>{
 const s=await checksScenario();try{
  const c=await pullReleaseContext(users[2],s.revision.jobId);
  await reviewPullRevision(users[3],s.revision.jobId,{idempotencyKey:randomUUID(),diffHash:c.diffHash,decision:"approve",body:"Approved this fixed code for independent review"});
  await requestPullRelease(users[2],s.revision.jobId,{idempotencyKey:randomUUID(),action:"ready",diffHash:c.diffHash,expectedTaskVersion:c.taskVersion,reason:"Ready this current draft for review",acknowledge:true});
  await reviewPullRevision(users[3],s.revision.jobId,{idempotencyKey:randomUUID(),diffHash:c.diffHash,decision:"changes_requested",body:"Found an issue that requires changes before release"});
  let calls=0;const result=await processPullRelease(broker,async()=>Buffer.from(master),{transport:async()=>{calls++;throw new Error("Must not call network");}});
  assert.equal(result.status,"not_sent");assert.equal(calls,0);
  assert.equal((await pullReleaseContext(users[2],s.revision.jobId)).votes[0].decision,"changes_requested");
  await admin.query("UPDATE collab.project_memberships SET active=false WHERE project_id=$1 AND user_id=$2",[project,users[3]]);
  try{assert.equal((await pullReleaseContext(users[2],s.revision.jobId)).votes[0].valid,false);}finally{await admin.query("UPDATE collab.project_memberships SET active=true WHERE project_id=$1 AND user_id=$2",[project,users[3]]);}
 }finally{await s.close();}
});

test("PR release foundation: lost mutation responses remain unknown and cannot cause duplicate dispatch",async()=>{
 const s=await checksScenario();const api=await githubPullFixture(s.directory,s.fixed.attempt,"ready");await api.seedObservation();api.state.fail="release-cut";
 try{const c=await pullReleaseContext(users[2],s.revision.jobId);const body={idempotencyKey:randomUUID(),action:"ready" as const,diffHash:c.diffHash,expectedTaskVersion:c.taskVersion,reason:"Ready this fixed draft for review",acknowledge:true as const};
  const j=await requestPullRelease(users[2],s.revision.jobId,body);const result=await processPullRelease(broker,async()=>Buffer.from(master),{transport:api.transport});assert.equal(result.status,"unknown");assert.equal(api.state.releases,1);
  assert.equal((await requestPullRelease(users[2],s.revision.jobId,body)).jobId,j.jobId);await assert.rejects(requestPullRelease(users[2],s.revision.jobId,{...body,idempotencyKey:randomUUID()}),/pull_release_busy/);
  assert.equal(await processPullRelease(broker,async()=>Buffer.from(master),{transport:api.transport}),null);assert.equal(api.state.releases,1);
 }finally{await api.close();await s.close();}
});

test("fixed PR line discussions retain exact revisions, mentions and resolution without granting approval or crossing task scope", async () => {
 const { discussionCommand, discussionDetail, discussions, inbox } = await import("../../lib/collab/discussions");
 const { reviewDiscussionCode, reviewDiscussionContext } = await import("../../lib/collab/review-discussions");
 const s=await revisionScenario();
 try {
  const job=await s.requestRevision();assert.equal((await s.processRevision()).status,"ready");
  const page=await pullRevisionCode(users[3],job.jobId,{}),context=await reviewDiscussionContext(users[3],"pull",job.jobId);
  const anchor={kind:"pull" as const,sourceId:job.jobId,sourceHash:context.sourceHash,diffHash:page.record.diffHash!,path:"code.txt",side:"after" as const,startLine:1,endLine:1};
  const input={action:"create" as const,title:"Review this changed line",body:"Please explain this fixed change",mentions:[users[1]],anchor:null,replacement:null,reviewAnchor:anchor,idempotencyKey:randomUUID()};
  const posted=await discussionCommand(users[3],s.task.id,input);
  assert.equal((await discussionCommand(users[3],s.task.id,input)).threadId,posted.threadId);
  assert.equal((await inbox(users[1])).items.filter(n=>n.thread_id===posted.threadId).length,1);
  assert.deepEqual((await discussionDetail(users[1],posted.threadId)).thread.review_anchor,anchor);
  const {side,startLine,endLine,...source}=anchor;void side;void startLine;void endLine;
  assert.equal((await discussions(users[1],s.task.id,0,source)).total,1);
  await assert.rejects(discussionCommand(users[3],s.task.id,{...input,reviewAnchor:{...anchor,endLine:2},idempotencyKey:randomUUID()}),/行范围/);
  await assert.rejects(discussionCommand(users[3],s.task.id,{...input,reviewAnchor:{...anchor,diffHash:"0".repeat(64)},idempotencyKey:randomUUID()}),/不匹配/);
  const other=await createTask(users[1],project,{title:"Unrelated task",description:"",acceptance:""});
  await assert.rejects(discussionCommand(users[3],other.id,{...input,idempotencyKey:randomUUID()}),/invalid_discussion/);
  await assert.rejects(reviewDiscussionContext(users[4],"pull",job.jobId),/not_found/);
  await discussionCommand(users[1],s.task.id,{action:"reply",threadId:posted.threadId,body:"This exact version is intentional",mentions:[],idempotencyKey:randomUUID()});
  await discussionCommand(users[3],s.task.id,{action:"resolve",threadId:posted.threadId,resolved:true,expectedVersion:1,idempotencyKey:randomUUID()});
  assert.equal((await discussionDetail(users[1],posted.threadId)).messages.length,2);
  await s.requestObservation(users[1],{...s.observationInput,expectedObservationVersion:"1",idempotencyKey:randomUUID()});const observer=await s.observer();assert.equal((await observer.process()).status,"observed");
  const old=await reviewDiscussionCode(users[3],anchor);assert.equal(old.current,false);assert.equal(old.text,"task committed\n");
  await admin.query("UPDATE collab.project_memberships SET active=false WHERE project_id=$1 AND user_id=$2",[project,users[3]]);
  await assert.rejects(reviewDiscussionCode(users[3],anchor),/not_found/);await assert.rejects(discussionDetail(users[3],posted.threadId),/不可访问/);
  assert.equal((await inbox(users[3])).items.length,0);
 }finally{await admin.query("UPDATE collab.project_memberships SET active=true WHERE project_id=$1 AND user_id=$2",[project,users[3]]);await s.close();}
});
