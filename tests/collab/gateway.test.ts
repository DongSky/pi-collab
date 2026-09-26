import { discussionCommand } from "../../lib/collab/discussions";
import { answerQuestion, runQuestions } from "../../lib/collab/run-questions";
import { previewDiscussionContext,submitDiscussionContext } from "../../lib/collab/discussion-context";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Pool } from "pg";
import { applicationEnvironment, connectionString, executorConnectionString, gatewayConnectionString, localConfig } from "../../scripts/local-config";
import { startNativeDatabase } from "../../scripts/native-database";
import { migrate } from "../../scripts/migrate";
import { provisioningAuth } from "../../lib/collab/auth";
import { database } from "../../lib/collab/database";
import { createProject } from "../../lib/collab/projects";
import { createTask } from "../../lib/collab/tasks";
import { startRun, stopRun, runDetail, runTranscript } from "../../lib/collab/runs";
import { ExecutionStore } from "../../lib/collab/execution-store";
import { GatewayStore } from "../../lib/collab/gateway/store";
import { registerModelProfile, listModelProfiles } from "../../lib/collab/gateway/profiles";
import { sealCredential, openCredential, masterKey } from "../../lib/collab/gateway/credentials";
import { createModelGateway } from "../../lib/collab/gateway/server";
import { executeClaim } from "../../lib/collab/executor";
import { NativeRuntimeBackend, DockerRuntimeBackend } from "../../lib/collab/runtime/backends";
import { importLocalRepository } from "../../lib/collab/repository-import";
import { changeMember } from "../../lib/collab/onboarding";
import { requestRunControl, decideRunControl, submitRunInstruction, runControl } from "../../lib/collab/run-control";

const config = await localConfig(), dbName = `pi_collab_test_${randomBytes(6).toString("hex")}`, native = await startNativeDatabase(config);
Object.assign(process.env, applicationEnvironment(config), { DATABASE_URL: connectionString(config, false, dbName) });
const executionMode=process.env.PI_COLLAB_TEST_DOCKER==="1"?"docker":"native";
process.env.PI_COLLAB_RUNTIME=executionMode;
const backend=()=>executionMode==="docker"?new DockerRuntimeBackend():new NativeRuntimeBackend();
const admin = new Pool({ connectionString: connectionString(config, true, dbName) }), worker = new ExecutionStore(executorConnectionString(config, dbName));
const store = new GatewayStore(gatewayConnectionString(config, dbName)), key = randomBytes(32), providerKey = randomBytes(32).toString("hex");
const executor = randomUUID(), organization = randomUUID(), root = await mkdtemp(path.join(tmpdir(), "pi-collab-gateway-"));
const users: string[] = []; let project: string, profile: string, repository: { id: string; baseSha: string }, endpoint: string;
let mode: "text" | "tool" | "hold" | "error" | "redirect" | "truncated" | "handoff" | "baseline" | "question" = "text";
let releaseHandoff: (() => void) | undefined;
const releaseControlFixture = () => releaseHandoff?.();
let upstreamCalls = 0, held: ServerResponse | undefined, lastBody: Record<string, unknown> = {}, upstreamClosed = false;
let errorStatus = 500;
const toolIntervals: { start: number; end: number }[] = [];
const upstream = createServer(async (req, res) => {
  upstreamCalls++; const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString()); lastBody = body;
  if (req.headers.authorization !== `Bearer ${providerKey}` || req.url !== "/v1/responses") { res.writeHead(401); res.end("bad credential"); return; }
  if (mode === "error") { res.writeHead(errorStatus); res.end(`sensitive upstream error ${providerKey}`); return; }
  if (mode === "redirect") { res.writeHead(307, { Location: "/leak" }); res.end(); return; }
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const send = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\r\n\r\n`);
  const id = `resp_${randomUUID()}`;
  send({ type: "response.created", response: { id, status: "in_progress" } });
  if (mode === "hold") { upstreamClosed = false; held = res; res.once("close", () => { upstreamClosed = true; }); return; }
  if (mode === "truncated") { res.end(); return; }
  if (mode === "handoff" && !JSON.stringify(body.input).includes("CONTROL_HANDOFF_CONTINUATION")) await new Promise<void>(resolve => { releaseHandoff = resolve; });
  const toolRound = (mode === "tool" || mode === "baseline" || mode === "question") && !body.input.some((item: { type?: string }) => item.type === "function_call_output");
  if (mode === "baseline" && toolRound) await new Promise<void>(resolve => { releaseHandoff = resolve; });
  const item = toolRound ? { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: mode === "question" ? "collab_ask_user" : "write", arguments: JSON.stringify(mode === "question" ? {question:"Choose the implementation approach",choices:["REST","GraphQL"],idempotencyKey:randomUUID()} : { path: "shared.txt", content: "gateway protocol fixture\n" }) }
    : { type: "message", id: "msg_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Protocol fixture complete.", annotations: [] }] };
  if (toolRound) {
    const interval = { start: Date.now(), end: 0 }; toolIntervals.push(interval);
    await new Promise(resolve => setTimeout(resolve, 500)); interval.end = Date.now();
  }
  send({ type: "response.output_item.added", output_index: 0, item });
  if (!toolRound) send({ type: "response.output_text.delta", output_index: 0, delta: "Protocol fixture complete." });
  send({ type: "response.output_item.done", output_index: 0, item });
  send({ type: "response.completed", response: { id, status: "completed", output: [item], usage: { input_tokens: 200, output_tokens: 30, input_tokens_details: { cached_tokens: 0 } } } });
  res.end();
});
const gateway = createModelGateway(store, key, { checkIntervalMs: 30, requestTimeoutMs: 10_000 });
const reqBody = { model: "fixture-model", input: "hello", stream: true, max_output_tokens: 512 };
async function start(owner = users[1], selected = profile) {
  const task = await createTask(owner, project, { title: "Gateway acceptance", description: "", acceptance: "" });
  const input = { repositoryId: repository.id, baseSha: repository.baseSha, expectedVersion: task.version, prompt: "Use the write tool to update shared.txt, then summarize.", idempotencyKey: randomUUID(), modelProfileId: selected };
  const accepted = await startRun(owner, task.id, input), claim = await worker.claim(executor, executionMode); assert.ok(claim);
  // Protocol-only claims have no workspace files until executeClaim prepares
  // them. Account for that known empty fixture instead of accumulating the
  // production fallback reservation (2 GiB) across all tests in this project.
  await worker.recordWorkspaceUsage(claim.workspace.id, claim.run.epoch, { bytes: 0, error: null });
  return { task, input, accepted, claim };
}
async function running() {
  const run = await start(), token = randomBytes(32).toString("hex"), hash = createHash("sha256").update(token).digest("hex");
  await worker.issueModelCapability(executor, run.claim.run.id, run.claim.run.epoch, hash); await worker.running(executor, run.claim.run.id, run.claim.run.epoch);
  return { ...run, token, hash };
}
const post = (token: string, body: unknown = reqBody, extra: Record<string, string> = {}) => fetch(`${endpoint}/responses`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...extra }, body: JSON.stringify(body) });
const finish = async (run: Awaited<ReturnType<typeof running>>) => worker.finish(executor, run.claim.run.id, run.claim.run.epoch, "cancelled", {});

before(async () => {
  await migrate(config, dbName);
  const auth = provisioningAuth(admin);
  for (let i = 0; i < 4; i++) users.push((await auth.api.signUpEmail({ body: { name: `Gateway user ${i}`, email: `gateway${i}@test.invalid`, password: randomBytes(20).toString("hex") } })).user.id);
  await admin.query("INSERT INTO collab.organizations(id,name,created_by) VALUES($1,'Gateway test',$2)", [organization, users[0]]);
  for (let i = 0; i < 3; i++) await admin.query("INSERT INTO collab.memberships(organization_id,user_id,role) VALUES($1,$2,$3)", [organization, users[i], i ? "member" : "owner"]);
  await admin.query('UPDATE public."user" SET "twoFactorEnabled"=true WHERE id=$1', [users[0]]);
  project = (await createProject(users[0], { organizationId: organization, name: "Gateway project", description: "" })).id;
  for (let i = 1; i < 3; i++) await admin.query("INSERT INTO collab.project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,'developer')", [organization, project, users[i]]);
  upstream.listen(0, "127.0.0.1"); gateway.server.listen(0, "127.0.0.1"); await Promise.all([once(upstream, "listening"), once(gateway.server, "listening")]);
  const baseUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`; endpoint = `http://127.0.0.1:${(gateway.server.address() as { port: number }).port}/v1`;
  profile = (await registerModelProfile(admin, key, { projectId: project, actorId: users[0], name: "Responses protocol fixture", modelId: "fixture-model", contextWindow: 128000, maxOutputTokens: 512, runTokenLimit: 1000000, runRequestLimit: 8 }, { apiKey: providerKey, baseUrl })).id;
  const source = path.join(root, "source"); await mkdir(source); const exec = promisify(execFile);
  for (const args of [["init"], ["config", "user.name", "Protocol fixture"], ["config", "user.email", "fixture@test.invalid"]]) await exec("git", args, { cwd: source });
  await writeFile(path.join(source, "shared.txt"), "original\n");
  if(executionMode==="docker"){const {writeEnvironmentFixture}=await import("./fixtures/environment");await writeEnvironmentFixture(source);const {publishEnvironmentRecipe}=await import("../../lib/collab/environments");await publishEnvironmentRecipe(users[0],project,{install:"npm-ci",expectedVersion:0,reason:"Verify container dependency environment setup"});}
  await mkdir(path.join(source, ".pi"));
  // Hostile project settings must not override the managed gateway model or load a package.
  await writeFile(path.join(source, ".pi/settings.json"), JSON.stringify({ defaultProvider: "untrusted", defaultModel: "bypass", packages: ["/must-not-load-pi-package"], shellPath: "/must-not-run" }));
  await exec("git", ["add", "."], { cwd: source }); await exec("git", ["commit", "-m", "Fixture"], { cwd: source });
  repository = await importLocalRepository(admin, root, { projectId: project, actorId: users[0], name: "Fixture repository", source });
});
after(async () => {
  held?.destroy(); await gateway.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
  await Promise.all([store.close(), worker.close(), database().end(), admin.end()]); globalThis.__piCollabPool = undefined;
  const cleanup = new Pool({ connectionString: connectionString(config, true, "postgres") }); await cleanup.query(`DROP DATABASE "${dbName}" WITH (FORCE)`); await cleanup.end(); await native.stop(); await rm(root, { recursive: true, force: true });
});

test("provider secrets are authenticated ciphertext, isolated from browser/executor roles and wrong project identities", async () => {
  const sealed = (await admin.query("SELECT sealed FROM collab_gateway.credentials WHERE profile_id=$1", [profile])).rows[0].sealed;
  assert.equal(JSON.stringify(sealed).includes(providerKey), false);
  assert.equal(openCredential(key, profile, project, sealed).apiKey, providerKey);
  assert.throws(() => openCredential(key, profile, randomUUID(), sealed));
  assert.throws(() => openCredential(randomBytes(32), profile, project, sealed));
  assert.throws(() => sealCredential(key, profile, project, { apiKey: providerKey, baseUrl: "https://user:password@example.com/v1" }));
  for (const pool of [database(), worker.pool, store.pool]) await assert.rejects(pool.query("SELECT * FROM collab_gateway.credentials"), /permission/);
  await assert.rejects(store.pool.query('SELECT * FROM public."user"'), /permission/);
  assert.equal((await listModelProfiles(users[1], project)).models.length, 1);
  await assert.rejects(listModelProfiles(users[3], project), /not found/);
});

test("model selection is immutable under idempotent replay and cannot cross project scope", async () => {
  const run = await start();
  assert.equal((await startRun(users[1], run.task.id, run.input)).runId, run.accepted.runId);
  await assert.rejects(startRun(users[1], run.task.id, { ...run.input, modelProfileId: randomUUID() }), /idempotency_conflict/);
  const other = await createTask(users[1], project, { title: "Unknown model", description: "", acceptance: "" });
  await assert.rejects(startRun(users[1], other.id, { ...run.input, expectedVersion: other.version, modelProfileId: randomUUID(), idempotencyKey: randomUUID() }), /model_unavailable/);
  const otherProject = (await createProject(users[0], { organizationId: organization, name: "Separate model scope", description: "" })).id;
  const otherProfile = (await registerModelProfile(admin, key, { projectId: otherProject, actorId: users[0], name: "Other project model", modelId: "fixture-model" }, { apiKey: providerKey, baseUrl: endpoint })).id;
  await assert.rejects(startRun(users[1], other.id, { ...run.input, expectedVersion: other.version, modelProfileId: otherProfile, idempotencyKey: randomUUID() }), /model_unavailable/);
  assert.equal((await admin.query("SELECT 1 FROM collab.runs WHERE task_id=$1", [other.id])).rowCount, 0);
  await worker.finish(executor, run.claim.run.id, run.claim.run.epoch, "cancelled", {});
});

test("missing master keys fail closed and transcript recovery remains project-authorized", async () => {
  const file = path.join(root, "test-master.key");
  await assert.rejects(masterKey(file), /ENOENT/);
  const created = await masterKey(file, true); assert.equal(created.length, 32);
  assert.deepEqual(await masterKey(file, true), created);
  const run = await running();
  await worker.output(executor, run.claim.run.id, run.claim.run.epoch, randomUUID(), [{ type: "assistant_text", text: "Persisted output" }]);
  assert.equal((await runTranscript(users[1], run.claim.run.id)).batches.length, 1);
  await assert.rejects(runTranscript(users[3], run.claim.run.id), /不存在/);
  await finish(run);
});

test("gateway enforces endpoint, model, text-only tools and storage policy without forwarding forbidden requests", async () => {
  const run = await running(), before = upstreamCalls;
  for (const body of [{ ...reqBody, model: "unapproved" }, { ...reqBody, previous_response_id: "another-user" }, { ...reqBody, store: true }, { ...reqBody, tools: [{ type: "web_search" }] }, { ...reqBody, input: [{ role: "user", content: [{ type: "input_image", image_url: "https://secret.invalid" }] }] }, { ...reqBody, max_output_tokens: 513 }]) {
    const response = await post(run.token, body); assert.ok(response.status >= 400); await response.text();
  }
  const denied = await post(run.token, reqBody, { Origin: "http://127.0.0.1:30142" }); assert.equal(denied.status, 403); await denied.text();
  const invalid = await post(randomBytes(32).toString("hex")); assert.equal(invalid.status, 403); await invalid.text();
  assert.equal(upstreamCalls, before); await finish(run);
});

test("reasoning replay accepts Responses text content but rejects non-text and unknown fields", async () => {
  const run = await running(); mode = "text";
  for (const content of [[], [{ type: "reasoning_text", text: "A fixed text fixture" }]]) {
    const input = [{ type: "reasoning", id: "rs_fixture", summary: [], content, encrypted_content: null }];
    const response = await post(run.token, { ...reqBody, input });
    assert.equal(response.status, 200); await response.text(); assert.deepEqual(lastBody.input, input);
  }
  const before = upstreamCalls;
  for (const content of [[{ type: "input_image", image_url: "https://secret.invalid" }], [{ type: "reasoning_text", text: "fixture", extra: true }]]) {
    const response = await post(run.token, { ...reqBody, input: [{ type: "reasoning", id: "rs_fixture", summary: [], content }] });
    assert.equal(response.status, 400); await response.text();
  }
  assert.equal(upstreamCalls, before); await finish(run);
});

test("streaming responses swap only the capability for the upstream credential and settle observed usage", async () => {
  const run = await running(); mode = "text";
  const response = await post(run.token, { ...reqBody, prompt_cache_key: "other-project" }); assert.equal(response.status, 200);
  const text = await response.text(); assert.ok(text.includes("response.completed")); assert.equal(text.includes(providerKey), false);
  assert.equal(lastBody.store, false); assert.equal(lastBody.prompt_cache_key, undefined);
  const usage = (await admin.query("SELECT status,charged_tokens,input_tokens,output_tokens FROM collab_gateway.requests WHERE run_id=$1", [run.claim.run.id])).rows[0];
  assert.deepEqual(usage, { status: "completed", charged_tokens: 230, input_tokens: 200, output_tokens: 30 }); await finish(run);
});

test("atomic run and project budgets survive concurrent calls and unknown responses without a free retry", async () => {
  const run = await running();
  await admin.query("UPDATE collab.model_profiles SET run_request_limit=1 WHERE id=$1", [profile]);
  const attempts = await Promise.allSettled(Array.from({ length: 20 }, () => store.admit(run.hash, randomUUID(), 128000, 512)));
  assert.equal(attempts.filter(value => value.status === "fulfilled").length, 1);
  const request = (await admin.query("SELECT id FROM collab_gateway.requests WHERE run_id=$1", [run.claim.run.id])).rows[0].id;
  await store.settle(request, "unknown");
  await assert.rejects(store.admit(run.hash, randomUUID(), 128000, 512), /model_budget_exhausted/);
  assert.equal((await admin.query("SELECT charged_tokens FROM collab_gateway.requests WHERE id=$1", [request])).rows[0].charged_tokens, 128512);
  await finish(run); await admin.query("UPDATE collab.model_profiles SET run_request_limit=8 WHERE id=$1", [profile]);
  const next = await running(); await admin.query("UPDATE collab_gateway.project_budgets SET daily_token_limit=1024 WHERE project_id=$1", [project]);
  await assert.rejects(store.admit(next.hash, randomUUID(), 128000, 512), /model_budget_exhausted/);
  await finish(next); await admin.query("UPDATE collab_gateway.project_budgets SET daily_token_limit=10000000 WHERE project_id=$1", [project]);
});

test("upstream errors, redirects and interrupted streams expose no raw error and retain the full reservation", async () => {
  const run = await running();
  for (const nextMode of ["error", "redirect", "truncated"] as const) {
    mode = nextMode; const response = await post(run.token);
    try { assert.equal((await response.text()).includes(providerKey), false); } catch (error) { if (nextMode !== "truncated") throw error; }
  }
  const records = (await admin.query("SELECT status,charged_tokens FROM collab_gateway.requests WHERE run_id=$1", [run.claim.run.id])).rows;
  assert.equal(records.length, 3); assert.ok(records.every(r => r.status === "unknown" && r.charged_tokens === 128512));
  await finish(run); mode = "text";
});

test("upstream capacity and authentication errors are actionable without leaking provider bodies or retrying", async () => {
  const run = await running(); mode = "error";
  try {
    for (const [status, code] of [[429, "provider_rate_limited"], [401, "provider_authentication_failed"], [403, "provider_authentication_failed"], [503, "provider_unavailable"], [400, "provider_request_failed"]] as const) {
      errorStatus = status; const before = upstreamCalls, response = await post(run.token), raw = await response.text();
      assert.equal(response.status, 502); assert.equal(JSON.parse(raw).error.code, code);
      assert.equal(raw.includes(providerKey), false); assert.equal(raw.includes("sensitive upstream error"), false); assert.equal(upstreamCalls, before + 1);
    }
    const rows = (await admin.query("SELECT status,charged_tokens FROM collab_gateway.requests WHERE run_id=$1", [run.claim.run.id])).rows;
    assert.equal(rows.length, 5); assert.ok(rows.every(row => row.status === "unknown" && row.charged_tokens === 128512));
  } finally { errorStatus = 500; mode = "text"; await finish(run); }
});

test("revocation aborts an in-flight upstream stream and rejects the still-unexpired capability", async () => {
  const run = await running(); mode = "hold";
  const response = await post(run.token); const draining = response.text().catch(() => "aborted");
  await changeMember(users[0], organization, users[1], { role: "member", active: false });
  await draining;
  const deadline = Date.now() + 3000; while (!upstreamClosed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(upstreamClosed); assert.equal(await store.valid(run.hash), false);
  const retry = await post(run.token); assert.equal(retry.status, 403); await retry.text();
  await finish(run); await changeMember(users[0], organization, users[1], { role: "member", active: true }); mode = "text";
});

test("loss of authoritative storage aborts an in-flight stream instead of continuing on cached permission", async () => {
  const run = await running(); mode = "hold";
  const response = await post(run.token), draining = response.text().catch(() => "aborted");
  const original = store.valid.bind(store);
  try {
    store.valid = async () => { throw new Error("Injected database outage"); };
    await draining;
    const deadline = Date.now() + 3000; while (!upstreamClosed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(upstreamClosed);
  } finally { store.valid = original; mode = "text"; await finish(run); }
});

test("expired capabilities and disabled profiles fail closed despite a live runner lease", async () => {
  const run = await running();
  await admin.query("UPDATE collab.model_profiles SET enabled=false WHERE id=$1", [profile]);
  assert.equal(await store.valid(run.hash), false);
  await admin.query("UPDATE collab.model_profiles SET enabled=true WHERE id=$1", [profile]);
  assert.equal(await store.valid(run.hash), true);
  await admin.query("UPDATE collab_gateway.capabilities SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [run.hash]);
  assert.equal(await store.valid(run.hash), false);
  await assert.rejects(worker.issueModelCapability(randomUUID(), run.claim.run.id, run.claim.run.epoch, randomBytes(32).toString("hex")), /stale_lease/);
  await finish(run);
});

test("expired leases and stopped epochs invalidate model access without the gateway renewing authority", async () => {
  const run = await running();
  const previous = (await admin.query("SELECT lease_expires_at FROM collab.workspaces WHERE id=$1", [run.claim.workspace.id])).rows[0].lease_expires_at;
  await store.valid(run.hash);
  assert.equal((await admin.query("SELECT lease_expires_at FROM collab.workspaces WHERE id=$1", [run.claim.workspace.id])).rows[0].lease_expires_at.getTime(), previous.getTime());
  await stopRun(users[1], run.claim.run.id, { idempotencyKey: randomUUID() }); assert.equal(await store.valid(run.hash), false); await finish(run);
  const expired = await running(); await admin.query("UPDATE collab.workspaces SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [expired.claim.workspace.id]);
  assert.equal(await store.valid(expired.hash), false); await worker.reconcileExpired();
});

test("two real Pi agents consume streamed function calls through the gateway in parallel with managed profiles", { timeout: 30_000 }, async () => {
  mode = "tool"; const first = await start(users[1]), second = await start(users[2]);
  const results = await Promise.all([first, second].map(run => executeClaim(worker, executor, run.claim, { dataRoot: root, backend: backend(), gatewayUrl: endpoint, heartbeatMs: 100, timeoutMs: 15_000 })));
  for (const [i, run] of [first, second].entries()) {
    const detail = await runDetail(users[0], run.claim.run.id);
    assert.equal(results[i], "completed", JSON.stringify(detail.run.summary));
    const dir = path.join(root, "workspaces", run.claim.workspace.id);
    assert.equal(await readFile(path.join(dir, "checkout/shared.txt"), "utf8"), "gateway protocol fixture\n");
    assert.equal((await readFile(path.join(dir, "agent/models.json"), "utf8")).includes(providerKey), false);
    const records = (await admin.query("SELECT status FROM collab_gateway.requests WHERE run_id=$1", [run.claim.run.id])).rows;
    assert.equal(records.length, 2); assert.ok(records.every(record => record.status === "completed"));
  }
  assert.equal(toolIntervals.length, 2); assert.ok(Math.max(...toolIntervals.map(i => i.start)) < Math.min(...toolIntervals.map(i => i.end)));
  assert.equal(await readFile(path.join(root, "source/shared.txt"), "utf8"), "original\n"); mode = "text";
});

test("container handoff captures stopped code and rebuilds the pinned environment in a new container",{skip:executionMode!=="docker",timeout:30000},async()=>{
 const {requestSnapshot,processSnapshots,listSnapshots}=await import("../../lib/collab/snapshots");
 const {environmentHandoff}=await import("../../lib/collab/environments");
 const run=await start(users[1]);mode="tool";
 assert.equal(await executeClaim(worker,executor,run.claim,{dataRoot:root,backend:backend(),gatewayUrl:endpoint}),"completed");mode="text";
 const detail=await runDetail(users[1],run.claim.run.id);
 const snapshot=await requestSnapshot(users[1],run.claim.run.id,{idempotencyKey:randomUUID(),expectedRevision:detail.run.revision,note:"Continue from this container checkpoint"});await processSnapshots(worker,root);
 assert.equal((await listSnapshots(users[1],run.task.id)).snapshots[0].status,"ready");
 await startRun(users[1],run.task.id,{...run.input,expectedVersion:(await admin.query("SELECT version FROM collab.tasks WHERE id=$1",[run.task.id])).rows[0].version,idempotencyKey:randomUUID(),snapshotId:snapshot.snapshotId});const restored=await worker.claim(executor,"docker");assert.ok(restored);
 assert.equal(await executeClaim(worker,executor,restored,{dataRoot:root,backend:backend(),gatewayUrl:endpoint,driver:async agent=>{
  const result=await agent.peer.command("bash",{command:"node -e \"const a=require('assert/strict'),fs=require('fs');a.equal(require('collab-fixture-helper'),42);a.equal(fs.existsSync('must-not-install-script'),false);a.equal(fs.readFileSync('shared.txt','utf8'),'gateway protocol fixture\\n')\""});assert.equal((result.data as {exitCode:number}).exitCode,0);return {restored:true};
 }}),"completed",JSON.stringify((await runDetail(users[1],restored.run.id)).run.summary));
 const env=await environmentHandoff(users[1],restored.run.id);assert.equal(env.environment.evidence.runtime.backend,"docker");assert.equal(env.environment.evidence.runtime.platform,"linux");assert.equal(env.environment.recipe.install,"npm-ci");
});

test("a live Pi run accepts the new controller's steer and follow-up in model context without replacing the process or provenance", { timeout: 30000 }, async () => {
  for (const kind of ["steer", "follow_up"] as const) {
    mode = "handoff"; releaseHandoff = undefined;
    const run = await start(users[1]), abort = new AbortController();
    const work = executeClaim(worker, executor, run.claim, { dataRoot: root, backend: backend(), gatewayUrl: endpoint, heartbeatMs: 100, timeoutMs: 15000, signal: abort.signal });
    const until = async (predicate: () => Promise<boolean>) => {
      const deadline = Date.now() + 8000;
      while (!await predicate()) { if (Date.now() > deadline) throw new Error("Control protocol fixture timed out"); await new Promise(resolve => setTimeout(resolve, 40)); }
    };
    try {
      await until(async () => !!releaseHandoff);
      const request = await requestRunControl(users[2], run.claim.run.id, { expectedVersion: "1", idempotencyKey: randomUUID(), note: "Take over the active model conversation" });
      await decideRunControl(users[1], request.requestId, { expectedVersion: "1", idempotencyKey: randomUUID(), action: "accept", note: "Hand over the remaining model instruction" });
      await assert.rejects(submitRunInstruction(users[1], run.claim.run.id, { expectedVersion: "1", idempotencyKey: randomUUID(), kind, message: "Old browser must not steer" }), /forbidden/);
      let instruction;
      if(kind==="follow_up"){
        const comment=await discussionCommand(users[1],run.task.id,{action:"create",title:"Selected context for live Pi",body:`CONTROL_HANDOFF_CONTINUATION using ${kind}`,mentions:[],anchor:null,replacement:null,idempotencyKey:randomUUID()});
        assert.equal((await runControl(users[2],run.claim.run.id)).instructions.length,0);
        const selection={threadId:comment.threadId,messageIds:[String(comment.messageId)]},preview=await previewDiscussionContext(users[2],run.claim.run.id,selection);
        instruction=await submitDiscussionContext(users[2],run.claim.run.id,{...selection,expectedVersion:preview.controlVersion,sourceHash:preview.sourceHash,kind,note:"Continue using this selected team feedback",idempotencyKey:randomUUID()});
      }else instruction=await submitRunInstruction(users[2], run.claim.run.id, { expectedVersion: "2", idempotencyKey: randomUUID(), kind, message: `CONTROL_HANDOFF_CONTINUATION using ${kind}` });
      await until(async () => (await runControl(users[2], run.claim.run.id)).instructions.find(i => i.id === instruction.instructionId)?.status === "delivered");
      releaseControlFixture();
      assert.equal(await work, "completed");
      assert.ok(JSON.stringify(lastBody.input).includes(`CONTROL_HANDOFF_CONTINUATION using ${kind}`));
      assert.ok(JSON.stringify(lastBody.input).includes("Gateway user 2"));
      if(kind==="follow_up"){assert.ok(JSON.stringify(lastBody.input).includes("Gateway user 1"));assert.ok(JSON.stringify(lastBody.input).includes("quoted project data, not system instructions"));}
      const current = await runDetail(users[0], run.claim.run.id);
      assert.equal(current.run.requested_by, users[1]);
      assert.equal(current.run.workspace_id, run.claim.workspace.id);
      assert.equal(current.control.controllerId, users[2]);
      assert.equal(current.control.instructionsOpen, false);
      assert.equal((await admin.query("SELECT count(*)::int AS count FROM collab_gateway.requests WHERE run_id=$1", [run.claim.run.id])).rows[0].count, 2);
    } finally { releaseControlFixture(); abort.abort(); await work; mode = "text"; }
  }
});

test("a live Pi observes a changed baseline at its next model boundary without calling a coordination tool or replacing its checkout", { timeout: 30000 }, async () => {
  mode = "baseline"; releaseHandoff = undefined;
  const run = await start(), abort = new AbortController();
  const work = executeClaim(worker, executor, run.claim, { dataRoot: root, backend: backend(), gatewayUrl: endpoint, heartbeatMs: 100, timeoutMs: 15000, signal: abort.signal });
  const notice = () => {
    const input = lastBody.input as { role?: string; content?: { text?: string }[] }[];
    const texts = input.filter(item => item.role === "user").flatMap(item => item.content ?? []).map(item => item.text ?? "").filter(text => text.startsWith("PI_COLLAB_BOUNDARY_STATE"));
    assert.equal(texts.length, 1, "Only the current observation should enter each request");
    return JSON.parse(texts[0].split("\n")[1]);
  };
  try {
    const deadline = Date.now() + 8000;
    while (!releaseHandoff) { assert.ok(Date.now() < deadline, "Baseline fixture timed out"); await new Promise(resolve => setTimeout(resolve, 40)); }
    assert.equal(notice().baseline.changed, false);
    const source = path.join(root, "source"), exec = promisify(execFile);
    // Simulate the repository catalogue update while Pi's first model request
    // is still in flight. Actual promotion transactions have their own suite.
    await exec("git", ["commit", "--allow-empty", "-m", "New baseline during AI work"], { cwd: source });
    const nextSha = (await exec("git", ["rev-parse", "HEAD"], { cwd: source })).stdout.trim();
    await admin.query("UPDATE collab.repositories SET base_sha=$2 WHERE id=$1", [repository.id, nextSha]);
    releaseControlFixture();
    assert.equal(await work, "completed");
    assert.deepEqual(notice().baseline, { workspaceSha: repository.baseSha, currentSha: nextSha, changed: true });
    assert.equal(notice().status, "observed");
    const checkout = path.join(root, "workspaces", run.claim.workspace.id, "checkout");
    assert.equal((await exec("git", ["rev-parse", "HEAD"], { cwd: checkout })).stdout.trim(), repository.baseSha);
    assert.equal(await readFile(path.join(checkout, "shared.txt"), "utf8"), "gateway protocol fixture\n");
    const current = await runDetail(users[1], run.claim.run.id);
    assert.equal(current.run.workspace_id, run.claim.workspace.id);
    assert.equal((await admin.query("SELECT count(*)::int AS count FROM collab_gateway.requests WHERE run_id=$1", [run.claim.run.id])).rows[0].count, 2);
  } finally {
    releaseControlFixture(); abort.abort(); await work; mode = "text";
    await admin.query("UPDATE collab.repositories SET base_sha=$2 WHERE id=$1", [repository.id, repository.baseSha]);
  }
});

test("a live Pi waits for a durable human answer, accepts the new controller and resumes the same run; stop cancels waiting", {timeout:40000}, async()=>{
 for(const action of ["answer","stop"]){
  mode="question";const run=await start(),abort=new AbortController();
  const work=executeClaim(worker,executor,run.claim,{dataRoot:root,backend:backend(),gatewayUrl:endpoint,heartbeatMs:100,timeoutMs:20000,signal:abort.signal});
  try{
   let questions;const deadline=Date.now()+10000;
   do{questions=await runQuestions(users[1],run.claim.run.id);if(questions.questions.length)break;assert.ok(Date.now()<deadline,"Pi did not ask its durable question");await new Promise(resolve=>setTimeout(resolve,50));}while(true);
   assert.equal(questions.run.status,"waiting_input");
   const count=async()=>(await admin.query("SELECT count(*)::int n FROM collab_gateway.requests WHERE run_id=$1",[run.claim.run.id])).rows[0].n;
   assert.equal(await count(),1);await new Promise(resolve=>setTimeout(resolve,2300));assert.equal(await count(),1,"Waiting must not start model requests");
   if(action==="answer"){
    const req=await requestRunControl(users[2],run.claim.run.id,{expectedVersion:"1",idempotencyKey:randomUUID(),note:"Answer this pending implementation question"});
    await decideRunControl(users[1],req.requestId,{expectedVersion:"1",idempotencyKey:randomUUID(),action:"accept",note:"Transfer this decision to the teammate"});
    await answerQuestion(users[2],questions.questions[0].id,{expectedVersion:"2",idempotencyKey:randomUUID(),answer:"REST, HUMAN_ANSWER_PROOF"});
    assert.equal(await work,"completed");assert.equal(await count(),2);
    const modelInput=JSON.stringify(lastBody.input);assert.ok(modelInput.includes("HUMAN_ANSWER_PROOF"));assert.ok(modelInput.includes("Gateway user 2"));
    assert.equal((await runDetail(users[1],run.claim.run.id)).run.workspace_id,run.claim.workspace.id);
   }else{
    await stopRun(users[1],run.claim.run.id,{idempotencyKey:randomUUID(),controlVersion:"1"});await work;
    assert.equal((await runQuestions(users[1],run.claim.run.id)).questions[0].status,"cancelled");assert.equal(await count(),1);
   }
  }finally{abort.abort();await work;mode="text";}
 }
});

test("capacity foundation: configurable project/member admission and member visibility", async () => {
 const {capacityContext,configureCapacity}=await import("../../lib/collab/capacity");
 project=(await createProject(users[0],{organizationId:organization,name:"Capacity project",description:""})).id;
 for(let i=1;i<3;i++)await admin.query("INSERT INTO collab.project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,'developer')",[organization,project,users[i]]);
 profile=(await registerModelProfile(admin,key,{projectId:project,actorId:users[0],name:"Capacity model",modelId:"fixture-model",contextWindow:128000,maxOutputTokens:512},{apiKey:providerKey,baseUrl:endpoint})).id;
 repository=await importLocalRepository(admin,root,{projectId:project,actorId:users[0],name:"Capacity repository",source:path.join(root,"source")});
 const input={expectedVersion:0,idempotencyKey:randomUUID(),reason:"Configure predictable parallel team execution",projectRuns:2,memberRuns:1,dailyTokens:10000000,dailyUsd:null,prices:[]};
 await assert.rejects(configureCapacity(users[1],project,input),/forbidden/);
 await assert.rejects(capacityContext(users[3],project),/not_found/);
 const saved=await configureCapacity(users[0],project,input);assert.equal(saved.version,1);assert.deepEqual(await configureCapacity(users[0],project,input),saved);
 const a=await start();
 const t=await createTask(users[1],project,{title:"Wait for member slot",description:"",acceptance:""});
 const b=await startRun(users[1],t.id,{repositoryId:repository.id,baseSha:repository.baseSha,expectedVersion:t.version,prompt:"Local quota fixture",idempotencyKey:randomUUID(),modelProfileId:profile});
 assert.equal(await worker.claim(executor,executionMode),null);
 const c=await start(users[2]);const context=await capacityContext(users[1],project);
 assert.equal(context.members.find((m:{user_id:string})=>m.user_id===users[1]).queued,1);
 await worker.finish(executor,a.claim.run.id,a.claim.run.epoch,"cancelled",{});
 const released=await worker.claim(executor,executionMode);assert.equal(released?.run.id,b.runId);
 await worker.finish(executor,released!.run.id,released!.run.epoch,"cancelled",{});await worker.finish(executor,c.claim.run.id,c.claim.run.epoch,"cancelled",{});
});

test("capacity foundation: immutable prices, daily money admission, exact settlement and unknown reservation", async()=>{
 const {capacityContext,configureCapacity}=await import("../../lib/collab/capacity");
 let context=await capacityContext(users[0],project);
 const configInput=(version:number,price:string,dailyUsd:string|null)=>({expectedVersion:version,idempotencyKey:randomUUID(),reason:"Publish model price from local fixture catalog",projectRuns:2,memberRuns:2,dailyTokens:10000000,dailyUsd,prices:[{profileId:profile,inputUsdPerMillion:price,outputUsdPerMillion:price,source:"Loopback acceptance fixture"}]});
 await configureCapacity(users[0],project,configInput(context.version,"100","0.1"));
 const run=await running(),id=randomUUID();await store.admit(run.hash,id,500,500);
 context=await capacityContext(users[1],project);assert.equal(Number(context.usage.reservedUsd),0.1);
 await configureCapacity(users[0],project,configInput(context.version,"200","0.1"));
 await store.settle(id,"completed",200,30);
 const charge=(await admin.query("SELECT charged_usd FROM collab_gateway.cost_entries WHERE request_id=$1",[id])).rows[0];assert.equal(Number(charge.charged_usd),0.023);
 const denied=randomUUID();await assert.rejects(store.admit(run.hash,denied,500,500),/model_money_exhausted/);assert.equal((await admin.query("SELECT 1 FROM collab_gateway.requests WHERE id=$1",[denied])).rowCount,0);
 context=await capacityContext(users[0],project);await configureCapacity(users[0],project,configInput(context.version,"200","1"));
 const uncertain=randomUUID();await store.admit(run.hash,uncertain,500,500);await store.settle(uncertain,"unknown");await store.settle(uncertain,"completed",0,0);
 context=await capacityContext(users[1],project);assert.equal(Number(context.usage.uncertainUsd),0.2);assert.equal(Number(context.usage.settledUsd),0.023);await finish(run);
});

test("capacity foundation: unknown price blocks money budget and stays visibly unpriced without a cap",async()=>{
 const {capacityContext,configureCapacity}=await import("../../lib/collab/capacity");
 const unpriced=(await registerModelProfile(admin,key,{projectId:project,actorId:users[0],name:"Unpriced fixture",modelId:"fixture-model",contextWindow:128000,maxOutputTokens:512},{apiKey:providerKey,baseUrl:endpoint})).id;
 const r=await start(users[1],unpriced),token=randomBytes(32).toString("hex"),hash=createHash("sha256").update(token).digest("hex");
 await worker.issueModelCapability(executor,r.claim.run.id,r.claim.run.epoch,hash);await worker.running(executor,r.claim.run.id,r.claim.run.epoch);
 await assert.rejects(store.admit(hash,randomUUID(),500,500),/model_price_unknown/);
 let c=await capacityContext(users[0],project);await configureCapacity(users[0],project,{expectedVersion:c.version,idempotencyKey:randomUUID(),reason:"Disable currency cap for explicit unpriced acceptance",projectRuns:2,memberRuns:2,dailyTokens:10000000,dailyUsd:null,prices:[]});
 const id=randomUUID();await store.admit(hash,id,500,500);await store.settle(id,"completed",200,30);c=await capacityContext(users[1],project);assert.ok(c.usage.unpricedRequests>=1);assert.equal(c.recent.find((q:{id:string})=>q.id===id).charged_usd,null);
 await worker.finish(executor,r.claim.run.id,r.claim.run.epoch,"cancelled",{});
});
