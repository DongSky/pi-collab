import { processPullRelease } from "../lib/collab/git/pull-release-broker";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHmac, createPrivateKey, createPublicKey } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { z } from "zod";
import { localConfig, connectionString, executorConnectionString, gitConnectionString } from "./local-config";
import { importLocalRepository } from "../lib/collab/repository-import";
import { ExecutionStore } from "../lib/collab/execution-store";
import { executeClaim } from "../lib/collab/executor";
import { runtimeBackend } from "../lib/collab/runtime/backends";
import { managedGit } from "../lib/collab/git/github-pack";
import { registerGitHubInstallation, bindGitHubRepository } from "../lib/collab/git/github-registration";
import { githubMasterKey, readPrivateGitHubFile } from "../lib/collab/git/github-credentials";
import { processTaskPushPreview } from "../lib/collab/git/push-preview-broker";
import { processTaskPushDelivery } from "../lib/collab/git/push-delivery-broker";
import { githubFixture, pair } from "../tests/collab/fixtures/github";
import { githubPushFixture } from "../tests/collab/fixtures/github-push";
import { githubPullFixture } from "../tests/collab/fixtures/github-pull";
import { PreparedTaskPull } from "../lib/collab/git/github-task-pull";
import { processTaskPullProposal } from "../lib/collab/git/pull-proposal-broker";
import { processTaskPullDelivery } from "../lib/collab/git/pull-delivery-broker";
import { processPullChecks } from "../lib/collab/git/pull-checks-broker";
import { processPullRevision } from "../lib/collab/git/pull-revision-broker";
import { processPullObservation } from "../lib/collab/git/pull-observation-broker";

const dbName = process.env.PI_COLLAB_E2E_DATABASE ?? "", root = process.env.PI_COLLAB_E2E_DATA ?? "";
if (!/^pi_collab_test_[a-f0-9]+$/.test(dbName) || !path.basename(root).startsWith("identity-e2e-")) throw new Error("Isolated push-history browser fixture required");
const config = await localConfig(), app = { appId: "823", installationId: "8456", accountId: "789" };
const admin = new Pool({ connectionString: connectionString(config, true, dbName) }), broker = new Pool({ connectionString: gitConnectionString(config, dbName) });
const store = new ExecutionStore(executorConnectionString(config, dbName)), mode = process.argv[2], id = z.uuid().parse(process.argv[3]);
const git = async (cwd: string, args: string[]) => (await managedGit(cwd, args, AbortSignal.timeout(30000))).bytes.toString().trim();
try {
  if (mode === "init") {
    const project = (await admin.query("SELECT organization_id,created_by FROM collab.projects WHERE id=$1", [id])).rows[0], source = path.join(root, "push-history-source");
    await mkdir(source); await git(source, ["init", "--template=", "-b", "main"]); await git(source, ["config", "user.name", "Browser history fixture"]); await git(source, ["config", "user.email", "history@test.invalid"]);
    await writeFile(path.join(source, "code.txt"), "baseline\r\n"); await writeFile(path.join(source, ".env"), "KNOWN_REMOTE_PLACEHOLDER=yes\n");
    await git(source, ["add", "."]); await git(source, ["commit", "-m", "Remote baseline"]);
    const repo = await importLocalRepository(admin, root, { projectId: id, actorId: project.created_by, source, name: "出站历史浏览器仓库" });
    const api = await githubFixture(8011, pair, app), master = randomBytes(32);
    try {
      api.state.branch = "main"; api.state.sha = repo.baseSha;
      const connection = await registerGitHubInstallation(admin, master, { ...app, organizationId: project.organization_id, actorId: project.created_by, reason: "Generated App for isolated outgoing history review", idempotencyKey: randomUUID() }, api.pem, api.transport);
      await bindGitHubRepository(admin, master, { repositoryId: repo.id, connectionId: connection.connectionId, githubRepositoryId: "8011", actorId: project.created_by, reason: "Bind generated remote for browser history review", idempotencyKey: randomUUID() }, api.transport);
      const webhookSecret = Buffer.from(randomBytes(32).toString("hex"));
      const configured = await admin.connect();
      try {
        await configured.query("BEGIN"); await configured.query("SELECT set_config('collab.user_id',$1,true)", [project.created_by]);
        await configured.query("SELECT collab_git.configure_webhook($1,0,$2,$3,$4)", [connection.connectionId, randomUUID(), { enabled: true, reason: "Enable signed loopback notifications for browser acceptance" }, webhookSecret]);
        await configured.query("COMMIT");
      } finally { configured.release(); }
      await writeFile(path.join(root, "push-history-webhook.key"), webhookSecret, { mode: 0o600, flag: "wx" }); webhookSecret.fill(0);
      await writeFile(path.join(root, "push-history-master.key"), master, { mode: 0o600, flag: "wx" });
      await writeFile(path.join(root, "push-history.pem"), api.pem, { mode: 0o600, flag: "wx" });
      const serve = path.join(root, "push-history-http"); await mkdir(serve);
      await git(serve, ["-c", "protocol.file.allow=always", "clone", "--bare", "--no-local", "--template=", source, "source.git"]);
      console.log(JSON.stringify(repo));
    } finally { master.fill(0); api.pem.fill(0); await api.close(); }
  } else if (mode === "run") {
    const backend = runtimeBackend(), executor = randomUUID(), claim = await store.claim(executor, process.env.PI_COLLAB_RUNTIME === "docker" ? "docker" : "native"); assert.ok(claim); assert.equal(claim.run.task_id, id);
    assert.equal(await executeClaim(store, executor, claim, { dataRoot: root, backend, driver: async agent => {
      await agent.peer.command("bash", { command: "printf 'intermediate historical content\\n' > temporary.txt; git add temporary.txt; git commit -m 'Intermediate browser checkpoint'; rm temporary.txt .env; printf 'final committed code\\r\\n' > code.txt; printf '\\000\\001\\377' > binary.bin; chmod +x code.txt; git add .; git commit -m 'Final browser checkpoint'; printf 'retained draft\\n' > code.txt" });
      return { kind: "browser-push-history", modelInference: false };
    } }), "completed");
    const cwd = path.join(root, "workspaces", claim.workspace.id, "checkout");
    console.log(JSON.stringify({ runId: claim.run.id, workspaceId: claim.workspace.id, head: await git(cwd, ["rev-parse", "HEAD"]), intermediate: await git(cwd, ["rev-parse", "HEAD^"]) }));
  } else if (["process", "send", "send-unknown"].includes(mode)) {
    const row = (await admin.query("SELECT admission FROM collab_git.push_previews WHERE id=$1", [id])).rows[0]; assert.ok(row);
    const pem = await readPrivateGitHubFile(path.join(root, "push-history.pem")), privateKey = createPrivateKey(pem); pem.fill(0);
    const binding = row.admission.binding, ref = `refs/heads/pi-collab/tasks/${row.admission.taskId}/workspaces/${row.admission.source.workspaceId}`;
    const fixture = await githubPushFixture(path.join(root, "push-history-http"), binding, ref, mode === "process" ? "read" : "write", { privateKey, publicKey: createPublicKey(privateKey) }, app);
    try {
      fixture.git.state.loseReply = mode === "send-unknown";
      const result = mode === "process" ? await processTaskPushPreview(broker, root, () => githubMasterKey(path.join(root, "push-history-master.key")), { transport: fixture.transport, afterClaim: async job => { assert.equal(job, id); } })
        : await processTaskPushDelivery(broker, root, () => githubMasterKey(path.join(root, "push-history-master.key")), { transport: fixture.transport, afterClaim: async job => { assert.equal(job, row.admission.operationId); } });
      if (mode === "process") assert.equal(fixture.git.calls.receive, 0);
      console.log(JSON.stringify({ ...result, readTokens: mode === "process" ? fixture.state.issued : 0, writeTokens: mode === "process" ? 0 : fixture.state.issued, receiveRequests: fixture.git.calls.receive }));
    } finally { await fixture.close(); }
  } else if (["pull-proposal", "pull-existing"].includes(mode)) {
    const row = (await admin.query("SELECT admission,request FROM collab_git.pull_proposals WHERE id=$1", [id])).rows[0]; assert.ok(row);
    const source = row.admission, directory = path.join(root, "push-history-http");
    const pem = await readPrivateGitHubFile(path.join(root, "push-history.pem")), privateKey = createPrivateKey(pem); pem.fill(0);
    const prepared = PreparedTaskPull.prepare(source.binding, { operationId: id, deliveryId: source.deliveryId, repositoryId: source.repositoryId,
      taskId: source.taskId, workspaceId: source.workspaceId, headSha: source.headSha, manifestHash: source.manifestHash,
      baseSha: await git(path.join(directory, "source.git"), ["rev-parse", `refs/heads/${source.binding.defaultBranch}`]), title: row.request.title, body: row.request.body });
    const fixture = await githubPullFixture(directory, prepared.attempt, "preview", { privateKey, publicKey: createPublicKey(privateKey) }, app);
    try {
      fixture.state.existing = mode === "pull-existing";
      const result = await processTaskPullProposal(broker, () => githubMasterKey(path.join(root, "push-history-master.key")), { transport: fixture.transport, afterClaim: async job => { assert.equal(job, id); } });
      assert.equal(fixture.state.creates, 0);
      console.log(JSON.stringify({ ...result, readTokens: fixture.state.issued, createRequests: fixture.state.creates }));
    } finally { await fixture.close(); }
  } else if (["pull-create", "pull-create-existing", "pull-create-unknown"].includes(mode)) {
    const row = (await admin.query("SELECT attempt FROM collab_git.pull_proposals WHERE id=$1", [id])).rows[0]; assert.ok(row);
    const pem = await readPrivateGitHubFile(path.join(root, "push-history.pem")), privateKey = createPrivateKey(pem); pem.fill(0);
    const fixture = await githubPullFixture(path.join(root, "push-history-http"), row.attempt, "create", { privateKey, publicKey: createPublicKey(privateKey) }, app);
    try {
      // Each process explicitly supplies its provider state; a later absent
      // listing models an externally closed PR, not platform adoption or edits.
      fixture.state.number = 17 + (await admin.query("SELECT count(*)::int AS n FROM collab_git.pull_changes")).rows[0].n;
      fixture.state.existing = mode === "pull-create-existing";
      if (mode === "pull-create-unknown") fixture.state.fail = "create-cut";
      const result = await processTaskPullDelivery(broker, () => githubMasterKey(path.join(root, "push-history-master.key")), { transport: fixture.transport, afterClaim: async job => { assert.equal(job, id); } });
      console.log(JSON.stringify({ ...result, writeTokens: fixture.state.issued, createRequests: fixture.state.creates }));
    } finally { await fixture.close(); }
  } else if (["pull-observe", "pull-observe-merged", "pull-observe-missing"].includes(mode)) {
    const row = (await admin.query("SELECT j.admission,p.attempt FROM collab_git.pull_observation_jobs j JOIN collab_git.pull_proposals p ON p.id=j.change_id WHERE j.id=$1", [id])).rows[0]; assert.ok(row);
    const pem = await readPrivateGitHubFile(path.join(root, "push-history.pem")), privateKey = createPrivateKey(pem); pem.fill(0);
    const fixture = await githubPullFixture(path.join(root, "push-history-http"), row.attempt, "observe", { privateKey, publicKey: createPublicKey(privateKey) }, app);
    try {
      fixture.state.number = row.admission.identity.number; await fixture.seedObservation();
      fixture.state.installPulls = "read";
      if ((await admin.query("SELECT 1 FROM collab_git.pull_releases WHERE change_id=$1 AND status='ready'",[row.admission.changeId])).rowCount) fixture.created[0].draft=false;
      if (mode === "pull-observe-merged") fixture.state.mutateRead = { state: "closed", merged: true, draft: false, merge_commit_sha: row.attempt.intent.headSha };
      if (mode === "pull-observe-missing") fixture.state.fail = "read-missing";
      const result = await processPullObservation(broker, () => githubMasterKey(path.join(root, "push-history-master.key")), { transport: fixture.transport, afterClaim: async job => { assert.equal(job, id); } });
      assert.equal(fixture.state.creates, 0);
      console.log(JSON.stringify({ ...result, readTokens: fixture.state.issued, readRequests: fixture.state.reads, createRequests: fixture.state.creates }));
    } finally { await fixture.close(); }
  } else if (mode === "pull-release") {
    const row=(await admin.query("SELECT j.action,j.admission,p.attempt FROM collab_git.pull_releases j JOIN collab_git.pull_proposals p ON p.id=j.change_id WHERE j.id=$1",[id])).rows[0];assert.ok(row);
    const pem=await readPrivateGitHubFile(path.join(root,"push-history.pem")),privateKey=createPrivateKey(pem);pem.fill(0);
    const fixture=await githubPullFixture(path.join(root,"push-history-http"),row.attempt,row.action,{privateKey,publicKey:createPublicKey(privateKey)},app);
    try {await fixture.seedObservation();fixture.created[0].draft=row.admission.snapshot.draft;
      const result=await processPullRelease(broker,()=>githubMasterKey(path.join(root,"push-history-master.key")),{transport:fixture.transport});assert.equal(result.jobId,id);console.log(JSON.stringify(result));
    }finally{await fixture.close();}
  } else if (mode === "pull-revision") {
    const row = (await admin.query("SELECT admission FROM collab_git.pull_revision_jobs WHERE id=$1", [id])).rows[0]; assert.ok(row);
    const pem = await readPrivateGitHubFile(path.join(root, "push-history.pem")), privateKey = createPrivateKey(pem); pem.fill(0);
    const fixture = await githubPushFixture(path.join(root, "push-history-http"), row.admission.binding, "refs/heads/unused-read-only", "read", { privateKey, publicKey: createPublicKey(privateKey) }, app);
    try {
      const result = await processPullRevision(broker, root, () => githubMasterKey(path.join(root, "push-history-master.key")), { transport: fixture.transport, afterClaim: async job => { assert.equal(job, id); } });
      assert.equal(fixture.git.calls.receive, 0);
      console.log(JSON.stringify({ ...result, readTokens: fixture.state.issued, receiveRequests: fixture.git.calls.receive }));
    } finally { await fixture.close(); }
  } else if (["pull-checks", "pull-checks-failed"].includes(mode)) {
    const row = (await admin.query("SELECT j.admission,p.attempt FROM collab_git.pull_checks_jobs j JOIN collab_git.pull_revision_jobs r ON r.id=j.revision_id JOIN collab_git.pull_proposals p ON p.id=r.change_id WHERE j.id=$1", [id])).rows[0]; assert.ok(row);
    const pem = await readPrivateGitHubFile(path.join(root, "push-history.pem")), privateKey = createPrivateKey(pem); pem.fill(0);
    const fixture = await githubPullFixture(path.join(root, "push-history-http"), row.attempt, "checks", { privateKey, publicKey: createPublicKey(privateKey) }, app);
    try {
      fixture.state.number = row.admission.identity.number; await fixture.seedObservation();
      if ((await admin.query("SELECT 1 FROM collab_git.pull_releases WHERE change_id=$1 AND status='ready'",[row.admission.changeId])).rowCount) fixture.created[0].draft=false;
      if (mode === "pull-checks-failed") fixture.state.checks[0].conclusion = "failure";
      const result = await processPullChecks(broker, () => githubMasterKey(path.join(root, "push-history-master.key")), { transport: fixture.transport, afterClaim: async job => { assert.equal(job, id); } });
      assert.equal(fixture.state.creates, 0);
      console.log(JSON.stringify({ ...result, readTokens: fixture.state.issued, checkReads: fixture.state.checkReads, createRequests: fixture.state.creates }));
    } finally { await fixture.close(); }
  } else if (["webhook-checks", "webhook-code"].includes(mode)) {
    const row = (await admin.query("SELECT r.change_id,r.manifest,c.pull_id FROM collab_git.pull_revision_jobs r JOIN collab_git.pull_changes c ON c.id=r.change_id WHERE r.id=$1", [id])).rows[0]; assert.ok(row);
    const event = mode === "webhook-checks" ? "check_run" : "pull_request";
    const body = { installation: { id: Number(app.installationId) }, repository: { id: Number(row.manifest.input.githubRepositoryId), owner: { id: Number(app.accountId) } },
      ...(event === "check_run" ? { action: "rerequested", check_run: { id: 71001, head_sha: row.manifest.input.headSha } }
        : { action: "synchronize", pull_request: { id: Number(row.pull_id), head: { sha: row.manifest.input.headSha }, base: { repo: { id: Number(row.manifest.input.githubRepositoryId) } } } }) };
    const secret = await readPrivateGitHubFile(path.join(root,"push-history-webhook.key"),256), bytes = Buffer.from(JSON.stringify(body));
    const signature = "sha256="+createHmac("sha256",secret).update(bytes).digest("hex"); secret.fill(0);
    const endpoint = new URL("/api/collab/github-webhooks/"+app.appId, process.env.PI_COLLAB_E2E_URL!);
    assert.equal(endpoint.hostname,"127.0.0.1");
    const delivery = randomUUID(); const send = () => fetch(endpoint,{ method:"POST",headers:{"content-type":"application/json","x-github-event":event,"x-github-delivery":delivery,"x-hub-signature-256":signature},body:bytes });
    assert.equal((await send()).status,202); assert.equal((await send()).status,202);
    console.log(JSON.stringify({ accepted:true, changeId:row.change_id, event }));
  } else if (mode === "corrupt") {
    const record = (await admin.query("SELECT id FROM collab_git.push_previews WHERE id=$1 AND status='ready'", [id])).rows[0]; assert.ok(record);
    await writeFile(path.join(root, "task-push-exports", id, "manifest.json"), "{}"); console.log(JSON.stringify({ changed: true }));
  } else throw new Error("Unsupported isolated fixture mode");
} finally { await store.close(); await admin.end(); await broker.end(); }
