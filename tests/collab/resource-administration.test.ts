import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { localConfig, applicationEnvironment, connectionString, executorConnectionString, brokerConnectionString } from "../../scripts/local-config";
import { startNativeDatabase } from "../../scripts/native-database";
import { migrate } from "../../scripts/migrate";
import { provisioningAuth } from "../../lib/collab/auth";
import { asUser, database } from "../../lib/collab/database";
import { createProject } from "../../lib/collab/projects";
import { createTask } from "../../lib/collab/tasks";
import { startRun } from "../../lib/collab/runs";
import { ExecutionStore, type ClaimedRun } from "../../lib/collab/execution-store";
import { coordinate } from "../../lib/collab/coordination-server";
import { createResource, manageResource, controlResource, projectResources } from "../../lib/collab/resources";
import { ResourceStore, type ResourceJob } from "../../lib/collab/resources/store";
import { executeResourceJob } from "../../lib/collab/resources/worker";

const config=await localConfig(),databaseName=`pi_collab_test_${randomBytes(6).toString("hex")}`,native=await startNativeDatabase(config);
Object.assign(process.env,applicationEnvironment(config),{DATABASE_URL:connectionString(config,false,databaseName)});
const admin=new Pool({connectionString:connectionString(config,true,databaseName)}),worker=new ExecutionStore(executorConnectionString(config,databaseName)),broker=new ResourceStore(brokerConnectionString(config,databaseName));
const organization=randomUUID(),executor=randomUUID(),brokerId=randomUUID(),repository=randomUUID(),baseSha="a".repeat(40),key=randomBytes(32),users:string[]=[];
let project:string;
before(async()=>{
 await migrate(config,databaseName);const auth=provisioningAuth(admin);
 for(let i=0;i<5;i++)users.push((await auth.api.signUpEmail({body:{name:`Resource operator ${i}`,email:`resource-operator${i}@test.invalid`,password:randomBytes(20).toString("hex")}})).user.id);
 await admin.query("INSERT INTO collab.organizations(id,name,created_by) VALUES($1,'Resource administration',$2)",[organization,users[0]]);
 for(let i=0;i<4;i++)await admin.query("INSERT INTO collab.memberships(organization_id,user_id,role) VALUES($1,$2,$3)",[organization,users[i],i===0?"owner":"member"]);
 await admin.query('UPDATE public."user" SET "twoFactorEnabled"=true WHERE id=$1',[users[0]]);
 project=(await createProject(users[0],{organizationId:organization,name:"Resource administration",description:""})).id;
 for(let i=1;i<4;i++)await admin.query("INSERT INTO collab.project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,$4)",[organization,project,users[i],i===3?"reviewer":"developer"]);
 await admin.query("INSERT INTO collab.repositories(id,organization_id,project_id,name,provider,base_sha,default_branch) VALUES($1,$2,$3,'Control fixture','local',$4,'main')",[repository,organization,project,baseSha]);
});
after(async()=>{
 const roles=(await admin.query("SELECT role_name FROM collab_broker.credentials")).rows.map(r=>r.role_name);
 await broker.close();await worker.close();await database().end();globalThis.__piCollabPool=undefined;await admin.end();
 const cleanup=new Pool({connectionString:connectionString(config,true,"postgres")});
 await cleanup.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
 for(const role of roles){assert.match(role,/^pcr_[a-f0-9]{32}$/);await cleanup.query(`DROP ROLE "${role}"`);}await cleanup.end();await native.stop();key.fill(0);
});
afterEach(async()=>{
 for(const r of(await admin.query("SELECT id,epoch::text FROM collab.runs WHERE status IN ('running','stopping')")).rows)await worker.finish(executor,r.id,r.epoch,"cancelled",{});
 await broker.claim(brokerId);
});
async function resource(provision=true){const r=await createResource(users[0],project,{name:"Managed test schema",idempotencyKey:randomUUID()});if(provision)await broker.provision(key);return r.resourceId as string;}
async function run(user=users[1]){const t=await createTask(user,project,{title:"Resource control",description:"",acceptance:"Real database writer must exit"});await startRun(user,t.id,{repositoryId:repository,baseSha,prompt:"Resource protocol fixture",expectedVersion:t.version,idempotencyKey:randomUUID()});const c=await worker.claim(executor,"native");assert.ok(c);assert.equal(c.run.task_id,t.id);await worker.running(executor,c.run.id,c.run.epoch);return c;}
const input=(action:"disable"|"enable",expectedVersion=1)=>({action,expectedVersion,reason:"Operator resource control acceptance",idempotencyKey:randomUUID()});
const control=(targetKind:"request"|"job")=>({targetKind,reason:"Operator control requires recorded justification",idempotencyKey:randomUUID()});
const request=(c:ClaimedRun,resourceId:string)=>coordinate(worker,executor,c.run.id,c.run.epoch,"request_resource",{resourceIds:[resourceId],idempotencyKey:randomUUID()});
const context=(c:ClaimedRun)=>coordinate(worker,executor,c.run.id,c.run.epoch,"get_context",{});
async function sql(c:ClaimedRun,resourceId:string,sql:string){const q=(await context(c)).resources.requests.find((q:{status:string})=>q.status==="granted");assert.ok(q);return coordinate(worker,executor,c.run.id,c.run.epoch,"execute_resource",{requestId:q.id,resourceId,fence:q.grants[0].fence,sql,idempotencyKey:randomUUID()});}
async function claimJob(){let job:ResourceJob|null=null;await until(async()=>{job=await broker.claim(brokerId);return !!job;});return job!;}
async function until(predicate:()=>Promise<boolean>){const deadline=Date.now()+5000;while(!await predicate()){if(Date.now()>deadline)throw new Error("Resource administration evidence timed out");await new Promise(resolve=>setTimeout(resolve,20));}}

test("resource administration is authorized, versioned, idempotent and audited; SQL data survives disable/enable",async()=>{
 const id=await resource(),c=await run();await request(c,id);await sql(c,id,"CREATE TABLE preserved(value int)");assert.equal(await executeResourceJob(broker,await claimJob(),key),"succeeded");
 const operation=input("disable");
 for(const user of[users[1],users[3],users[4]])await assert.rejects(manageResource(user,id,operation),/forbidden|not_found/);
 const results=await Promise.all(Array.from({length:12},()=>manageResource(users[0],id,operation)));assert.equal(results.filter(r=>!r.replayed).length,1);
 await assert.rejects(manageResource(users[0],id,{...operation,reason:"Changed reason cannot reuse operation key"}),/idempotency_conflict/);
 await assert.rejects(manageResource(users[0],id,input("enable",1)),/stale_resource/);
 await manageResource(users[0],id,input("enable",2));
 const row=(await projectResources(users[1],project)).resources.find(r=>r.id===id);assert.equal(row.version,3);assert.equal(row.status,"ready");
 const schema=(await admin.query("SELECT schema_name FROM collab_broker.credentials WHERE resource_id=$1",[id])).rows[0].schema_name;
 assert.equal((await admin.query(`SELECT * FROM "${schema}".preserved`)).rowCount,0);
 assert.equal((await admin.query("SELECT count(*)::int AS n FROM collab.resource_commands WHERE scope_id=$1",[id])).rows[0].n,2);
 assert.equal((await admin.query("SELECT count(*)::int AS n FROM collab.audit_events WHERE resource_id=$1 AND action IN ('resource.enable','resource.disable')",[id])).rows[0].n,2);
 await assert.rejects(asUser(users[0],db=>db.query("UPDATE collab.resources SET status='ready' WHERE id=$1",[id])),/permission/);
 await assert.rejects(asUser(users[0],db=>db.query("DELETE FROM collab.resource_commands")),/permission/);
 assert.equal((await asUser(users[4],db=>db.query("SELECT * FROM collab.resource_commands"))).rowCount,0);
});

test("an unprovisioned disabled resource can be resumed without inventing credentials or reviving old waiters",async()=>{
 const id=await resource(false),c=await run(),q=await request(c,id);assert.equal((await context(c)).resources.requests[0].status,"waiting");
 await manageResource(users[0],id,input("disable"));await broker.provision(key);
 assert.equal((await admin.query("SELECT 1 FROM collab_broker.credentials WHERE resource_id=$1",[id])).rowCount,0);
 assert.equal((await admin.query("SELECT status FROM collab.resource_requests WHERE id=$1",[q.requestId])).rows[0].status,"cancelled");
 assert.equal((await manageResource(users[0],id,input("enable",2))).status,"requested");await broker.provision(key);
 assert.equal((await projectResources(users[0],project)).resources.find(r=>r.id===id).status,"ready");
 assert.equal((await context(c)).resources.requests[0].status,"cancelled");
});

test("disable drains an actual live PostgreSQL writer before resume and cancels waiting batches without reviving old fences",async()=>{
 const id=await resource(),a=await run(),b=await run(users[2]),first=await request(a,id),second=await request(b,id);
 const old=(await context(a)).resources.requests[0].grants[0].fence;
 await sql(a,id,"SELECT pg_sleep(30)");const job=await claimJob(),work=executeResourceJob(broker,job,key,undefined,60000);
 try{
  await until(async()=>(await admin.query("SELECT backend_pid IS NOT NULL AS bound FROM collab.resource_jobs WHERE id=$1",[job.id])).rows[0].bound);
  await manageResource(users[0],id,input("disable"));
  await assert.rejects(manageResource(users[0],id,input("enable",2)),/resource_not_drained/);
  const r=(await admin.query("SELECT holder_id,status FROM collab.resources WHERE id=$1",[id])).rows[0];assert.equal(r.status,"disabled");assert.equal(r.holder_id,first.requestId);
  assert.equal((await admin.query("SELECT status FROM collab.resource_requests WHERE id=$1",[second.requestId])).rows[0].status,"cancelled");
  await assert.rejects(request(b,id),/not_found/);
 }finally{await broker.terminate(job);await work;}
 assert.equal((await admin.query("SELECT status,stopped FROM collab.resource_jobs WHERE id=$1",[job.id])).rows[0].status,"unknown");
 await manageResource(users[0],id,input("enable",2));await request(b,id);
 const next=(await context(b)).resources.requests.find((q:{status:string})=>q.status==="granted");assert.ok(BigInt(next.grants[0].fence)>BigInt(old));
 await assert.rejects(coordinate(worker,executor,a.run.id,a.run.epoch,"execute_resource",{requestId:first.requestId,resourceId:id,fence:old,sql:"SELECT 1",idempotencyKey:randomUUID()}),/stale_resource_lease/);
});

test("people can cancel only their own jobs or release their batches; maintenance control does not stop unrelated AI runs",async()=>{
 const id=await resource(),a=await run(),b=await run(users[2]),first=await request(a,id);await request(b,id);
 const queued=await sql(a,id,"SELECT 8");for(const user of[users[2],users[3],users[4]])await assert.rejects(controlResource(user,queued.jobId,control("job")),/forbidden|not_found/);
 const op=control("job");await controlResource(users[1],queued.jobId,op);assert.equal((await controlResource(users[1],queued.jobId,op)).replayed,true);
 assert.equal((await admin.query("SELECT status,stopped FROM collab.resource_jobs WHERE id=$1",[queued.jobId])).rows[0].stopped,true);
 await sql(a,id,"SELECT pg_sleep(30)");const job=await claimJob(),work=executeResourceJob(broker,job,key,undefined,30);
 await until(async()=>(await admin.query("SELECT backend_pid IS NOT NULL AS bound FROM collab.resource_jobs WHERE id=$1",[job.id])).rows[0].bound);
 await controlResource(users[1],job.id,control("job"));assert.equal(await work,"cancelled");
 assert.equal((await worker.inspect(executor,a.run.id,a.run.epoch))?.status,"running");
 assert.equal((await admin.query("SELECT holder_id FROM collab.resources WHERE id=$1",[id])).rows[0].holder_id,first.requestId);
 const ownerListing=await projectResources(users[1],project),peerListing=await projectResources(users[2],project);assert.equal(ownerListing.jobs.find(j=>j.id===job.id).can_control,true);assert.equal(peerListing.jobs.find(j=>j.id===job.id).can_control,false);
 await assert.rejects(controlResource(users[2],first.requestId,control("request")),/forbidden/);
 const release=control("request");await controlResource(users[0],first.requestId,release);assert.equal((await controlResource(users[0],first.requestId,release)).replayed,true);
 assert.ok((await context(b)).resources.requests.find((q:{status:string})=>q.status==="granted"));
 assert.equal((await worker.inspect(executor,a.run.id,a.run.epoch))?.status,"running");
});

test("human release cannot erase an unknown live writer or mark its SQL safe to replay",async()=>{
 const id=await resource(),a=await run(),b=await run(users[2]),first=await request(a,id);await request(b,id);
 await sql(a,id,"SELECT pg_sleep(30)");const job=await claimJob(),work=executeResourceJob(broker,job,key,undefined,60000).then(()=>undefined,error=>error);
 await until(async()=>(await admin.query("SELECT backend_pid IS NOT NULL AS bound FROM collab.resource_jobs WHERE id=$1",[job.id])).rows[0].bound);
 await admin.query("UPDATE collab.resource_jobs SET status='unknown' WHERE id=$1",[job.id]);await controlResource(users[0],first.requestId,control("request"));
 assert.equal((await admin.query("SELECT holder_id FROM collab.resources WHERE id=$1",[id])).rows[0].holder_id,first.requestId);
 await until(async()=>{await broker.reconcile();return (await admin.query("SELECT stopped FROM collab.resource_jobs WHERE id=$1",[job.id])).rows[0].stopped;});await work;
 assert.equal((await admin.query("SELECT status FROM collab.resource_jobs WHERE id=$1",[job.id])).rows[0].status,"unknown");
 assert.ok((await context(b)).resources.requests.find((q:{status:string})=>q.status==="granted"));
});

test("current membership is checked before human control replays and executor roles cannot administer resources",async()=>{
 const id=await resource(),a=await run(users[2]),q=await request(a,id),op=control("request");await controlResource(users[2],q.requestId,op);
 await admin.query("UPDATE collab.project_memberships SET active=false WHERE project_id=$1 AND user_id=$2",[project,users[2]]);
 await assert.rejects(controlResource(users[2],q.requestId,op),/not_found|forbidden/);
 await assert.rejects(worker.pool.query("SELECT collab.manage_resource($1,'disable',1,$2,$3)",[id,"Executor has no human administrator authority",randomUUID()]),/permission/);
 await assert.rejects(asUser(users[0],db=>db.query("SELECT collab.manage_resource($1,'disable',1,NULL,$2)",[id,randomUUID()])),/invalid_resource_action/);
});
