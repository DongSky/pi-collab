import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, totalmem, availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { Pool } from "pg";
import { checkDockerDirectory } from "./docker-check";
import { verifyRelease } from "./release.mjs";
import { provisioningAuth } from "../lib/collab/auth";
import { database } from "../lib/collab/database";
import { createProject } from "../lib/collab/projects";
import { createTask } from "../lib/collab/tasks";
import { importLocalRepository } from "../lib/collab/repository-import";
import { registerModelProfile } from "../lib/collab/gateway/profiles";
import { GatewayStore } from "../lib/collab/gateway/store";
import { createModelGateway } from "../lib/collab/gateway/server";

const { values } = parseArgs({ options: { "web-root": { type: "string" }, output: { type: "string" }, runtime: { type: "string", default: "native" }, "duration-seconds": { type: "string", default: "30" } } });
const runtime = values.runtime;
assert.ok(runtime === "native" || runtime === "docker", "Runtime must be native or docker");
const durationMs = Number(values["duration-seconds"]) * 1000;
assert.ok(Number.isInteger(durationMs) && durationMs >= 10000 && durationMs <= 900000, "Duration must be 10–900 seconds");
const coordinationRounds = Math.max(10, Math.ceil(durationMs / 10000));
const output = values.output ?? `test-results/collab/capacity-${runtime}.json`;
process.env.PI_COLLAB_RUNTIME = runtime;
assert.ok(values["web-root"], "Supply an independently built installed production artifact with --web-root");
const webRoot = path.resolve(values["web-root"]), release = await verifyRelease(webRoot);
// Reject stale executable code, but allow source-only benchmark/docs updates.
for (const file of release.files.filter((f: {path:string}) => /^(app|lib|components|hooks)\//.test(f.path) || f.path === "scripts/executor.ts")) {
  assert.equal(createHash("sha256").update(await readFile(file.path)).digest("hex"),file.sha256,"Rebuild the isolated release: "+file.path);
}
// A separate database name still shares max_connections with every development
// service. Own the cluster too, so sustained load cannot exhaust user/test pools.
const root = await mkdtemp(path.join(tmpdir(),"pi-collab-capacity-"));
process.env.PI_COLLAB_DATA_DIR = root;
const { localConfig, applicationEnvironment, connectionString, executorConnectionString, gatewayConnectionString } = await import("./local-config");
const { startNativeDatabase } = await import("./native-database");
const { migrate } = await import("./migrate");
const config = await localConfig(), dbName = `pi_collab_test_${randomBytes(6).toString("hex")}`;
const databaseProbe = createServer();
databaseProbe.listen(0,"127.0.0.1"); await once(databaseProbe,"listening");
config.databasePort = (databaseProbe.address() as {port:number}).port;
await new Promise<void>(resolve=>databaseProbe.close(()=>resolve()));
await writeFile(path.join(root,"config.json"),JSON.stringify(config),{mode:0o600});
const native = await startNativeDatabase(config);
assert.ok(native.owned,"Benchmark must own its isolated PostgreSQL cluster");
const log = await open(path.join(root,"private-server.log"),"w",0o600);
const admin = new Pool({connectionString:connectionString(config,true,dbName)});
const gatewayStore = new GatewayStore(gatewayConnectionString(config,dbName)), key = randomBytes(32), secret = randomBytes(32).toString("hex");
const gateway = createModelGateway(gatewayStore,key), exec = promisify(execFile);
const children: ReturnType<typeof spawn>[] = [], tasks: {id:string;projectId:string;user:number;model:string;repository:{id:string;baseSha:string};runId?:string}[] = [];
const users: {id:string;cookie:string;projectId:string}[] = [], projects: string[] = [];
const apiTimes: number[] = [], eventTimes: number[] = [], streamErrors: string[] = [];
type Watcher={controller:AbortController;work:Promise<void>;cursor:string;seen:Set<string>;task:string;user:number};
const watchers:Watcher[]=[];
let releaseModels!:()=>void;const modelGate=new Promise<void>(r=>{releaseModels=r;});
const started=new Set<string>(), finalWaiting=new Set<string>(), requests=new Map<string,number>();
const wait=async(ms:number)=>new Promise(r=>setTimeout(r,ms));
const poll=async(check:()=>Promise<boolean>|boolean,what:string,ms=60000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await check())return;await wait(50);}throw new Error(what);};
const upstream=createServer((req,res)=>{void(async()=>{
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);
  assert.equal(req.headers.authorization,`Bearer ${secret}`);
  const body=JSON.parse(Buffer.concat(chunks).toString()), id=`resp_${randomUUID()}`, round=body.input.filter((i:{type:string})=>i.type==="function_call_output").length;
  const task=tasks.find(t=>t.id===body.model);assert.ok(task);requests.set(task.id,(requests.get(task.id)??0)+1);
  started.add(task.id);await poll(()=>started.size===8,"Eight actual Pi providers did not overlap");
  let tool:{name:string;arguments:unknown}|undefined;
  if(round===0)tool={name:"bash",arguments:{command:`printf '${task.id}' > shared-name.txt`}};
  else if(round<=coordinationRounds){await wait(durationMs / (coordinationRounds + 2));tool={name:"collab_send_note",arguments:{targetTaskId:task.id,kind:"finding",body:`Capacity marker ${round}`,resultIds:[],revisionIds:[],idempotencyKey:randomUUID()}};}
  else {finalWaiting.add(task.id);await modelGate;}
  const item=tool?{type:"function_call",id:`fc_${round}`,call_id:`call_${round}`,name:tool.name,arguments:JSON.stringify(tool.arguments)}:{type:"message",id:"done",role:"assistant",status:"completed",content:[{type:"output_text",text:"Capacity protocol complete",annotations:[]}]};
  res.writeHead(200,{"Content-Type":"text/event-stream"});const send=(value:unknown)=>res.write(`data: ${JSON.stringify(value)}\n\n`);
  send({type:"response.created",response:{id,status:"in_progress"}});send({type:"response.output_item.added",output_index:0,item});
  if(!tool)send({type:"response.output_text.delta",output_index:0,delta:"Capacity protocol complete"});
  send({type:"response.output_item.done",output_index:0,item});send({type:"response.completed",response:{id,status:"completed",output:[item],usage:{input_tokens:1000,output_tokens:150,input_tokens_details:{cached_tokens:0}}}});res.end();
})().catch(()=>{if(!res.headersSent)res.writeHead(500);res.end("Local protocol fixture failed");});});
let base="", success=false;
function service(script:string,args:string[],env:NodeJS.ProcessEnv,cwd=process.cwd()) {
  const child=spawn(process.execPath,[script,...args],{cwd,env,stdio:["ignore",log.fd,log.fd],detached:true});children.push(child);return child;
}
async function api(user:number,endpoint:string,body?:unknown,measure=false){
  const start=performance.now(),response=await fetch(`${base}/api/collab/${endpoint}`,{method:body===undefined?"GET":"POST",headers:{Cookie:users[user].cookie,Origin:base,...(body===undefined?{}:{"Content-Type":"application/json"})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});
  const data=await response.json();if(measure)apiTimes.push(performance.now()-start);
  assert.ok(response.ok,`${endpoint}: ${response.status} ${data.error??""}`);return data;
}
async function subscribe(task:typeof tasks[number],user:number,cursor="0") {
  const controller=new AbortController(),response=await fetch(`${base}/api/collab/projects/${task.projectId}/events?after=${cursor}`,{headers:{Cookie:users[user].cookie,Accept:"text/event-stream"},signal:controller.signal});assert.equal(response.status,200);
  const watcher:Watcher={controller,work:Promise.resolve(),cursor,seen:new Set(),task:task.id,user};watchers.push(watcher);
  watcher.work=(async()=>{let buffer="";const decoder=new TextDecoder();const reader=response.body!.getReader();for(;;){const {value:chunk,done}=await reader.read();if(done)break;buffer+=decoder.decode(chunk,{stream:true});let end;while((end=buffer.indexOf("\n\n"))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);const raw=frame.split("\n").find(l=>l.startsWith("data: "));if(!raw)continue;const event=frame.split("\n").find(l=>l.startsWith("event: "))?.slice(7);const value=JSON.parse(raw.slice(6));if(event==="run_event"){watcher.cursor=value.sequence;if(value.kind==="coordination.note"&&value.payload.targetTaskId===task.id){watcher.seen.add(value.payload.noteId);eventTimes.push(Date.now()-Date.parse(value.created_at));}}else if(event==="snapshot")watcher.cursor=value.cursor;else streamErrors.push(event??"invalid-event");}}})().catch(e=>{if(!controller.signal.aborted)streamErrors.push(e.name);});return watcher;
}
try {
  if(runtime === "docker") await checkDockerDirectory(root);
  Object.assign(process.env,applicationEnvironment(config),{DATABASE_URL:connectionString(config,false,dbName),PI_COLLAB_DATA_DIR:root});await migrate(config,dbName);
  upstream.listen(0,"127.0.0.1");gateway.server.listen(0,"127.0.0.1");await Promise.all([once(upstream,"listening"),once(gateway.server,"listening")]);
  const probe=createServer();probe.listen(0,"127.0.0.1");await once(probe,"listening");const webPort=(probe.address() as {port:number}).port;await new Promise<void>(r=>probe.close(()=>r()));base=`http://127.0.0.1:${webPort}`;
  process.env.BETTER_AUTH_URL=base;Object.assign(process.env,{NODE_ENV:"production"});
  const provision=provisioningAuth(admin),password=randomBytes(24).toString("hex");
  const owner=(await provision.api.signUpEmail({body:{name:"Capacity owner",email:"owner@capacity.invalid",password}})).user.id;
  await admin.query('UPDATE public."user" SET "twoFactorEnabled"=true WHERE id=$1',[owner]);
  const source=path.join(root,"source");await mkdir(source);for(const args of [["init"],["config","user.name","Capacity fixture"],["config","user.email","capacity@test.invalid"]])await exec("git",args,{cwd:source});await writeFile(path.join(source,"shared-name.txt"),"baseline");await exec("git",["add","."],{cwd:source});await exec("git",["commit","-m","Fixture"],{cwd:source});
  for(let orgIndex=0;orgIndex<2;orgIndex++){
    const org=randomUUID();await admin.query("INSERT INTO collab.organizations(id,name,created_by) VALUES($1,$2,$3)",[org,`Capacity organization ${orgIndex}`,owner]);await admin.query("INSERT INTO collab.memberships(organization_id,user_id,role) VALUES($1,$2,'owner')",[org,owner]);
    const project=(await createProject(owner,{organizationId:org,name:`Capacity project ${orgIndex}`,description:""})).id;projects.push(project);
    const repository=await importLocalRepository(admin,root,{projectId:project,actorId:owner,source,name:"Capacity source"});
    for(let i=0;i<10;i++){
      const email=`member-${orgIndex}-${i}@capacity.invalid`,u=(await provision.api.signUpEmail({body:{name:`Member ${orgIndex}-${i}`,email,password}})).user;
      await admin.query("INSERT INTO collab.memberships(organization_id,user_id,role) VALUES($1,$2,'member')",[org,u.id]);await admin.query("INSERT INTO collab.project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,'developer')",[org,project,u.id]);
      const login=await provision.api.signInEmail({body:{email,password},asResponse:true});assert.equal(login.status,200);
      const cookie=login.headers.getSetCookie().map(c=>c.split(";")[0]).join("; ");assert.ok(cookie);users.push({id:u.id,cookie,projectId:project});
      if(i<4){const t=await createTask(u.id,project,{title:`Concurrent AI ${orgIndex}-${i}`,description:"",acceptance:"Keep own bytes and durable coordination"});const profile=await registerModelProfile(admin,key,{projectId:project,actorId:owner,name:`Local fixture ${i}`,modelId:t.id,contextWindow:128000,maxOutputTokens:512,runTokenLimit:3000000,runRequestLimit:coordinationRounds + 4},{apiKey:secret,baseUrl:`http://127.0.0.1:${(upstream.address() as {port:number}).port}/v1`});tasks.push({id:t.id,projectId:project,user:users.length-1,model:profile.id,repository});}
    }
  }
  // Real production Next output; only the fixture identity/mail settings are local.
  service(path.join(webRoot,"node_modules/next/dist/bin/next"),["start","-H","127.0.0.1","-p",String(webPort)],{...applicationEnvironment(config),NODE_ENV:"production",DATABASE_URL:connectionString(config,false,dbName),BETTER_AUTH_URL:base,PI_COLLAB_DATA_DIR:root},webRoot);
  await poll(async()=>{try{return(await fetch(`${base}/sign-in`)).ok;}catch{return false;}},"Production web unavailable");
  for(let i=0;i<20;i++){assert.equal((await api(i,"me")).user.id,users[i].id);await api(i,`projects/${users[i].projectId}`);}
  for(const task of tasks)for(let n=0;n<3;n++)await subscribe(task,(task.user<10?0:10)+(task.user+n)%10);
  const input=(t:typeof tasks[number])=>({repositoryId:t.repository.id,baseSha:t.repository.baseSha,prompt:"Execute the local deterministic capacity protocol",expectedVersion:1,idempotencyKey:randomUUID(),modelProfileId:t.model});
  const duplicate=input(tasks[0]),dup=await Promise.all(Array.from({length:100},()=>api(tasks[0].user,`tasks/${tasks[0].id}/runs`,duplicate)));assert.equal(new Set(dup.map(r=>r.runId)).size,1);tasks[0].runId=dup[0].runId;assert.equal(Number((await admin.query("SELECT count(*) n FROM collab.commands WHERE run_id=$1 AND kind='start'",[tasks[0].runId])).rows[0].n),1);
  for(const task of tasks.slice(1))task.runId=(await api(task.user,`tasks/${task.id}/runs`,input(task))).runId;
  service("--import",["tsx","scripts/executor.ts"],{NODE_ENV:"production",PATH:process.env.PATH,LANG:process.env.LANG,PI_COLLAB_DATA_DIR:root,PI_COLLAB_RUNTIME:runtime,PI_COLLAB_EXECUTOR_CAPACITY:"8",PI_COLLAB_EXECUTOR_DATABASE_URL:executorConnectionString(config,dbName),PI_COLLAB_MODEL_GATEWAY_URL:`http://127.0.0.1:${(gateway.server.address() as {port:number}).port}/v1`});
  await poll(()=>started.size===8,"Eight Pi processes did not reach provider",90000);
  const liveProcesses=new Set<string>(), images=new Set<string>();
  for(const task of tasks){
    const row=(await admin.query("SELECT workspace_id FROM collab.runs WHERE id=$1",[task.runId])).rows[0];
    const receipt=JSON.parse(await readFile(path.join(root,runtime === "docker" ? "container-receipts" : "runtime-receipts",`${row.workspace_id}.json`),"utf8"));
    assert.equal(receipt.state,"started");assert.equal(receipt.identity.runId,task.runId);
    if(runtime === "native") { process.kill(receipt.pid,0);liveProcesses.add(String(receipt.pid)); }
    else {
      const state=JSON.parse((await exec("docker",["inspect","--format","{{json .State}}",receipt.containerId],{timeout:10000})).stdout);
      assert.equal(state.Running,true);assert.ok(state.Pid>0);liveProcesses.add(`${receipt.containerId}:${state.Pid}`);images.add(receipt.image);
    }
  }
  assert.equal(liveProcesses.size,8);
  const overlapAt=Date.now();assert.equal(Number((await admin.query("SELECT count(*) n FROM collab.runs WHERE status='running'")).rows[0].n),8);
  const queued=await createTask(users[8].id,projects[0],{title:"Capacity overflow",description:"",acceptance:"Wait for a slot"});
  const queueRun=await api(8,`tasks/${queued.id}/runs`,{...input(tasks[0]),prompt:"Must remain queued"});
  const loadStart=performance.now();
  const progress=setInterval(()=>console.log(JSON.stringify({phase:"sustained-load",runtime,elapsedSeconds:Math.round((performance.now()-loadStart)/1000),apiSamples:apiTimes.length,eventSamples:eventTimes.length})),30000);
  try { await Promise.all(users.map(async(u,i)=>{for(let n=0;performance.now()-loadStart<durationMs;n++){await api(i,n%2?`projects/${u.projectId}`:"projects",undefined,true);await wait(150);}})); } finally { clearInterval(progress); }
  const loadDurationMs=performance.now()-loadStart;
  assert.equal((await api(8,`runs/${queueRun.runId}`)).run.status,"queued");await api(8,`runs/${queueRun.runId}/stop`,{idempotencyKey:randomUUID()});
  await poll(()=>finalWaiting.size===8,"Pi coordination rounds incomplete");await poll(()=>watchers.every(w=>w.seen.size===coordinationRounds),"Subscribers did not receive all accepted notes");
  // Disconnect one watcher, create a durable marker while offline, then replay.
  const old=watchers[0];old.controller.abort();await old.work;
  const marker=await api(tasks[0].user,`tasks/${tasks[0].id}/notes`,{targetTaskId:tasks[0].id,kind:"finding",body:"Reconnect marker",resultIds:[],revisionIds:[],idempotencyKey:randomUUID()});
  const reconnectStart=performance.now(),reconnected=await subscribe(tasks[0],old.user,old.cursor);await poll(()=>reconnected.seen.has(marker.noteId),"Durable reconnect exceeded five seconds",5000);const reconnectMs=performance.now()-reconnectStart;
  const cross=await fetch(`${base}/api/collab/projects/${projects[1]}/events`,{headers:{Cookie:users[0].cookie,Accept:"text/event-stream"}});assert.equal(cross.status,404);await cross.body?.cancel();
  for(const task of tasks){const r=(await admin.query("SELECT workspace_id FROM collab.runs WHERE id=$1",[task.runId])).rows[0];assert.equal(await readFile(path.join(root,"workspaces",r.workspace_id,"checkout/shared-name.txt"),"utf8"),task.id);}
  const overlapMs=Date.now()-overlapAt;releaseModels();await poll(async()=>Number((await admin.query("SELECT count(*) n FROM collab.runs WHERE status='completed'")).rows[0].n)===8,"Pi runs did not complete");assert.equal(streamErrors.length,0,JSON.stringify(streamErrors));
  const percentile=(xs:number[],q:number)=>[...xs].sort((a,b)=>a-b)[Math.ceil(xs.length*q)-1];
  const docker = runtime === "docker" ? (await exec("docker",["info","--format","{{.NCPU}} {{.MemTotal}} {{.Architecture}}"],{timeout:10000})).stdout.trim().split(" ") : null;
  const report={schema:2,at:new Date().toISOString(),releaseCommit:release.commit,sourceCommit:(await exec("git",["rev-parse","HEAD"])).stdout.trim(),hardware:{platform:process.platform,arch:process.arch,node:process.version,cpu:cpus()[0].model,logicalCpus:cpus().length,availableParallelism:availableParallelism(),memoryBytes:totalmem()},backend:{runtime,images:[...images],dockerVm:docker?{cpus:Number(docker[0]),memoryBytes:Number(docker[1]),arch:docker[2]}:null},profile:{requestedDurationMs:durationMs,members:20,organizations:2,runs:8,subscribersPerRun:3,coordinationRoundsPerRun:coordinationRounds,duplicateStartRequests:100,apiRequests:apiTimes.length,loadDurationMs,commonActiveIntervalMs:overlapMs,productionWeb:true,actualPiProcesses:true,externalInference:false,referenceCpuMemoryLimitsApplied:false,isolatedDatabaseCluster:true},api:{p50:percentile(apiTimes,.5),p95:percentile(apiTimes,.95),max:apiTimes.reduce((max,value)=>Math.max(max,value),0)},events:{samples:eventTimes.length,p50:percentile(eventTimes,.5),p95:percentile(eventTimes,.95),max:eventTimes.reduce((max,value)=>Math.max(max,value),0)},reconnectMs,gates:{apiP95:percentile(apiTimes,.95)<500,eventP95:percentile(eventTimes,.95)<1000,reconnect:reconnectMs<5000,duplicateOneRun:true,eightDistinctLiveProcesses:true,queuedAtCapacity:true,isolatedFiles:true,crossOrganizationStreamDenied:true},notes:["Local deterministic provider exercises real Pi tools, not model quality or provider latency.","20 authenticated HTTP clients and 24 SSE readers; browser rendering not measured.","Shared host; not the specified 4-vCPU/8-GiB control and 8-vCPU/32-GiB execution reference topology."]};
  await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+"\n");console.log(JSON.stringify(report));success=true;if(Object.values(report.gates).some(v=>!v))process.exitCode=1;
} catch (error) {
  const state = await admin.query("SELECT id,status,stop_reason,summary FROM collab.runs ORDER BY created_at").catch(()=>({rows:[]}));
  await writeFile(path.join(root,"private-failure.json"),JSON.stringify({runs:state.rows,requests:[...requests],notes:watchers.map(w=>({task:w.task,count:w.seen.size}))},null,2),{mode:0o600});
  throw error;
} finally {
  releaseModels();for(const w of watchers)w.controller.abort();await Promise.allSettled(watchers.map(w=>w.work));
  for(const child of children.reverse()){if(child.exitCode===null&&child.pid){child.kill("SIGTERM");await Promise.race([once(child,"exit"),wait(15000)]);if(child.exitCode===null)process.kill(-child.pid,"SIGKILL");}}
  if(gateway.server.listening)await gateway.close();upstream.closeAllConnections();if(upstream.listening)await new Promise<void>(r=>upstream.close(()=>r()));await gatewayStore.close();await admin.end();if(globalThis.__piCollabPool){await database().end();globalThis.__piCollabPool=undefined;}
  const cleanup=new Pool({connectionString:connectionString(config,true,"postgres")});await cleanup.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);await cleanup.end();await native.stop();await log.close();key.fill(0);
  if(success)await rm(root,{recursive:true,force:true});else console.error("Failed benchmark private log retained: "+root);
}
