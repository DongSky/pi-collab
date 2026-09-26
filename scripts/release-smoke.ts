import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import path from "node:path";
import { Pool } from "pg";
import { verifyRelease } from "./release.mjs";

// Installed, verified production artifacts only. Never use development data.
const manifest = await verifyRelease();
const runtime = process.env.PI_COLLAB_RUNTIME === "docker" ? "docker" : "native";
const root = await mkdtemp(path.join(tmpdir(), "pi-collab-release-smoke-"));
async function port() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const result = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return result;
}
Object.assign(process.env, {
  PI_COLLAB_DATA_DIR: root, PI_COLLAB_DEPLOYMENT: "production", PI_COLLAB_RUNTIME: runtime,
  PI_COLLAB_PUBLIC_ORIGIN: "https://collab.test.invalid", PI_COLLAB_PREVIEW_ORIGIN: "https://preview.test.invalid",
  SMTP_URL: "smtps://127.0.0.1:1", SMTP_FROM: "fixture@test.invalid",
});
const { localConfig, applicationEnvironment, connectionString } = await import("./local-config");
const config = await localConfig(), ports = new Set<number>();
while (ports.size < 3) ports.add(await port());
[config.port, config.gatewayPort, config.databasePort] = [...ports];
await writeFile(path.join(root, "config.json"), JSON.stringify(config), { mode: 0o600 });
Object.assign(process.env, applicationEnvironment(config));
const { database, asUser } = await import("../lib/collab/database");
const log = await open(path.join(root, "smoke.log"), "w", 0o600);
let service: ReturnType<typeof spawn> | undefined, exited: Promise<unknown> | undefined, admin: Pool | undefined;
let stopped = true, success = false;
async function command(script: string, args: string[] = []) {
  const child = spawn(process.execPath, ["--import", "tsx", script, ...args], { env: process.env, stdio: ["ignore", log.fd, log.fd] });
  const code = await new Promise(resolve => { child.once("error", () => resolve(-1)); child.once("exit", resolve); });
  assert.equal(code, 0, `Release smoke command failed: ${script}`);
}
async function poll(check: () => Promise<boolean>, description: string, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (service && service.exitCode !== null) throw new Error("Installed production supervisor exited early");
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(description);
}
async function start() {
  service = spawn(process.execPath, ["--import", "tsx", runtime === "docker" ? "scripts/dev-docker.ts" : "scripts/dev-local.ts"], { env: process.env, stdio: ["ignore", log.fd, log.fd] });
  exited = new Promise(resolve => { service!.once("error", resolve); service!.once("exit", resolve); }); stopped = false;
  await poll(async () => {
    try { const r = await fetch(`http://127.0.0.1:${config.port}/sign-in`, { signal: AbortSignal.timeout(1500) }); return r.status === 200 && (await r.text()).includes("pi-collab"); }
    catch { return false; }
  }, "Installed production login did not become ready");
  const response = await fetch(`http://127.0.0.1:${config.port}/`, { redirect: "manual" });
  assert.ok([302,303,307,308].includes(response.status), "Anonymous project access must redirect");
  assert.equal((await fetch(`http://127.0.0.1:${config.port}/api/collab/projects`)).status, 401);
  admin = new Pool({ connectionString: connectionString(config, true) });
}
async function stop() {
  await admin?.end(); admin = undefined;
  if (globalThis.__piCollabPool) { await database().end(); globalThis.__piCollabPool = undefined; }
  if (!service || stopped) return;
  service.kill("SIGTERM");
  await Promise.race([exited, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Production supervisor did not stop")), 15000); timer.unref(); })]);
  stopped = true;
}
try {
  await command("scripts/operations.ts", ["upgrade"]);
  await start();
  const { provisioningAuth } = await import("../lib/collab/auth");
  const { createProject } = await import("../lib/collab/projects");
  const { createTask } = await import("../lib/collab/tasks");
  const { startRun, runDetail } = await import("../lib/collab/runs");
  const { requestSnapshot } = await import("../lib/collab/snapshots");
  const { importLocalRepository } = await import("../lib/collab/repository-import");
  const user = (await provisioningAuth(admin!).api.signUpEmail({ body: { name: "Release acceptance", email: "release@test.invalid", password: randomBytes(24).toString("hex") } })).user.id;
  const organization = randomUUID();
  await admin!.query("INSERT INTO collab.organizations(id,name,created_by) VALUES($1,'Isolated release acceptance',$2)", [organization,user]);
  await admin!.query("INSERT INTO collab.memberships(organization_id,user_id,role) VALUES($1,$2,'owner')", [organization,user]);
  await admin!.query('UPDATE public."user" SET "twoFactorEnabled"=true WHERE id=$1', [user]);
  const project = await createProject(user, { organizationId: organization, name: "Persistent installation", description: "" });
  const task = await createTask(user, project.id, { title: "Production executor acceptance", description: "", acceptance: "Keep bytes and snapshots across a complete restart" });
  const source = path.join(root,"source"), exec = promisify(execFile); await mkdir(source);
  for (const args of [["init"],["config","user.name","Release acceptance"],["config","user.email","release@test.invalid"]]) await exec("git", args, { cwd: source });
  await writeFile(path.join(source,"baseline.txt"),"baseline\n"); await exec("git",["add","."],{cwd:source}); await exec("git",["commit","-m","Baseline"],{cwd:source});
  const repository = await importLocalRepository(admin!,root,{projectId:project.id,actorId:user,source,name:"Release source"});
  async function terminal(snapshotId?: string) {
    const version = (await admin!.query("SELECT version FROM collab.tasks WHERE id=$1",[task.id])).rows[0].version;
    const accepted = await startRun(user,task.id,{repositoryId:repository.id,baseSha:repository.baseSha,prompt:"Installed production terminal diagnostic",expectedVersion:version,idempotencyKey:randomUUID(),executionKind:"terminal",...(snapshotId?{snapshotId}:{})});
    await poll(async()=>{const r=(await runDetail(user,accepted.runId)).run;assert.ok(!["failed","cancelled","reconciling"].includes(r.status),"Production terminal did not start");return r.status==="running";},"Production terminal did not become ready");
    const data = snapshotId ? "printf 'after-restart\\n' >> release.txt; exit\r" : "printf 'before-restart\\n' > release.txt; exit\r";
    await asUser(user,db=>db.query("SELECT collab.submit_terminal_input($1,'1',$2,$3)",[accepted.runId,randomUUID(),{type:"input",data}]));
    await poll(async()=>{const r=(await runDetail(user,accepted.runId)).run;assert.ok(!["failed","cancelled","reconciling"].includes(r.status),"Production terminal did not finish cleanly");return r.status==="completed";},"Production terminal completion timed out");
    const row=(await admin!.query("SELECT r.workspace_id,w.runtime FROM collab.runs r JOIN collab.workspaces w ON w.id=r.workspace_id WHERE r.id=$1",[accepted.runId])).rows[0];assert.equal(row.runtime,runtime);
    const file=path.join(root,"workspaces",row.workspace_id,"checkout/release.txt");
    assert.equal(await readFile(file,"utf8"),snapshotId?"before-restart\nafter-restart\n":"before-restart\n");
    return {runId:accepted.runId,file};
  }
  const first = await terminal(), detail = (await runDetail(user,first.runId)).run;
  const snapshot = await requestSnapshot(user,first.runId,{expectedRevision:detail.revision,idempotencyKey:randomUUID(),note:"Verify persisted production snapshot on restart"});
  await poll(async()=>{const s=(await admin!.query("SELECT status FROM collab.snapshots WHERE id=$1",[snapshot.snapshotId])).rows[0];assert.notEqual(s.status,"failed");return s.status==="ready";},"Production snapshot was not captured");
  await command("scripts/operations.ts",["status"]);
  await command("scripts/operations.ts",["drain","--reason","Restart isolated production installation and preserve its test data"]);
  await stop();
  const { makeManifest } = await import("./operations-core");
  assert.equal((await makeManifest(root,[])).commit,manifest.commit);
  assert.equal((await readFile(path.join(root,"postgres/PG_VERSION"),"utf8")).trim(),"18");
  await start();
  assert.equal((await admin!.query("SELECT draining FROM collab_meta.operations WHERE singleton")).rows[0].draining,true);
  assert.equal(await readFile(first.file,"utf8"),"before-restart\n");
  await command("scripts/operations.ts",["resume","--reason","Persistent project, drain flag and workspace survived restart"]);
  await terminal(snapshot.snapshotId);
  await command("scripts/check-deployment.ts");
  await command("scripts/operations.ts",["drain","--reason","Installed artifact acceptance completed without user data"]);
  await stop(); success=true;
  console.log(`PASS: installed ${runtime} production artifact starts, protects routes, executes a real terminal via its persistent daemon, captures/restores a snapshot after full restart, preserves drain and database/files, verifies gitless backup identity and stops. No external inference, SMTP delivery or public ingress tested.`);
} finally {
  if (!stopped) await stop().catch(()=>{});
  await log.close();
  if (stopped && success) await rm(root,{recursive:true,force:true});
  else console.error("Release smoke failed; isolated data and private log retained at "+root);
}
