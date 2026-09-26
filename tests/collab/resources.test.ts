import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";


import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer as createHttpServer } from "node:http";
import { once } from "node:events";
import { GatewayStore } from "../../lib/collab/gateway/store";
import { createModelGateway } from "../../lib/collab/gateway/server";
import { registerModelProfile } from "../../lib/collab/gateway/profiles";
import { createServer, createConnection, type Socket } from "node:net";
import { Pool, Client } from "pg";
import { localConfig, applicationEnvironment, connectionString, executorConnectionString, brokerConnectionString, gatewayConnectionString } from "../../scripts/local-config";
import { startNativeDatabase } from "../../scripts/native-database";
import { migrate } from "../../scripts/migrate";
import { provisioningAuth } from "../../lib/collab/auth";
import { asUser, database } from "../../lib/collab/database";
import { createProject } from "../../lib/collab/projects";
import { createTask } from "../../lib/collab/tasks";
import { startRun, stopRun } from "../../lib/collab/runs";
import { ExecutionStore, type ClaimedRun } from "../../lib/collab/execution-store";
import { executeClaim } from "../../lib/collab/executor";
import { NativeRuntimeBackend } from "../../lib/collab/runtime/backends";
import { importLocalRepository } from "../../lib/collab/repository-import";
import { coordinate } from "../../lib/collab/coordination-server";
import type { CoordinationMethod } from "../../lib/collab/coordination-schema";

const config = await localConfig(), databaseName = `pi_collab_test_${randomBytes(6).toString("hex")}`, native = await startNativeDatabase(config);
Object.assign(process.env, applicationEnvironment(config), { DATABASE_URL: connectionString(config, false, databaseName) });
const admin = new Pool({ connectionString: connectionString(config, true, databaseName) }), worker = new ExecutionStore(executorConnectionString(config, databaseName));
const root = await mkdtemp(path.join(tmpdir(), "pi-collab-resources-")), source = path.join(root, "source"), exec = promisify(execFile);
process.env.PI_COLLAB_DATA_DIR = root;
import { createResource, projectResources } from "../../lib/collab/resources";
import { ResourceStore } from "../../lib/collab/resources/store";
import { executeResourceJob } from "../../lib/collab/resources/worker";
import { openResourcePassword } from "../../lib/collab/resources/credentials";
const brokerStore = new ResourceStore(brokerConnectionString(config, databaseName)), brokerId = randomUUID(), key = randomBytes(32);
const organization = randomUUID(), executor = randomUUID(), users: string[] = [];
let project: string, repository: { id: string; baseSha: string };
before(async () => {
  await migrate(config, databaseName); const provision = provisioningAuth(admin);
  for (let i = 0; i < 4; i++) users.push((await provision.api.signUpEmail({ body: { name: `Coordination user ${i}`, email: `coordination${i}@test.invalid`, password: randomBytes(20).toString("hex") } })).user.id);
  await admin.query("INSERT INTO collab.organizations(id,name,created_by) VALUES($1,'Coordination test',$2)", [organization, users[0]]);
  for (let i = 0; i < 3; i++) await admin.query("INSERT INTO collab.memberships(organization_id,user_id,role) VALUES($1,$2,$3)", [organization, users[i], i === 0 ? "owner" : "member"]);
  await admin.query('UPDATE public."user" SET "twoFactorEnabled"=true WHERE id=$1', [users[0]]);
  project = (await createProject(users[0], { organizationId: organization, name: "Scoped coordination", description: "" })).id;
  for (let i = 1; i < 3; i++) await admin.query("INSERT INTO collab.project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,$4)", [organization, project, users[i], i === 2 ? "reviewer" : "developer"]);
  await mkdir(source); for (const args of [["init"], ["config", "user.name", "Coordination acceptance"], ["config", "user.email", "coordination@test.invalid"]]) await exec("git", args, { cwd: source });
  await writeFile(path.join(source, "code.txt"), "baseline\n");
  // An untrusted project extension must stay disabled while the managed extension loads.
  await mkdir(path.join(source, ".pi/extensions"), { recursive: true }); await writeFile(path.join(source, ".pi/extensions/untrusted.ts"), 'import {writeFileSync} from "node:fs";export default()=>writeFileSync("untrusted-loaded","bad");');
  await exec("git", ["add", "."], { cwd: source }); await exec("git", ["commit", "-m", "Baseline"], { cwd: source });
  repository = await importLocalRepository(admin, root, { projectId: project, actorId: users[0], source, name: "Coordination source" });
});
after(async () => {
  const roles = (await admin.query("SELECT role_name FROM collab_broker.credentials")).rows.map(r => r.role_name);
  await brokerStore.close(); await worker.close(); await database().end(); globalThis.__piCollabPool = undefined; await admin.end();
  const cleanup = new Pool({ connectionString: connectionString(config, true, "postgres") }); await cleanup.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`); for (const role of roles) { assert.match(role, /^pcr_[a-f0-9]{32}$/); await cleanup.query(`DROP ROLE "${role}"`); } await cleanup.end(); await native.stop(); await rm(root, { recursive: true, force: true });
});
afterEach(async () => {
  for (const r of (await admin.query("SELECT id,epoch::text,status FROM collab.runs WHERE status IN ('queued','starting','running','waiting_input','stopping')")).rows) {
    if (r.status === "queued") await stopRun(users[0], r.id, { idempotencyKey: randomUUID() });
    else await worker.finish(executor, r.id, r.epoch, "cancelled", {});
  }
  await brokerStore.claim(brokerId);
});
const task = (title: string, owner = users[1], projectId = project) => createTask(owner, projectId, { title, description: "", acceptance: "Scoped project data, never implicit authority" });
async function claimTask(taskId?: string, owner = users[1], modelProfileId?: string, running = true) {
  const t = taskId ?? (await task("Agent coordination", owner)).id;
  const version = (await admin.query("SELECT version FROM collab.tasks WHERE id=$1", [t])).rows[0].version;
  await startRun(owner, t, { repositoryId: repository.id, baseSha: repository.baseSha, prompt: "Coordinate this task", expectedVersion: version, idempotencyKey: randomUUID(), ...(modelProfileId ? { modelProfileId } : {}) });
  const claim = await worker.claim(executor, "native"); assert.ok(claim); assert.equal(claim.run.task_id, t);
  // These database-only claims have no files before executeClaim prepares them.
  await worker.recordWorkspaceUsage(claim.workspace.id, claim.run.epoch, { bytes: 0, error: null });
  if (running) await worker.running(executor, claim.run.id, claim.run.epoch); return claim;
}
const call = (c: ClaimedRun, method: CoordinationMethod, input: unknown = {}) => coordinate(worker, executor, c.run.id, c.run.epoch, method, input);

async function resource(name = "Managed database") {
 const result = await createResource(users[0], project, { name, idempotencyKey: randomUUID() }); await brokerStore.provision(key); return result.resourceId as string;
}
const request = (c: ClaimedRun, resourceIds: string[]) => call(c, "request_resource", { resourceIds, idempotencyKey: randomUUID() });
async function granted(c: ClaimedRun) { return (await call(c, "get_context")).resources.requests.find((r: {status:string})=>r.status === "granted"); }
async function sql(c: ClaimedRun, resourceId: string, text: string) {
 const lease = await granted(c); assert.ok(lease); const grant = lease.grants.find((g: {resourceId:string})=>g.resourceId===resourceId); assert.ok(grant);
 const job = await call(c, "execute_resource", { requestId: lease.id, resourceId, fence: grant.fence, sql: text, idempotencyKey: randomUUID() }); return job.jobId as string;
}
async function execute(jobId: string) {
 // A competing heartbeat may hold the organization lock. The real broker
 // retries a null claim; diagnostics must observe the same nonblocking protocol.
 let job: Awaited<ReturnType<ResourceStore["claim"]>>;
 await until(async()=>{job=await brokerStore.claim(brokerId);return job!==null;});
 assert.ok(job!); assert.equal(job.id, jobId);
 await executeResourceJob(brokerStore, job, key, undefined, 30);
 return (await admin.query("SELECT * FROM collab.resource_jobs WHERE id=$1", [jobId])).rows[0];
}
const release = (c: ClaimedRun, requestId: string) => call(c, "release_resource", { requestId, idempotencyKey: randomUUID() });
async function until(predicate:()=>Promise<boolean>, ms=5000) { const deadline=Date.now()+ms;while(!await predicate()){if(Date.now()>deadline)throw new Error("Timed out waiting for resource evidence");await new Promise(resolve=>setTimeout(resolve,20));} }

test("managed PostgreSQL resources require maintainer authority; credentials never reach app/executor roles and actual SQL persists", async () => {
 const input={name:"PostgreSQL integration schema",idempotencyKey:randomUUID()};
 const a=await createResource(users[0],project,input),b=await createResource(users[0],project,input);assert.equal(a.resourceId,b.resourceId);
 await assert.rejects(createResource(users[1],project,{...input,idempotencyKey:randomUUID()}),/forbidden/);await assert.rejects(projectResources(users[3],project),/not found|permission|forbidden/i);
 await brokerStore.provision(key);const resourceId=a.resourceId,c=await claimTask();await request(c,[resourceId]);
 const created=await execute(await sql(c,resourceId,"CREATE TABLE orders(id integer PRIMARY KEY, name text)"));assert.equal(created.status,"succeeded",JSON.stringify({error:created.error_code,result:created.result}));
 assert.equal((await execute(await sql(c,resourceId,"INSERT INTO orders VALUES(1,'first') RETURNING id,name"))).status,"succeeded");
 const selected=await execute(await sql(c,resourceId,"SELECT * FROM orders"));assert.deepEqual(selected.result.rows,[{id:1,name:"first"}]);assert.equal(selected.result.commitAcknowledged,true);assert.equal(selected.stopped,true);
 for(const pool of [database(),worker.pool])await assert.rejects(pool.query("SELECT * FROM collab_broker.credentials"),/permission/);
 await assert.rejects(brokerStore.pool.query('SELECT * FROM public."user"'),/permission/);
 const credential=(await admin.query("SELECT * FROM collab_broker.credentials WHERE resource_id=$1",[resourceId])).rows[0];
 assert.throws(()=>openResourcePassword(randomBytes(32),resourceId,project,credential.sealed));
 const row=(await projectResources(users[2],project)).resources.find(r=>r.id===resourceId);assert.equal(row?.status,"ready");assert.equal(JSON.stringify(row).includes("sealed"),false);
});

test("two runs request reversed resource sets atomically; only one writer is granted and the next holder fences out old work",async()=>{
 const x=await resource("Batch X"),y=await resource("Batch Y"),a=await claimTask(),b=await claimTask(undefined,users[0]);
 const requests=await Promise.all([request(a,[x,y]),request(b,[y,x])]);
 const ar=await granted(a),br=await granted(b);assert.equal(Number(!!ar)+Number(!!br),1);
 const first=ar?a:b,second=ar?b:a,lease=ar??br;
 assert.equal((await admin.query("SELECT count(*)::int AS n FROM collab.resources WHERE holder_id=$1",[lease.id])).rows[0].n,2);
 const waiting=requests.find(r=>r.requestId!==lease.id)!;assert.equal((await admin.query("SELECT count(*)::int AS n FROM collab.resources WHERE holder_id=$1",[waiting.requestId])).rows[0].n,0);
 const oldFence=lease.grants.find((g:{resourceId:string})=>g.resourceId===x).fence;
 assert.equal((await execute(await sql(first,x,"CREATE TABLE counter(value int)"))).status,"succeeded");
 await release(first,lease.id);const next=await granted(second);assert.ok(next);assert.ok(BigInt(next.grants.find((g:{resourceId:string})=>g.resourceId===x).fence)>BigInt(oldFence));
 await assert.rejects(call(first,"execute_resource",{requestId:lease.id,resourceId:x,fence:oldFence,sql:"DROP TABLE counter",idempotencyKey:randomUUID()}),/stale_resource_lease/);
 assert.equal((await execute(await sql(second,x,"INSERT INTO counter VALUES(2)"))).status,"succeeded");
 assert.deepEqual((await execute(await sql(second,x,"SELECT * FROM counter"))).result.rows,[{value:2}]);
});

test("broker claim skips a contended organization without losing the queued job",async()=>{
 const x=await resource("Contended dispatch"),c=await claimTask();await request(c,[x]);const jobId=await sql(c,x,"SELECT 73 AS value");
 const blocker=await admin.connect();
 try{
  await blocker.query("BEGIN");await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,811))",[organization]);
  assert.equal(await brokerStore.claim(brokerId),null);
  assert.equal((await admin.query("SELECT status FROM collab.resource_jobs WHERE id=$1",[jobId])).rows[0].status,"queued");
 }finally{await blocker.query("ROLLBACK");blocker.release();}
 assert.deepEqual((await execute(jobId)).result.rows,[{value:73}]);
});

test("waiting batches hold nothing, time out or cancel, and cannot acquire an additional partial lease",async()=>{
 const x=await resource("Wait X"),y=await resource("Wait Y"),a=await claimTask(),b=await claimTask(undefined,users[0]);await request(a,[x]);
 await assert.rejects(request(a,[y]),/resource_request_active/);
 const waiting=await request(b,[x,y]);assert.equal(await granted(b),undefined);
 assert.equal((await admin.query("SELECT holder_id FROM collab.resources WHERE id=$1",[y])).rows[0].holder_id,null);
 await admin.query("UPDATE collab.resource_requests SET wait_until=clock_timestamp()-interval '1 second' WHERE id=$1",[waiting.requestId]);await brokerStore.claim(brokerId);
 assert.equal((await admin.query("SELECT status FROM collab.resource_requests WHERE id=$1",[waiting.requestId])).rows[0].status,"timed_out");
 const next=await request(b,[x,y]);await release(b,next.requestId);assert.equal((await admin.query("SELECT status FROM collab.resource_requests WHERE id=$1",[next.requestId])).rows[0].status,"cancelled");
});

test("broker SQL cannot escape its role/schema or transaction and does not accept stale or cross-project IDs",async()=>{
 const x=await resource("SQL boundary"),y=await resource("Sibling boundary"),c=await claimTask();await request(c,[x,y]);
 const sibling=(await admin.query("SELECT schema_name FROM collab_broker.credentials WHERE resource_id=$1",[y])).rows[0].schema_name;
 for(const text of ['SELECT * FROM public."user"','SELECT * FROM collab_broker.credentials',`CREATE TABLE ${sibling}.forged(id int)`,'SELECT 1; COMMIT','/* outer /* nested */ comment */ COMMIT',"DO $$BEGIN COMMIT; END$$"]){const r=await execute(await sql(c,x,text));assert.notEqual(r.status,"succeeded",text);assert.equal(r.stopped,true);}
 assert.deepEqual((await execute(await sql(c,x,"SELECT 42 AS value"))).result.rows,[{value:42}]);
 const other=(await createProject(users[0],{organizationId:organization,name:"Other resource project",description:""})).id;
 const outside=await createResource(users[0],other,{name:"Foreign resource",idempotencyKey:randomUUID()});await release(c,(await granted(c)).id);
 await assert.rejects(request(c,[outside.resourceId]),/not_found/);
 await assert.rejects(asUser(users[1],db=>db.query("UPDATE collab.resources SET epoch=0")),/permission/);
});

test("an unknown real PostgreSQL writer prevents reassignment until its exact backend exits; uncommitted effects roll back",async()=>{
 const x=await resource("Unknown writer"),a=await claimTask(),b=await claimTask(undefined,users[0]);await request(a,[x]);
 await execute(await sql(a,x,"CREATE TABLE unknown_effect(value int)"));const jobId=await sql(a,x,"SELECT pg_sleep(30)"),job=await brokerStore.claim(brokerId);assert.equal(job?.id,jobId);assert.ok(job);
 const url=new URL(brokerStore.connectionString);url.username=job.roleName;url.password=openResourcePassword(key,job.resourceId,job.projectId,job.sealed);
 const client=new Client({connectionString:url.toString(),application_name:`pi-collab-job:${job.id}`});client.on("error",()=>{});await client.connect();
 await client.query("BEGIN");const pid=(await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;assert.equal(await brokerStore.bind(job,pid),true);
 await client.query(`INSERT INTO ${job.schemaName}.unknown_effect VALUES(7)`);const running=client.query("SELECT pg_sleep(30)").catch(()=>null);
 await request(b,[x]);await assert.rejects(brokerStore.finish(job,"succeeded",{command:"SELECT",rowCount:0,rows:[],sqlHash:createHash("sha256").update(job.sql).digest("hex"),commitAcknowledged:true},null),/resource_writer_present/);assert.equal(await granted(b),undefined);
 await admin.query("UPDATE collab.resource_jobs SET heartbeat_at=clock_timestamp()-interval '20 seconds' WHERE id=$1",[job.id]);
 await brokerStore.reconcile();await running;await client.end();await until(async()=>{await brokerStore.reconcile();return (await admin.query("SELECT stopped FROM collab.resource_jobs WHERE id=$1",[job.id])).rows[0].stopped;});
 assert.ok(await granted(b));assert.equal((await admin.query("SELECT status FROM collab.resource_jobs WHERE id=$1",[job.id])).rows[0].status,"unknown");
 await assert.rejects(brokerStore.finish(job,"succeeded",{},null),/stale_resource_job/);
 assert.deepEqual((await execute(await sql(b,x,"SELECT count(*)::int AS count FROM unknown_effect"))).result.rows,[{count:0}]);
});

test("stop and explicit job cancellation terminate actual SQL, preserve unknown outcomes and deny expired grants",async()=>{
 const x=await resource("Cancellation"),a=await claimTask(),b=await claimTask(undefined,users[0]);await request(a,[x]);
 const jobId=await sql(a,x,"SELECT pg_sleep(30)"),job=await brokerStore.claim(brokerId);assert.ok(job);const work=executeResourceJob(brokerStore,job,key,undefined,30);
 await until(async()=>(await admin.query("SELECT backend_pid IS NOT NULL AS bound FROM collab.resource_jobs WHERE id=$1",[jobId])).rows[0].bound);
 await request(b,[x]);await stopRun(users[1],a.run.id,{idempotencyKey:randomUUID()});assert.equal(await work,"unknown");await brokerStore.claim(brokerId);assert.ok(await granted(b));
 const next=await sql(b,x,"SELECT pg_sleep(30)"),nextJob=await brokerStore.claim(brokerId);assert.ok(nextJob);const cancelled=executeResourceJob(brokerStore,nextJob,key,undefined,30);
 await until(async()=>(await admin.query("SELECT backend_pid IS NOT NULL AS bound FROM collab.resource_jobs WHERE id=$1",[next])).rows[0].bound);
 await call(b,"cancel_resource_job",{jobId:next,idempotencyKey:randomUUID()});assert.equal(await cancelled,"cancelled");
 await admin.query("UPDATE collab.resource_requests SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[(await granted(b)).id]);
 await assert.rejects(call(b,"execute_resource",{requestId:nextJob.id,resourceId:x,fence:"1",sql:"SELECT 1",idempotencyKey:randomUUID()}),/not_found|stale_resource_lease/);
});

test("two native Pi processes hold independent files while requesting the same actual PostgreSQL resource",async()=>{
 const x=await resource("Native Pi resource"),a=await claimTask(undefined,users[1],undefined,false),b=await claimTask(undefined,users[0],undefined,false);
 let started=0;const entered:number[]=[],ended:number[]=[];
 const results=await Promise.all([a,b].map((c,index)=>executeClaim(worker,executor,c,{dataRoot:root,backend:new NativeRuntimeBackend(),heartbeatMs:50,driver:async(agent)=>{
  entered[index]=Date.now();started++;await until(async()=>started===2);
  const environment=await worker.runEnvironment(executor,c.run.id,c.run.epoch);assert.ok(environment);
  await agent.peer.command("bash",{command:`test "$PORT" = "${environment.port}" && test "$HOST" = "127.0.0.1" && test -z "$DATABASE_URL" && test -z "$PI_COLLAB_BROKER_DATABASE_URL" && printf 'resource-${index}' > code.txt`});
  const q=await request(c,[x]);await until(async()=>{await worker.renewResources(executor,c.run.id,c.run.epoch);return !!await granted(c);});
  const result=await execute(await sql(c,x,`SELECT ${index} AS actor`));assert.equal(result.status,"succeeded");
  await release(c,q.requestId);ended[index]=Date.now();return {kind:"native-resource-diagnostic",modelInference:false};
 }})));
 assert.deepEqual(results,["completed","completed"],JSON.stringify((await admin.query("SELECT summary FROM collab.runs WHERE id=ANY($1)",[[a.run.id,b.run.id]])).rows));assert.ok(Math.max(...entered)<Math.min(...ended));
 for(const [i,c]of[a,b].entries())assert.equal(await readFile(path.join(root,"workspaces",c.workspace.id,"checkout/code.txt"),"utf8"),`resource-${i}`);
});

test("a broker crash before backend binding invalidates its dispatch before another writer receives the resource",async()=>{
 const x=await resource("Dispatch gap"),a=await claimTask(),b=await claimTask(undefined,users[0]);await request(a,[x]);await sql(a,x,"SELECT 1");const job=await brokerStore.claim(brokerId);assert.ok(job);
 await assert.rejects(brokerStore.finish(job,"succeeded",{command:"SELECT",rowCount:1,rows:[{value:1}],sqlHash:createHash("sha256").update(job.sql).digest("hex"),commitAcknowledged:true},null),/invalid_resource/);
 await request(b,[x]);await admin.query("UPDATE collab.resource_jobs SET heartbeat_at=clock_timestamp()-interval '20 seconds' WHERE id=$1",[job.id]);await brokerStore.reconcile();assert.ok(await granted(b));
 const url=new URL(brokerStore.connectionString);url.username=job.roleName;url.password=openResourcePassword(key,job.resourceId,job.projectId,job.sealed);
 const late=new Client({connectionString:url.toString(),application_name:`pi-collab-job:${job.id}`});await late.connect();try{const pid=(await late.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;assert.equal(await brokerStore.bind(job,pid),false);}finally{await late.end();}
 assert.equal((await execute(await sql(b,x,"SELECT 2 AS value"))).result.rows[0].value,2);
});

test("a real network cut leaves the resource unavailable until a fresh broker confirms the old SQL backend exited",async()=>{
 const x=await resource("Network recovery"),a=await claimTask(),b=await claimTask(undefined,users[0]);await request(a,[x]);await sql(a,x,"SELECT pg_sleep(30)");const job=await brokerStore.claim(brokerId);assert.ok(job);
 let online=true;const sockets=new Set<Socket>();const proxy=createServer(client=>{if(!online){client.destroy();return;}const upstream=createConnection({host:"127.0.0.1",port:config.databasePort});for(const s of[client,upstream]){sockets.add(s);s.on("error",()=>{client.destroy();upstream.destroy();});s.on("close",()=>sockets.delete(s));}client.pipe(upstream).pipe(client);});await new Promise<void>(resolve=>proxy.listen(0,"127.0.0.1",resolve));
 const url=new URL(brokerStore.connectionString);url.port=String((proxy.address() as {port:number}).port);const offline=new ResourceStore(url.toString());
 try{const work=executeResourceJob(offline,job,key,undefined,30).then(()=>false,()=>true);await until(async()=>(await admin.query("SELECT backend_pid IS NOT NULL AS bound FROM collab.resource_jobs WHERE id=$1",[job.id])).rows[0].bound);await request(b,[x]);online=false;for(const socket of sockets)socket.destroy();assert.equal(await work,true);assert.equal(await granted(b),undefined);
 await admin.query("UPDATE collab.resource_jobs SET heartbeat_at=clock_timestamp()-interval '20 seconds' WHERE id=$1",[job.id]);await until(async()=>{await brokerStore.reconcile();return (await admin.query("SELECT stopped FROM collab.resource_jobs WHERE id=$1",[job.id])).rows[0].stopped;});assert.ok(await granted(b));
 }finally{for(const socket of sockets)socket.destroy();await offline.close();await new Promise<void>(resolve=>proxy.close(()=>resolve()));}
});

test("a committed SQL write with its actual COMMIT acknowledgement dropped remains unknown, never a safe-to-retry failure",async()=>{
 const x=await resource("Commit acknowledgement"),a=await claimTask();await request(a,[x]);await execute(await sql(a,x,"CREATE TABLE committed_effect(value int)"));await sql(a,x,"INSERT INTO committed_effect VALUES(17)");const job=await brokerStore.claim(brokerId);assert.ok(job);
 let dropped=false;const sockets=new Set<Socket>();const proxy=createServer(client=>{const upstream=createConnection({host:"127.0.0.1",port:config.databasePort});let tail=Buffer.alloc(0),commit=false;
 for(const s of[client,upstream]){sockets.add(s);s.on("error",()=>{client.destroy();upstream.destroy();});s.on("close",()=>sockets.delete(s));}
 client.on("data",chunk=>{const probe=Buffer.concat([tail,Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk)]);if(probe.includes(Buffer.from("COMMIT\0")))commit=true;tail=probe.subarray(Math.max(0,probe.length-32));upstream.write(chunk);});
 upstream.on("data",chunk=>{if(commit){dropped=true;client.destroy();upstream.destroy();}else client.write(chunk);});client.on("end",()=>upstream.end());upstream.on("end",()=>client.end());});await new Promise<void>(resolve=>proxy.listen(0,"127.0.0.1",resolve));
 const url=new URL(brokerStore.connectionString);url.port=String((proxy.address() as {port:number}).port);const transport=new ResourceStore(url.toString());
 try{assert.equal(await executeResourceJob(transport,job,key,undefined,50),"unknown");assert.equal(dropped,true);const row=(await admin.query(`SELECT value FROM "${job.schemaName}".committed_effect`)).rows;assert.deepEqual(row,[{value:17}]);assert.equal((await admin.query("SELECT status,stopped FROM collab.resource_jobs WHERE id=$1",[job.id])).rows[0].stopped,true);
 }finally{await transport.close();for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>proxy.close(()=>resolve()));}
});

test("real Pi invokes resource request, fenced SQL, cancellation and release through the managed extension with fixture model responses",async()=>{
 const x=await resource("Pi resource tools"),gatewayStore=new GatewayStore(gatewayConnectionString(config,databaseName)),gateway=createModelGateway(gatewayStore,key),secret=randomBytes(32).toString("hex"),t=await task("Pi resource protocol");
 let fixtureError:unknown;const jobs=new Set<Promise<unknown>>();let polling=false;
 const timer=setInterval(()=>{if(polling)return;polling=true;void (async()=>{await brokerStore.reconcile();const job=await brokerStore.claim(brokerId);if(job){const work=executeResourceJob(brokerStore,job,key,undefined,30).finally(()=>jobs.delete(work));jobs.add(work);}})().finally(()=>{polling=false;});},20);
 const upstream=createHttpServer((req,res)=>{void(async()=>{
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);assert.equal(req.headers.authorization,`Bearer ${secret}`);const body=JSON.parse(Buffer.concat(chunks).toString()),round=body.input.filter((i:{type:string})=>i.type==="function_call_output").length;
  const grant=async()=>{const r=(await admin.query("SELECT q.id,g.fence::text FROM collab.resource_requests q JOIN collab.resource_grants g ON g.request_id=q.id WHERE q.run_id=(SELECT id FROM collab.runs WHERE task_id=$1 ORDER BY created_at DESC LIMIT 1) AND q.status='granted'",[t.id])).rows[0];assert.ok(r);return r;};
  let name:string|undefined,args:Record<string,unknown>={};
  if(round===0){name="collab_request_resource";args={resourceIds:[x],idempotencyKey:randomUUID()};}
  if(round===1){name="collab_get_context";}
  if(round===2){const g=await grant();name="collab_execute_resource";args={requestId:g.id,resourceId:x,fence:g.fence,sql:"SELECT 91 AS proof",idempotencyKey:randomUUID()};}
  if(round===3){await until(async()=>(await admin.query("SELECT 1 FROM collab.resource_jobs WHERE resource_id=$1 AND status='succeeded'",[x])).rowCount===1);const g=await grant();name="collab_execute_resource";args={requestId:g.id,resourceId:x,fence:g.fence,sql:"SELECT pg_sleep(30)",idempotencyKey:randomUUID()};}
  if(round===4){await until(async()=>(await admin.query("SELECT 1 FROM collab.resource_jobs WHERE resource_id=$1 AND status='running' AND backend_pid IS NOT NULL",[x])).rowCount===1);const j=(await admin.query("SELECT id FROM collab.resource_jobs WHERE resource_id=$1 AND status='running'",[x])).rows[0];name="collab_cancel_resource_job";args={jobId:j.id,idempotencyKey:randomUUID()};}
  if(round===5){await until(async()=>(await admin.query("SELECT 1 FROM collab.resource_jobs WHERE resource_id=$1 AND status='cancelled' AND stopped",[x])).rowCount===1);name="collab_release_resource";args={requestId:(await grant()).id,idempotencyKey:randomUUID()};}
  if(round===6){name="collab_get_context";}
  const id=`resp_${randomUUID()}`,item=name?{type:"function_call",id:`fc_${round}`,call_id:`call_${round}`,name,arguments:JSON.stringify(args)}:{type:"message",id:"msg_done",role:"assistant",status:"completed",content:[{type:"output_text",text:"Local resource protocol fixture complete.",annotations:[]}]};
  res.writeHead(200,{"Content-Type":"text/event-stream"});const send=(event:unknown)=>res.write(`data: ${JSON.stringify(event)}\n\n`);send({type:"response.created",response:{id,status:"in_progress"}});send({type:"response.output_item.added",output_index:0,item});if(!name)send({type:"response.output_text.delta",output_index:0,delta:"Local resource protocol fixture complete."});send({type:"response.output_item.done",output_index:0,item});send({type:"response.completed",response:{id,status:"completed",output:[item],usage:{input_tokens:1000,output_tokens:150,input_tokens_details:{cached_tokens:0}}}});res.end();
 })().catch(error=>{fixtureError=error;res.writeHead(500);res.end("Local fixture failed");});});
 upstream.listen(0,"127.0.0.1");gateway.server.listen(0,"127.0.0.1");await Promise.all([once(upstream,"listening"),once(gateway.server,"listening")]);
 try{
 const profile=await registerModelProfile(admin,key,{projectId:project,actorId:users[0],name:"Resource local protocol fixture",modelId:"resource-fixture",contextWindow:128000,maxOutputTokens:512,runTokenLimit:3000000,runRequestLimit:16},{apiKey:secret,baseUrl:`http://127.0.0.1:${(upstream.address() as {port:number}).port}/v1`});
 const claim=await claimTask(t.id,users[1],profile.id,false),outcome=await executeClaim(worker,executor,claim,{dataRoot:root,backend:new NativeRuntimeBackend(),gatewayUrl:`http://127.0.0.1:${(gateway.server.address() as {port:number}).port}/v1`,heartbeatMs:50,timeoutMs:20000});if(fixtureError)throw fixtureError;assert.equal(outcome,"completed");
 assert.deepEqual((await admin.query("SELECT result->'rows' AS rows FROM collab.resource_jobs WHERE resource_id=$1 AND status='succeeded'",[x])).rows[0].rows,[{proof:91}]);assert.equal((await admin.query("SELECT holder_id FROM collab.resources WHERE id=$1",[x])).rows[0].holder_id,null);
 }finally{clearInterval(timer);await until(async()=>!polling);await Promise.allSettled(jobs);await gateway.close();upstream.closeAllConnections();await new Promise<void>(resolve=>upstream.close(()=>resolve()));await gatewayStore.close();}
});

test("workspace environment foundation: private schemas and unique ports, reset and confirmed-stop reclamation",async()=>{
 const {projectEnvironments,manageEnvironment}=await import("../../lib/collab/environments");
 const a=await claimTask(undefined,users[1]),b=await claimTask(undefined,users[0]);await brokerStore.provision(key);
 const ea=(await call(a,"get_context")).resources.environment,eb=(await call(b,"get_context")).resources.environment;
 assert.notEqual(ea.resourceId,eb.resourceId);assert.notEqual(ea.port,eb.port);assert.ok(ea.port>=41000&&ea.port<=60999);
 await assert.rejects(request(a,[eb.resourceId]),/not_found/);
 await request(a,[ea.resourceId]);await request(b,[eb.resourceId]);
 assert.equal((await execute(await sql(a,ea.resourceId,"CREATE TABLE workspace_data AS SELECT 'alice'::text AS name"))).status,"succeeded");
 assert.equal((await execute(await sql(b,eb.resourceId,"CREATE TABLE workspace_data AS SELECT 'bob'::text AS name"))).status,"succeeded");
 assert.equal((await execute(await sql(a,ea.resourceId,"SELECT name FROM workspace_data"))).result.rows[0].name,"alice");assert.equal((await execute(await sql(b,eb.resourceId,"SELECT name FROM workspace_data"))).result.rows[0].name,"bob");
 let env=(await projectEnvironments(users[0],project)).environments.find((e:{workspace_id:string})=>e.workspace_id===a.workspace.id);
 const reset={action:"reset",expectedVersion:env.version,idempotencyKey:randomUUID(),reason:"Reset isolated scratch data after saving fixture evidence",acknowledgeLoss:true};
 await assert.rejects(manageEnvironment(users[1],a.workspace.id,reset),/forbidden/);
 await assert.rejects(manageEnvironment(users[0],a.workspace.id,reset),/resource_not_drained/);
 await release(a,(await granted(a)).id);await manageEnvironment(users[0],a.workspace.id,reset);assert.equal(await brokerStore.reconcileEnvironments(),1);await brokerStore.provision(key);
 await request(a,[ea.resourceId]);const empty=await execute(await sql(a,ea.resourceId,"SELECT to_regclass('workspace_data') AS old_table"));assert.equal(empty.result.rows[0].old_table,null);
 await release(a,(await granted(a)).id);await worker.finish(executor,a.run.id,a.run.epoch,"completed",{});
 env=(await projectEnvironments(users[0],project)).environments.find((e:{workspace_id:string})=>e.workspace_id===a.workspace.id);
 const reclaim={...reset,action:"reclaim",expectedVersion:env.version,idempotencyKey:randomUUID()};await manageEnvironment(users[0],a.workspace.id,reclaim);await brokerStore.reconcileEnvironments();
 env=(await projectEnvironments(users[0],project)).environments.find((e:{workspace_id:string})=>e.workspace_id===a.workspace.id);assert.equal(env.port,null);assert.equal(env.state,"released");assert.equal((await admin.query("SELECT 1 FROM collab_broker.credentials WHERE resource_id=$1",[ea.resourceId])).rowCount,0);
 await release(b,(await granted(b)).id);await worker.finish(executor,b.run.id,b.run.epoch,"completed",{});await admin.query("UPDATE collab.runs SET finished_at=clock_timestamp()-interval '25 hours' WHERE id=$1",[b.run.id]);await brokerStore.reconcileEnvironments();
 assert.equal((await projectEnvironments(users[0],project)).environments.find((e:{workspace_id:string})=>e.workspace_id===b.workspace.id).state,"released");
});
