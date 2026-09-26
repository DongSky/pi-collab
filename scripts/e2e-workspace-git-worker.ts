import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { z } from "zod";
import { localConfig, connectionString, executorConnectionString, gitConnectionString } from "./local-config";
import { importLocalRepository } from "../lib/collab/repository-import";
import { ExecutionStore } from "../lib/collab/execution-store";
import { executeClaim } from "../lib/collab/executor";
import { runtimeBackend } from "../lib/collab/runtime/backends";
import { processWorkspaceGit } from "../lib/collab/git/workspace-broker";

const databaseName = process.env.PI_COLLAB_E2E_DATABASE ?? "", root = process.env.PI_COLLAB_E2E_DATA ?? "";
if (!/^pi_collab_test_[a-f0-9]+$/.test(databaseName) || !path.basename(root).startsWith("identity-e2e-")) throw new Error("Isolated browser fixture required");
const config = await localConfig(), store = new ExecutionStore(executorConnectionString(config, databaseName));
const admin = new Pool({ connectionString: connectionString(config, true, databaseName) }), broker = new Pool({ connectionString: gitConnectionString(config, databaseName) });
const mode = process.argv[2], id = z.uuid().parse(process.argv[3]), exec = promisify(execFile);
try {
  if (mode === "init") {
    const project = (await admin.query("SELECT created_by FROM collab.projects WHERE id=$1", [id])).rows[0], source = path.join(root, "workspace-git-source"); await mkdir(source);
    for (const args of [["init", "-b", "main"], ["config", "user.name", "Browser Git fixture"], ["config", "user.email", "fixture@test.invalid"]]) await exec("git", args, { cwd: source });
    await writeFile(path.join(source, "code.txt"), Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\r\n"));
    await exec("git", ["add", "."], { cwd: source }); await exec("git", ["commit", "-m", "Browser baseline"], { cwd: source });
    console.log(JSON.stringify(await importLocalRepository(admin, root, { projectId: id, actorId: project.created_by, source, name: "Workspace Git browser fixture" })));
  } else if (mode === "run") {
    const executor = randomUUID(), claim = await store.claim(executor, process.env.PI_COLLAB_RUNTIME==="docker"?"docker":"native"); assert.ok(claim); assert.equal(claim.run.task_id, id);
    assert.equal(await executeClaim(store, executor, claim, { dataRoot: root, backend: runtimeBackend(), driver: async agent => {
      await agent.peer.command("bash", { command: `node -e 'const fs=require("fs"),lines=fs.readFileSync("code.txt","utf8").split("\\r\\n");lines[2]="chosen first change";lines[36]="remaining second change";fs.writeFileSync("code.txt",lines.join("\\r\\n"));fs.writeFileSync("binary.bin",Buffer.from([0,1,2,3]));fs.writeFileSync(".env","BROWSER_FIXTURE=excluded\\n");'` });
      return { kind: "browser-workspace-git", modelInference: false };
    } }), "completed");
    console.log(JSON.stringify({ runId: claim.run.id, workspaceId: claim.workspace.id }));
  } else if (mode === "process" || mode === "crash") {
    let result;
    try {
      result = await processWorkspaceGit(broker, root, { afterClaim: async job => { assert.equal(job, id); }, ...(mode === "crash" ? { beforeFinish: async () => {
        const row = (await admin.query("SELECT backend_pid FROM collab_git.workspace_operations WHERE id=$1", [id])).rows[0];
        await admin.query("SELECT pg_terminate_backend($1)", [row.backend_pid]); await new Promise(resolve => setTimeout(resolve, 50));
      } } : {}) });
    } catch (error) { if (mode !== "crash" || !(error instanceof Error) || error.message !== "workspace_git_outcome_unknown") throw error; result = await processWorkspaceGit(broker, root); }
    assert.equal(result.jobId, id); console.log(JSON.stringify(result));
  } else if (mode === "inspect" || mode === "edit" || mode === "secret") {
    const row = (await admin.query("SELECT workspace_id FROM collab.runs WHERE id=$1", [id])).rows[0], cwd = path.join(root, "workspaces", z.uuid().parse(row.workspace_id), "checkout");
    if (mode === "edit") await writeFile(path.join(cwd, "later.txt"), "changed outside preview\n");
    if (mode === "secret") await exec("git", ["add", ".env"], { cwd });
    const git = async (...args: string[]) => (await exec("git", args, { cwd })).stdout.trim();
    console.log(JSON.stringify({ head: await git("rev-parse", "HEAD"), staged: await git("show", ":code.txt"), count: await git("rev-list", "--count", "HEAD") }));
  } else throw new Error("Unsupported fixture action");
} finally { await store.close(); await admin.end(); await broker.end(); }
