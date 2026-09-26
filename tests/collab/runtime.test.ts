import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NativeRuntimeBackend, runtimeBackend, type AgentProcess } from "../../lib/collab/runtime/backends";
import { createWorkspace, runnerEnvironment } from "../../lib/collab/runtime/workspace";

const exec = promisify(execFile);
const root = await mkdtemp(path.join(tmpdir(), "pi-collab-runtime-"));
const repository = path.join(root, "source");
const running: AgentProcess[] = [];
before(async () => {
  await mkdir(repository);
  for (const args of [["init"], ["config", "user.name", "Runtime test"], ["config", "user.email", "test@pi-collab.invalid"]]) await exec("git", args, { cwd: repository });
  await writeFile(path.join(repository, "shared.txt"), "base\n");
  await exec("git", ["add", "shared.txt"], { cwd: repository });
  await exec("git", ["commit", "-m", "test baseline"], { cwd: repository });
});
after(async () => { await Promise.all(running.map(agent => agent.stop())); await rm(root, { recursive: true, force: true }); });

test("native is the default and an unknown backend fails closed", () => {
  assert.equal(runtimeBackend("native").isolation, "trusted-local-process");
  assert.equal(runtimeBackend("docker").isolation, "container");
  assert.throws(() => runtimeBackend("surprise"), /Unknown runtime/);
});

test("two real Pi RPC processes run concurrently in independent clones and profiles", { timeout: 45_000 }, async () => {
  const [a, b] = await Promise.all([randomUUID(), randomUUID()].map(id => createWorkspace(root, id, repository)));
  const backend = new NativeRuntimeBackend();
  const agents = await Promise.all([a, b].map(workspace => backend.start(workspace)));
  running.push(...agents);
  assert.ok(agents.every(agent => agent.peer.alive));
  assert.notEqual(agents[0].peer.pid, agents[1].peer.pid);
  const states = await Promise.all(agents.map(agent => agent.peer.command("get_state")));
  const stateA = states[0].data as { sessionId: string; sessionFile: string };
  const stateB = states[1].data as { sessionId: string; sessionFile: string };
  assert.notEqual(stateA.sessionId, stateB.sessionId);
  assert.ok(stateA.sessionFile.startsWith(a.agentDir));
  assert.ok(stateB.sessionFile.startsWith(b.agentDir));
  const results = await Promise.all(agents.map((agent, index) => agent.peer.command("bash", {
    command: `node -e 'const fs=require("fs");const start=Date.now();setTimeout(()=>{fs.writeFileSync("shared.txt","writer-${index}\\n");process.stdout.write(JSON.stringify({start,end:Date.now()}));},500);'`,
  })));
  const intervals = results.map(result => JSON.parse((result.data as { output: string }).output) as { start: number; end: number });
  assert.ok(Math.max(...intervals.map(t => t.start)) < Math.min(...intervals.map(t => t.end)), "both agents must execute during an overlapping interval");
  assert.equal((results[0].data as { exitCode: number }).exitCode, 0);
  assert.equal((results[1].data as { exitCode: number }).exitCode, 0);
  assert.equal(await readFile(path.join(a.checkout, "shared.txt"), "utf8"), "writer-0\n");
  assert.equal(await readFile(path.join(b.checkout, "shared.txt"), "utf8"), "writer-1\n");
  assert.equal(await readFile(path.join(repository, "shared.txt"), "utf8"), "base\n");
  assert.equal((await exec("git", ["remote"], { cwd: a.checkout })).stdout, "");
  assert.notEqual((await stat(path.join(a.checkout, ".git"))).ino, (await stat(path.join(b.checkout, ".git"))).ino);
  await Promise.all(agents.map(agent => agent.stop()));
  assert.ok(agents.every(agent => !agent.peer.alive));
});

test("runner environment does not inherit host secrets, shell startup hooks or SSH sockets", () => {
  const previous = process.env.PI_COLLAB_TEST_SECRET;
  process.env.PI_COLLAB_TEST_SECRET = "must-not-be-inherited";
  try {
    const env = runnerEnvironment("/workspace-home", "/workspace-agent");
    assert.equal(env.PI_COLLAB_TEST_SECRET, undefined);
    for (const name of ["DATABASE_URL", "BETTER_AUTH_SECRET", "SSH_AUTH_SOCK", "BASH_ENV", "NODE_OPTIONS", "OPENAI_API_KEY"]) assert.equal(env[name], undefined);
    assert.equal(env.HOME, "/workspace-home");
    assert.equal(env.PI_CODING_AGENT_DIR, "/workspace-agent");
  } finally {
    if (previous === undefined) delete process.env.PI_COLLAB_TEST_SECRET;
    else process.env.PI_COLLAB_TEST_SECRET = previous;
  }
});

test("workspace provisioning rejects path-like IDs and never reuses an existing writable directory", async () => {
  await assert.rejects(createWorkspace(root, "../../outside", repository));
  const id = randomUUID();
  await createWorkspace(root, id, repository);
  await assert.rejects(createWorkspace(root, id, repository), /EEXIST/);
  await assert.rejects(createWorkspace(root, randomUUID(), repository, "HEAD; whoami"), /complete commit SHA/);
});
