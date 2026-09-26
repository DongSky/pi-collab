import { serviceSource, emptyPackage, emptyLock } from "../tests/collab/fixtures/service-source";
import {writeEnvironmentFixture} from "../tests/collab/fixtures/environment";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { z } from "zod";
import { localConfig, connectionString, executorConnectionString } from "./local-config";
import { importLocalRepository } from "../lib/collab/repository-import";
import { ExecutionStore } from "../lib/collab/execution-store";
import { executeClaim } from "../lib/collab/executor";
import { runtimeBackend } from "../lib/collab/runtime/backends";
import { processSnapshots } from "../lib/collab/snapshots";
import { executeValidation } from "../lib/collab/validation-worker";
import { coordinate } from "../lib/collab/coordination-server";

// Disposable browser acceptance only: real Pi/tools and snapshots, no model inference.
const databaseName = process.env.PI_COLLAB_E2E_DATABASE ?? "", root = process.env.PI_COLLAB_E2E_DATA ?? "";
if (!/^pi_collab_test_[a-f0-9]+$/.test(databaseName) || !path.basename(root).startsWith("identity-e2e-")) throw new Error("Isolated browser fixture required");
const executionMode=process.env.PI_COLLAB_RUNTIME==="docker"?"docker":"native";
const config = await localConfig(), store = new ExecutionStore(executorConnectionString(config, databaseName));
const admin = new Pool({ connectionString: connectionString(config, true, databaseName) }), mode = process.argv[2];
try {
  if (mode === "init" || mode === "init-environment") {
    const projectId = z.uuid().parse(process.argv[3]), project = (await admin.query("SELECT created_by FROM collab.projects WHERE id=$1", [projectId])).rows[0];
    const source = path.join(root, "snapshot-source"), exec = promisify(execFile); await mkdir(source);
    for (const args of [["init"], ["config", "user.name", "Browser snapshot test"], ["config", "user.email", "snapshot@test.invalid"]]) await exec("git", args, { cwd: source });
    await writeFile(path.join(source, "code.txt"), "baseline\n"); if(mode === "init-environment") await writeEnvironmentFixture(source); await exec("git", ["add", "."], { cwd: source }); await exec("git", ["commit", "-m", "Baseline"], { cwd: source });
    const imported = await importLocalRepository(admin, root, { projectId, actorId: project.created_by, source, name: "Snapshot acceptance repository" });
    console.log(JSON.stringify(imported));
  } else if (mode === "terminal") {
    const taskId=z.uuid().parse(process.argv[3]),executor=randomUUID(),claim=await store.claim(executor,executionMode);assert.ok(claim);assert.equal(claim.run.task_id,taskId);assert.equal(claim.run.execution_kind,"terminal");
    const outcome=await executeClaim(store,executor,claim,{dataRoot:root,backend:runtimeBackend(executionMode),timeoutMs:120000});
    assert.ok(["completed","cancelled"].includes(outcome),JSON.stringify((await admin.query("SELECT summary FROM collab.runs WHERE id=$1",[claim.run.id])).rows[0]));console.log(JSON.stringify({runId:claim.run.id,workspaceId:claim.workspace.id,outcome}));
  } else if (mode === "environment") {
    const taskId=z.uuid().parse(process.argv[3]),executor=randomUUID(),claim=await store.claim(executor,executionMode);assert.ok(claim);assert.equal(claim.run.task_id,taskId);
    const status=await executeClaim(store,executor,claim,{dataRoot:root,backend:runtimeBackend(executionMode),gatewayUrl:`http://127.0.0.1:${config.gatewayPort}/v1`,driver:async agent=>{const result=await agent.peer.command("bash",{command:"node -e \"require('node:assert/strict').equal(require('collab-fixture-helper'),42)\""});assert.equal((result.data as {exitCode:number}).exitCode,0);return {kind:"browser-environment-diagnostic",modelInference:false};}});
    assert.equal(status,"completed",JSON.stringify((await admin.query("SELECT summary FROM collab.runs WHERE id=$1",[claim.run.id])).rows[0]));console.log(JSON.stringify({runId:claim.run.id,workspaceId:claim.workspace.id}));
  } else if (mode === "capture") {
    await processSnapshots(store, root); console.log(JSON.stringify({ captured: true }));
  } else if (mode === "validate") {
    const claim = await store.claimValidation(randomUUID()); assert.ok(claim);
    const outcome = await executeValidation(store, claim, root);
    console.log(JSON.stringify({ validationId: claim.id, outcome }));
  } else if (mode === "waiting") {
    assert.equal(await store.claim(randomUUID(), executionMode), null); console.log(JSON.stringify({ waiting: true }));
  } else if (mode === "contract") {
    const taskId = z.uuid().parse(process.argv[3]), executor = randomUUID(), claim = await store.claim(executor, executionMode);
    assert.ok(claim); assert.equal(claim.run.task_id, taskId); assert.equal(claim.contracts?.length, 1);
    const pin = claim.contracts![0];
    const outcome = await executeClaim(store, executor, claim, { dataRoot: root, backend: runtimeBackend(executionMode), gatewayUrl: `http://127.0.0.1:${config.gatewayPort}/v1`, driver: async (agent, _claim, workspace) => {
      const pins = JSON.parse(await readFile(path.join(workspace.root, "contracts.json"), "utf8")); assert.equal(pins[0].revisionId, pin.revisionId); assert.ok(JSON.parse(pins[0].body).mockJson);
      await writeFile(path.join(workspace.checkout, "check.cjs"), `const a=require('node:assert/strict'),fs=require('node:fs');a.equal(JSON.parse(fs.readFileSync('../contracts.json','utf8'))[0].revisionId,${JSON.stringify(pin.revisionId)});`);
      await agent.peer.command("bash", { command: "cat ../contracts.json && node check.cjs" });
      // Explicit scoped-tool fixture; real Pi-dispatched tool calls have separate protocol acceptance.
      await coordinate(store, executor, claim.run.id, claim.run.epoch, "send_note", { targetTaskId: taskId, kind: "finding", body: "协作工具协议诊断记录：已读取固定契约。", resultIds: [], revisionIds: [pin.revisionId], idempotencyKey: randomUUID() });
      return { kind: "browser-contract-diagnostic", modelInference: false };
    } });
    assert.equal(outcome, "completed", JSON.stringify((await admin.query("SELECT summary FROM collab.runs WHERE id=$1", [claim.run.id])).rows[0])); console.log(JSON.stringify({ runId: claim.run.id, revisionId: pin.revisionId }));
  } else if (mode === "dependency") {
    const taskId = z.uuid().parse(process.argv[3]), executor = randomUUID(), claim = await store.claim(executor, executionMode);
    assert.ok(claim); assert.equal(claim.run.task_id, taskId); assert.equal(claim.dependencies?.length, 1);
    const pin = claim.dependencies![0]; assert.ok(pin.resultId);
    const outcome = await executeClaim(store, executor, claim, { dataRoot: root, backend: runtimeBackend(executionMode), driver: async (agent, _claim, workspace) => {
      assert.equal(await readFile(path.join(workspace.root, "dependencies", pin.taskId, "code.txt"), "utf8"), "working\n");
      await agent.peer.command("bash", { command: `test -f ../dependencies/${pin.taskId}/code.txt && cat ../dependencies/${pin.taskId}/code.txt` });
      return { kind: "browser-dependency-diagnostic", modelInference: false };
    } });
    assert.equal(outcome, "completed"); console.log(JSON.stringify({ runId: claim.run.id, resultId: pin.resultId }));
  } else if (mode === "preview" || mode === "run" || mode === "restore" || mode === "suggestion" || mode === "editor") {
    const taskId = z.uuid().parse(process.argv[3]), executor = randomUUID(), claim = await store.claim(executor, executionMode);
    assert.ok(claim); assert.equal(claim.run.task_id, taskId);
    const result = await executeClaim(store, executor, claim, { dataRoot: root, backend: runtimeBackend(executionMode), gatewayUrl: `http://127.0.0.1:${config.gatewayPort}/v1`, driver: async (agent, _claim, workspace) => {
      if(mode === "preview") {
        await writeFile(path.join(workspace.checkout,'server.cjs'),serviceSource);
        await writeFile(path.join(workspace.checkout,'package.json'),emptyPackage);
        await writeFile(path.join(workspace.checkout,'package-lock.json'),emptyLock);
        await mkdir(path.join(workspace.checkout,'preview'));
        await writeFile(path.join(workspace.checkout,'preview/index.html'),`<!doctype html><html><meta charset="utf-8"><title>Fixed checkpoint</title><link rel="stylesheet" href="style.css"><body><h1>已验证的固定页面</h1><button id="count">团队点击 0</button><p id="sandbox"></p><script src="app.js"></script></body></html>`);
        await writeFile(path.join(workspace.checkout,'preview/style.css'),'body{font:18px sans-serif;padding:24px;color:#16352b;background:#e9f6ef}button{padding:12px}');
        await writeFile(path.join(workspace.checkout,'preview/app.js'),`let n=0;document.querySelector('#count').onclick=()=>document.querySelector('#count').textContent='团队点击 '+(++n);try{document.cookie;document.querySelector('#sandbox').textContent='cookie access allowed';}catch{document.querySelector('#sandbox').textContent='沙箱阻止 Cookie 访问';}`);
        await writeFile(path.join(workspace.checkout,'check.cjs'),"require('node:assert/strict').match(require('node:fs').readFileSync('preview/index.html','utf8'),/已验证的固定页面/)");
        await agent.peer.command('bash',{command:'node check.cjs'});
      } else if (mode === "run") {
        await agent.peer.command("bash", { command: 'printf "staged\\n" > code.txt; git add code.txt; printf "working\\n" > code.txt; printf "handoff\\n" > new.txt; printf "private-value\\n" > .env' });
      } else if (mode === "editor") {
        const text=await readFile(path.join(workspace.checkout,"code.txt"),"utf8");assert.match(text,/Alice/);assert.match(text,/Bob/);
        await agent.peer.command("get_state",{});
      } else if (mode === "suggestion") {
        assert.equal(await readFile(path.join(workspace.checkout, "code.txt"), "utf8"), "reviewed\n");
        await agent.peer.command("get_state", {});
      } else {
        assert.equal(await readFile(path.join(workspace.checkout, "code.txt"), "utf8"), "working\n");
        assert.equal(await readFile(path.join(workspace.checkout, "new.txt"), "utf8"), "handoff\n");
        await assert.rejects(readFile(path.join(workspace.checkout, ".env")), /ENOENT/);
        await agent.peer.command("bash", { command: 'test "$(git show :code.txt)" = staged && printf "restored-code-verified\\n"' });
      }
      return { kind: "browser-snapshot-rpc-diagnostic", modelInference: false };
    } });
    assert.equal(result, "completed", JSON.stringify((await admin.query("SELECT status,stop_reason,summary FROM collab.runs WHERE id=$1", [claim.run.id])).rows[0])); console.log(JSON.stringify({ runId: claim.run.id, workspaceId: claim.workspace.id }));
  } else throw new Error("Unsupported fixture action");
} finally { await store.close(); await admin.end(); }
