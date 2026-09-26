import {resultEvidence} from "../../lib/collab/result-evidence";
import test,{before,after} from "node:test";
import assert from "node:assert/strict";
import {randomBytes,randomUUID} from "node:crypto";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,readdir,chmod} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {createRequire} from "node:module";
import {deflateSync} from "node:zlib";
import {ReviewGit} from "../../lib/collab/runtime/review-git";
import {integrationCode,integrationCodeFile} from "../../lib/collab/integration-code";
import {Pool} from "pg";
import {createServer,createConnection,type Socket} from "node:net";
import {localConfig,applicationEnvironment,connectionString,executorConnectionString} from "../../scripts/local-config";
import {startNativeDatabase} from "../../scripts/native-database";
import {migrate} from "../../scripts/migrate";
import {provisioningAuth} from "../../lib/collab/auth";
import {asUser,database} from "../../lib/collab/database";
import {createProject} from "../../lib/collab/projects";
import {createTask,addDependency} from "../../lib/collab/tasks";
import {startRun,runDetail} from "../../lib/collab/runs";
import {ExecutionStore,type ClaimedRun} from "../../lib/collab/execution-store";
import {executeClaim} from "../../lib/collab/executor";
import {NativeRuntimeBackend} from "../../lib/collab/runtime/backends";
import {importLocalRepository} from "../../lib/collab/repository-import";
import {requestSnapshot,processSnapshots} from "../../lib/collab/snapshots";
import {createValidationProfile,requestValidation} from "../../lib/collab/validations";
import {executeValidation} from "../../lib/collab/validation-worker";
import {publishResult,withdrawResult} from "../../lib/collab/task-results";
import {requestIntegration,integrationDetail,cancelIntegration,listIntegrations} from "../../lib/collab/integrations";
import {executeIntegration} from "../../lib/collab/integration-worker";
import {publishIntegrationPolicy,listIntegrationPolicies,submitIntegrationReview} from "../../lib/collab/integration-reviews";

const config=await localConfig(),dbName=`pi_collab_test_${randomBytes(6).toString("hex")}`,native=await startNativeDatabase(config);
Object.assign(process.env,applicationEnvironment(config),{DATABASE_URL:connectionString(config,false,dbName)});
const admin=new Pool({connectionString:connectionString(config,true,dbName)}),store=new ExecutionStore(executorConnectionString(config,dbName));
const root=await mkdtemp(path.join(tmpdir(),"pi-collab-integrations-")),source=path.join(root,"source"),exec=promisify(execFile),organization=randomUUID(),executor=randomUUID(),users:string[]=[];
process.env.PI_COLLAB_DATA_DIR=root;
let project:string,repository:{id:string;baseSha:string;defaultBranch:string},sourceProfile:string;
before(async()=>{
 await migrate(config,dbName);const auth=provisioningAuth(admin);
 for(let i=0;i<5;i++)users.push((await auth.api.signUpEmail({body:{name:`Integrator ${i}`,email:`integrator${i}@test.invalid`,password:randomBytes(20).toString("hex")}})).user.id);
 await admin.query("INSERT INTO collab.organizations(id,name,created_by) VALUES($1,'Integration acceptance',$2)",[organization,users[0]]);
 for(let i=0;i<4;i++)await admin.query("INSERT INTO collab.memberships(organization_id,user_id,role) VALUES($1,$2,$3)",[organization,users[i],i===0?"owner":"member"]);
 await admin.query('UPDATE public."user" SET "twoFactorEnabled"=true WHERE id=$1',[users[0]]);
 project=(await createProject(users[0],{organizationId:organization,name:"Git combinations",description:""})).id;
 for(let i=1;i<4;i++)await admin.query("INSERT INTO collab.project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,$4)",[organization,project,users[i],i===3?"reviewer":"developer"]);
 await mkdir(source);for(const args of[["init"],["config","user.name","Integration acceptance"],["config","user.email","integration@test.invalid"]])await exec("git",args,{cwd:source});
 await writeFile(path.join(source,"code.txt"),"baseline\n");await writeFile(path.join(source,".env"),"PRIVATE_FIXTURE=preserved\n");await exec("git",["add","."],{cwd:source});await exec("git",["commit","-m","Imported baseline"],{cwd:source});
 repository=await importLocalRepository(admin,root,{projectId:project,actorId:users[0],source,name:"Local Git target"});
 sourceProfile=await profile("require('node:assert/strict').equal(require('node:fs').readFileSync('code.txt','utf8'),'baseline\\n')");
});
after(async()=>{await store.close();await database().end();globalThis.__piCollabPool=undefined;await admin.end();const cleanup=new Pool({connectionString:connectionString(config,true,"postgres")});await cleanup.query(`DROP DATABASE "${dbName}" WITH (FORCE)`);await cleanup.end();await native.stop();await rm(root,{recursive:true,force:true});});
const task=(title:string,owner=users[1])=>createTask(owner,project,{title,description:"",acceptance:"Actual combined code must pass"});
const version=async(id:string)=>(await admin.query("SELECT version FROM collab.tasks WHERE id=$1",[id])).rows[0].version;
async function claimTask(id:string,owner=users[1]){await startRun(owner,id,{repositoryId:repository.id,baseSha:repository.baseSha,prompt:"Local Pi integration diagnostic",expectedVersion:await version(id),idempotencyKey:randomUUID()});const claim=await store.claim(executor,"native");assert.ok(claim);assert.equal(claim.run.task_id,id);return claim;}
async function finish(c:ClaimedRun,files:Record<string,string|null>,driverWait?:()=>Promise<void>,mutation=""){
 const owner=c.run.requested_by;
 assert.equal(await executeClaim(store,executor,c,{dataRoot:root,backend:new NativeRuntimeBackend(),heartbeatMs:100,driver:async agent=>{await driverWait?.();const script=`const fs=require('node:fs');for(const [p,value] of Object.entries(${JSON.stringify(files)}))(value===null?fs.rmSync(p,{force:true}):fs.writeFileSync(p,value));${mutation}`;await agent.peer.command("bash",{command:`node -e '${script.replaceAll("'","'\\''")}'`});return{kind:"real-pi-integration-diagnostic",modelInference:false};}}),"completed");
 const r=(await runDetail(owner,c.run.id)).run;const captured=await requestSnapshot(owner,r.id,{expectedRevision:r.revision,idempotencyKey:randomUUID(),note:"Immutable integration input"});await processSnapshots(store,root);
 const v=await requestValidation(owner,captured.snapshotId,{profileId:sourceProfile,idempotencyKey:randomUUID()}),claimed=await store.claimValidation(executor);assert.ok(claimed);assert.equal(claimed.id,v.validationId);assert.equal(await executeValidation(store,claimed,root),"passed");
 const published=await publishResult(owner,c.run.task_id,{validationId:v.validationId,expectedVersion:await version(c.run.task_id),idempotencyKey:randomUUID(),note:"Source result awaiting combined checks"});return {...published,claim:c,snapshotId:captured.snapshotId};
}
async function result(title:string,files:Record<string,string>,owner=users[1]){const t=await task(title,owner);return finish(await claimTask(t.id,owner),files);}
async function profile(script:string){return(await createValidationProfile(users[0],project,{repositoryId:repository.id,name:"Combined code check",idempotencyKey:randomUUID(),config:{version:1,steps:[{tool:"node",args:["-e",script],timeoutSeconds:10}]}})).profileId as string;}
const request=(resultIds:string[],profileId=sourceProfile)=>({repositoryId:repository.id,targetSha:repository.baseSha,resultIds,profileId,idempotencyKey:randomUUID()});
const enqueue=(input:ReturnType<typeof request>&{expectedPolicyId?:string},user=users[1])=>requestIntegration(user,project,input);
async function claimIntegration(expected:string){const c=await store.claimIntegration(executor);assert.ok(c);assert.equal(c.id,expected);return c;}
const cancel=(id:string,user=users[1])=>cancelIntegration(user,id,{reason:"Integration is no longer needed for this acceptance",idempotencyKey:randomUUID()});
let policyId:string,policyVersion=0,reviewSource:string,reviewCandidate:string;
const policyInput=(overrides:Record<string,unknown>={})=>({repositoryId:repository.id,profileId:sourceProfile,requiredApprovals:2,reviewerApprovals:true,expectedVersion:policyVersion,reason:"Require independent reviewers and every configured check",idempotencyKey:randomUUID(),...overrides});
async function publishPolicy(overrides:Record<string,unknown>={}){const p=await publishIntegrationPolicy(users[0],project,policyInput(overrides));policyId=p.policyId;policyVersion=p.version;return p;}
const governed=()=>({...request([reviewSource]),expectedPolicyId:policyId});
const reviewState=async(id=reviewCandidate,user=users[0])=>(await integrationDetail(user,id)).integration.review_state;
async function review(user:string,decision:"approve"|"request_changes"|"withdraw",id=reviewCandidate){const s=await reviewState(id,user);return submitIntegrationReview(user,id,{revisionHash:s.revisionHash,expectedVersion:s.ownVersion,decision,note:"Reviewed the pinned source, target, required checks and evidence",idempotencyKey:randomUUID()});}
async function until(predicate:()=>Promise<boolean>){const end=Date.now()+10000;while(!await predicate()){if(Date.now()>end)throw new Error("Integration evidence timeout");await new Promise(resolve=>setTimeout(resolve,20));}}

test("two overlapping real Pi processes yield isolated results; the integration queue merges and actually checks their combined code",async()=>{
 const a=await claimTask((await task("Parallel A")).id),b=await claimTask((await task("Parallel B",users[2])).id,users[2]);let entered=0;const wait=async()=>{entered++;await until(async()=>entered===2);};
 // Execute both Pi processes concurrently; serialize artifact publication below.
 const completed=await Promise.all([a,b].map((c,i)=>executeClaim(store,executor,c,{dataRoot:root,backend:new NativeRuntimeBackend(),heartbeatMs:100,driver:async agent=>{await wait();await agent.peer.command("bash",{command:`printf '${i+1}' > ${i===0?"a":"b"}.txt`});return{kind:"parallel-real-pi",modelInference:false};}})));
 assert.deepEqual(completed,["completed","completed"]);
 const ids:string[]=[];
 for(const c of[a,b]){const owner=c.run.requested_by,r=(await runDetail(owner,c.run.id)).run,s=await requestSnapshot(owner,r.id,{expectedRevision:r.revision,idempotencyKey:randomUUID(),note:"Concurrent real Pi input"});await processSnapshots(store,root);await requestValidation(owner,s.snapshotId,{profileId:sourceProfile,idempotencyKey:randomUUID()});const v=await store.claimValidation(executor);assert.ok(v);assert.equal(await executeValidation(store,v,root),"passed");ids.push((await publishResult(owner,c.run.task_id,{validationId:v.id,expectedVersion:await version(c.run.task_id),idempotencyKey:randomUUID(),note:"Parallel result"})).resultId);}
 const check=await profile("const fs=require('node:fs'),a=require('node:assert/strict');a.equal(fs.readFileSync('a.txt','utf8'),'1');a.equal(fs.readFileSync('b.txt','utf8'),'2');a.equal(fs.existsSync('.env'),false)");
 const op=request(ids,check),accepted=await enqueue(op),replays=await Promise.all(Array.from({length:10},()=>enqueue(op)));assert.ok(replays.every(x=>x.integrationId===accepted.integrationId&&x.replayed));
 const c=await claimIntegration(accepted.integrationId);assert.equal(await executeIntegration(store,c,root),"checked");
 const evidence=(await integrationDetail(users[3],c.id)).integration.evidence;assert.equal(evidence.validation.outcome,"passed");assert.equal(evidence.merges.length,2);assert.equal(evidence.snapshot.excluded.some((e:{path:string})=>e.path===".env"),true);
 assert.equal((await exec("git",["rev-parse","HEAD"],{cwd:source})).stdout.trim(),repository.baseSha);
 assert.equal((await exec("git",["rev-parse","HEAD"],{cwd:path.join(root,"repositories",repository.id,"git")})).stdout.trim(),repository.baseSha);
 assert.equal(await readFile(path.join(root,"workspaces",a.workspace.id,"checkout/a.txt"),"utf8"),"1");await assert.rejects(readFile(path.join(root,"workspaces",a.workspace.id,"checkout/b.txt")),/ENOENT/);
});

test("dependency closure is frozen in topological order; only the same repository and current versions can enter",async()=>{
 const a=await result("Dependency A",{"a.txt":"1"}),t=await task("Dependency B");await addDependency(users[1],t.id,{dependsOn:a.claim.run.task_id,kind:"strict"});const b=await finish(await claimTask(t.id),{"b.txt":"2"});
 const op=request([b.resultId]),accepted=await enqueue(op),c=await claimIntegration(accepted.integrationId);assert.deepEqual(c.sources.map(s=>s.resultId),[a.resultId,b.resultId]);assert.equal(await executeIntegration(store,c,root),"checked");
 for(const user of[users[3],users[4]])await assert.rejects(enqueue({...op,idempotencyKey:randomUUID()},user),/forbidden|not.found|does not exist/i);
 await assert.rejects(enqueue(request([randomUUID()])),/integration_source_unavailable/);
 await assert.rejects(enqueue({...op,profileId:randomUUID(),idempotencyKey:randomUUID()}),/not_found/);
 await assert.rejects(enqueue({...op,targetSha:"f".repeat(40),idempotencyKey:randomUUID()}),/integration_stale/);
 await assert.rejects(enqueue({...op,resultIds:[a.resultId]}),/idempotency_conflict/);
 await assert.rejects(asUser(users[1],db=>db.query("UPDATE collab.integrations SET status='checked'")),/permission/);
 await assert.rejects(integrationDetail(users[4],accepted.integrationId),/not found|不存在/);
});

test("conflicting real Git changes identify the responsible result and base/ours/theirs without modifying sources",async()=>{
 const a=await result("Conflict A",{"shared.txt":"first\n"}),b=await result("Conflict B",{"shared.txt":"second\n"});
 const accepted=await enqueue(request([a.resultId,b.resultId])),c=await claimIntegration(accepted.integrationId);assert.equal(await executeIntegration(store,c,root),"conflicted");const e=(await integrationDetail(users[1],c.id)).integration.evidence;
 assert.equal(e.conflict.files[0].path,"shared.txt");assert.equal(e.conflict.files[0].base,null);assert.match(e.conflict.files[0].ours,/^[a-f0-9]{40}$/);assert.match(e.conflict.files[0].theirs,/^[a-f0-9]{40}$/);assert.equal(e.validation,null);
 const page=await integrationCode(users[3],c.id,{}),file=await integrationCodeFile(users[3],c.id,{path:'shared.txt',diffHash:page.diffHash});assert.equal(file.file.kind,'conflict');assert.equal(file.base,null);assert.deepEqual(new Set([file.before?.text,file.after?.text]),new Set(['first\n','second\n']));assert.equal(file.identity.conflictResultId,e.conflict.resultId);
 for(const[r,text]of[[a,"first\n"],[b,"second\n"]] as const)assert.equal(await readFile(path.join(root,"workspaces",r.claim.workspace.id,"checkout/shared.txt"),"utf8"),text);
});

test("individual source checks cannot certify a failing combined check, and fabricated success evidence is rejected",async()=>{
 const a=await result("Check failure",{"feature.txt":"v1"}),p=await profile("process.exit(7)"),accepted=await enqueue(request([a.resultId],p)),c=await claimIntegration(accepted.integrationId);
 await assert.rejects(store.finishIntegration(c,"checked",null,null),/invalid_integration/);
 assert.equal(await executeIntegration(store,c,root),"check_failed");const e=(await integrationDetail(users[1],c.id)).integration.evidence;assert.equal(e.validation.steps[0].exitCode,7);assert.equal(e.validation.steps[0].cleanupConfirmed,true);
});

test("one target runs serially; cancellation, withdrawal and target movement invalidate queued or old evidence",async()=>{
 const a=await result("Queue source",{"queue.txt":"v1"}),first=await enqueue(request([a.resultId])),second=await enqueue(request([a.resultId]));const c=await claimIntegration(first.integrationId);assert.equal(await store.claimIntegration(randomUUID()),null);
 await cancel(second.integrationId);assert.equal((await integrationDetail(users[1],second.integrationId)).integration.status,"cancelled");assert.equal(await executeIntegration(store,c,root),"checked");
 const third=await enqueue(request([a.resultId]));await withdrawResult(users[1],a.resultId,{reason:"Withdraw source result before integration dispatch"});assert.equal(await store.claimIntegration(executor),null);assert.equal((await integrationDetail(users[1],third.integrationId)).integration.status,"stale");assert.equal((await integrationDetail(users[1],c.id)).integration.input_state,"stale");
 const b=await result("Moved target",{"target.txt":"v1"}),fourth=await enqueue(request([b.resultId]));await admin.query("UPDATE collab.repositories SET base_sha=$2 WHERE id=$1",[repository.id,"e".repeat(40)]);assert.equal(await store.claimIntegration(executor),null);assert.equal((await integrationDetail(users[1],fourth.integrationId)).integration.status,"stale");await admin.query("UPDATE collab.repositories SET base_sha=$2 WHERE id=$1",[repository.id,repository.baseSha]);
});

test("revocation while actual checks run cancels process work; stale epochs cannot certify the candidate",async()=>{
 const a=await result("Revocation source",{"stop.txt":"v1"}),p=await profile("setTimeout(()=>{},30000)"),accepted=await enqueue(request([a.resultId],p),users[2]),c=await claimIntegration(accepted.integrationId);
 const work=executeIntegration(store,c,root,undefined,30);await until(async()=>(await integrationDetail(users[0],c.id)).integration.status==="checking");
 await admin.query("UPDATE collab.project_memberships SET active=false WHERE project_id=$1 AND user_id=$2",[project,users[2]]);assert.equal(await work,"revoked");await assert.rejects(store.finishIntegration({...c,epoch:String(BigInt(c.epoch)+BigInt(1))},"checked",null,null),/integration_lease_lost/);
});

test("corrupt source artifacts fail before project checks and cannot become a checked candidate",async()=>{
 const a=await result("Corrupt input",{"corrupt.txt":"unique artifact bytes"}),accepted=await enqueue(request([a.resultId]));
 const manifest=JSON.parse(await readFile(path.join(root,"snapshots",a.snapshotId,"manifest.json"),"utf8")),entry=manifest.worktree.find((e:{path:string})=>e.path==="corrupt.txt");assert.ok(entry);
 await writeFile(path.join(root,"snapshots",a.snapshotId,"blobs",entry.hash),"tampered");
 const c=await claimIntegration(accepted.integrationId);assert.equal(await executeIntegration(store,c,root),"check_failed");assert.equal((await integrationDetail(users[1],c.id)).integration.error_code,"snapshot_invalid_artifact");
});

test("an actual TCP cut during project checks stops the process and leaves the target unknown; late completion cannot overwrite it",async()=>{
 const a=await result("Disconnected integrator",{"late.txt":"v1"}),p=await profile("require('node:fs').writeFileSync('../started',String(process.pid));setTimeout(()=>{},30000)"),first=await enqueue(request([a.resultId],p)),second=await enqueue(request([a.resultId])),c=await claimIntegration(first.integrationId);
 let online=true;const sockets=new Set<Socket>(),proxy=createServer(client=>{if(!online){client.destroy();return;}const upstream=createConnection({host:"127.0.0.1",port:config.databasePort});for(const s of[client,upstream]){sockets.add(s);s.on("error",()=>{client.destroy();upstream.destroy();});s.on("close",()=>sockets.delete(s));}client.pipe(upstream).pipe(client);});await new Promise<void>(resolve=>proxy.listen(0,"127.0.0.1",resolve));
 const url=new URL(executorConnectionString(config,dbName));url.port=String((proxy.address() as {port:number}).port);const offline=new ExecutionStore(url.toString());
 try{
  const work=executeIntegration(offline,c,root,undefined,30).then(()=>false,()=>true);let pid=0;
  await until(async()=>{try{pid=Number(await readFile(path.join(root,"workspaces",c.checkId,"started"),"utf8"));return pid>0;}catch{return false;}});
  online=false;for(const s of sockets)s.destroy();assert.equal(await work,true);
  await until(async()=>{try{process.kill(pid,0);return false;}catch(error){return (error as NodeJS.ErrnoException).code==="ESRCH";}});
 }finally{for(const s of sockets)s.destroy();await offline.close();await new Promise<void>(resolve=>proxy.close(()=>resolve()));}
 await admin.query("UPDATE collab.integrations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[c.id]);assert.equal(await store.claimIntegration(randomUUID()),null);
 assert.equal((await integrationDetail(users[1],c.id)).integration.status,"unknown");assert.equal(await store.heartbeatIntegration(c),false);assert.equal(await store.finishIntegration(c,"check_failed",null,"late_worker"),"unknown");await cancel(second.integrationId);
 const list=await listIntegrations(users[3],project);assert.ok(list.integrations.some(i=>i.id===c.id&&i.status==="unknown"));
});

test("immutable required-check policy uses scoped maintainer authority, idempotency and optimistic concurrency",async()=>{
 // A second imported repository leaves the previous unknown target quarantined.
 repository=await importLocalRepository(admin,root,{projectId:project,actorId:users[0],source,name:"Governed Git target"});
 await admin.query("UPDATE collab.project_memberships SET active=true WHERE project_id=$1 AND user_id=$2",[project,users[2]]);
 sourceProfile=(await createValidationProfile(users[0],project,{repositoryId:repository.id,name:"Two mandatory checks",idempotencyKey:randomUUID(),config:{version:1,steps:[{tool:"node",args:["-e","require('node:assert/strict').equal(require('node:fs').readFileSync('code.txt','utf8'),'baseline\\n')"],timeoutSeconds:10},{tool:"node",args:["-e","require('node:assert/strict').equal(require('node:fs').existsSync('review.txt'),true)"],timeoutSeconds:10}]}})).profileId;
 const input=policyInput();
 for(const u of[users[1],users[3],users[4]])await assert.rejects(publishIntegrationPolicy(u,project,input),/forbidden|not.found|does not exist/i);
 await assert.rejects(publishIntegrationPolicy(users[0],project,{...input,profileId:randomUUID()}),/not_found/);
 const p=await publishIntegrationPolicy(users[0],project,input);policyId=p.policyId;policyVersion=p.version;
 const replay=await Promise.all(Array.from({length:8},()=>publishIntegrationPolicy(users[0],project,input)));assert.ok(replay.every(r=>r.policyId===policyId&&r.replayed));
 await assert.rejects(publishIntegrationPolicy(users[0],project,{...input,requiredApprovals:1}),/idempotency_conflict/);
 const results=await Promise.allSettled([publishIntegrationPolicy(users[0],project,policyInput()),publishIntegrationPolicy(users[0],project,policyInput())]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.match(String((results.find(r=>r.status==='rejected') as PromiseRejectedResult).reason),/stale_integration_policy/);
 const current=(await listIntegrationPolicies(users[0],project)).policies.find(p=>p.repository_id===repository.id)!;policyId=current.id;policyVersion=current.version;
 assert.equal((await publishIntegrationPolicy(users[0],project,input)).policyId,p.policyId);
 for(const sql of["UPDATE collab.integration_policies SET required_approvals=1","DELETE FROM collab.integration_policies","SELECT collab_worker.request_integration_v16($1,$2,$3,$4,$5)"]){await assert.rejects(asUser(users[1],db=>db.query(sql,sql.includes('$1')?[repository.id,repository.baseSha,[],sourceProfile,randomUUID()]:undefined)),/permission/);}
 assert.equal((await asUser(users[4],db=>db.query("SELECT id FROM collab.integration_policies"))).rowCount,0);
 const legacy=(await admin.query("SELECT id FROM collab.integrations WHERE status='checked' AND policy_id IS NULL LIMIT 1")).rows[0].id;assert.equal((await reviewState(legacy)).reviewSatisfied,false);
});

test("policy pins mandatory steps through the existing worker protocol; contributors cannot approve",async()=>{
 reviewSource=(await result("Governed source",{"review.txt":"review version 1"})).resultId;
 await assert.rejects(enqueue(request([reviewSource])),/stale_integration_policy/);
 const weak=await profile("process.exit(0)");await assert.rejects(enqueue({...governed(),profileId:weak}),/required_integration_profile/);
 const op=governed(),accepted=await enqueue(op,users[2]);reviewCandidate=accepted.integrationId;
 assert.equal((await enqueue(op,users[2])).integrationId,reviewCandidate);
 await assert.rejects(submitIntegrationReview(users[3],reviewCandidate,{revisionHash:'a'.repeat(64),expectedVersion:0,decision:'approve',note:'Cannot approve before required checks complete',idempotencyKey:randomUUID()}),/integration_not_reviewable/);
 const c=await claimIntegration(reviewCandidate);assert.equal(c.config.steps.length,2);assert.equal(await executeIntegration(store,c,root),"checked");
 const detail=(await integrationDetail(users[3],reviewCandidate)).integration;assert.equal(detail.evidence.validation.steps.length,2);assert.ok(detail.evidence.validation.steps.every((s:{exitCode:number})=>s.exitCode===0));assert.equal(detail.policy_id,policyId);
 for(const contributor of[users[1],users[2]])await assert.rejects(review(contributor,"approve"),/integration_self_approval/);
 await assert.rejects(submitIntegrationReview(users[3],reviewCandidate,{revisionHash:'f'.repeat(64),expectedVersion:0,decision:'approve',note:'Cannot reuse a different code revision',idempotencyKey:randomUUID()}),/integration_not_reviewable/);
 await assert.rejects(asUser(users[3],db=>db.query("UPDATE collab.integration_reviews SET decision='approve'")),/permission/);
 await review(users[0],"approve");assert.equal((await reviewState()).reviewSatisfied,false);
});

test("version-bound reviews deduplicate retries and prevent same-reviewer lost updates across sessions",async()=>{
 const state=await reviewState(),input={revisionHash:state.revisionHash,expectedVersion:0,decision:'approve' as const,note:'Independent reviewer checked both mandatory check results',idempotencyKey:randomUUID()};
 const results=await Promise.all(Array.from({length:8},()=>submitIntegrationReview(users[3],reviewCandidate,input)));assert.equal(new Set(results.map(r=>r.reviewId)).size,1);assert.equal((await reviewState()).reviewSatisfied,true);
 await assert.rejects(submitIntegrationReview(users[3],reviewCandidate,{...input,decision:'withdraw'}),/idempotency_conflict/);
 const concurrent=await Promise.allSettled(['request_changes','withdraw'].map(decision=>submitIntegrationReview(users[3],reviewCandidate,{...input,decision:decision as 'withdraw'|'request_changes',expectedVersion:1,idempotencyKey:randomUUID()})));assert.equal(concurrent.filter(r=>r.status==='fulfilled').length,1);assert.match(String((concurrent.find(r=>r.status==='rejected') as PromiseRejectedResult).reason),/stale_integration_review/);
 assert.equal((await reviewState()).reviewSatisfied,false);await review(users[3],'approve');assert.equal((await reviewState()).reviewSatisfied,true);
 const history=await asUser(users[0],db=>db.query("SELECT version FROM collab.integration_reviews WHERE integration_id=$1 AND reviewer_id=$2 ORDER BY version",[reviewCandidate,users[3]]));assert.deepEqual(history.rows.map(r=>r.version),[1,2,3]);
 await admin.query("UPDATE collab.project_memberships SET role='viewer' WHERE project_id=$1 AND user_id=$2",[project,users[3]]);await assert.rejects(review(users[3],'request_changes'),/forbidden/);assert.equal((await reviewState()).approvals,1);
 await admin.query("UPDATE collab.project_memberships SET role='reviewer' WHERE project_id=$1 AND user_id=$2",[project,users[3]]);assert.equal((await reviewState()).approvals,1);await review(users[3],'approve');assert.equal((await reviewState()).reviewSatisfied,true);
 const bundle=await resultEvidence(users[3],reviewSource),record=bundle.payload.integrations.find(i=>i.id===reviewCandidate);
 assert.ok(record);assert.ok(record.reviews.length>=4);assert.deepEqual(record.reviewState,await reviewState(reviewCandidate,users[3]));
});

test("revocation never revives an approval or silently removes a blocking change request",async()=>{
 await admin.query("UPDATE collab.memberships SET active=false WHERE organization_id=$1 AND user_id=$2",[organization,users[3]]);assert.equal((await reviewState()).approvals,1);
 await admin.query("UPDATE collab.memberships SET active=true WHERE organization_id=$1 AND user_id=$2",[organization,users[3]]);assert.equal((await reviewState()).approvals,1);
 await review(users[3],'request_changes');assert.equal((await reviewState()).blockers,1);
 await admin.query("UPDATE collab.project_memberships SET active=false WHERE project_id=$1 AND user_id=$2",[project,users[3]]);assert.equal((await reviewState()).blockers,1);assert.equal((await reviewState()).reviewSatisfied,false);
 await admin.query("UPDATE collab.project_memberships SET active=true WHERE project_id=$1 AND user_id=$2",[project,users[3]]);await review(users[3],'withdraw');assert.equal((await reviewState()).blockers,0);assert.equal((await reviewState()).reviewSatisfied,false);
 await review(users[3],'approve');assert.equal((await reviewState()).reviewSatisfied,true);
 await assert.rejects(admin.query('UPDATE public."user" SET "twoFactorEnabled"=false WHERE id=$1',[users[0]]),/mfa_required/);assert.equal((await reviewState()).reviewSatisfied,true);
});

test("new policy invalidates approvals and queued work; reviewer role counting follows the pinned policy",async()=>{
 const old=governed(),queued=await enqueue(old),oldPolicy=policyId;await publishPolicy({requiredApprovals:1,reviewerApprovals:false});assert.notEqual(oldPolicy,policyId);
 const state=await reviewState();assert.equal(state.policyCurrent,false);assert.equal(state.approvals,0);assert.equal(state.reviewSatisfied,false);await assert.rejects(review(users[3],'approve'),/integration_not_reviewable/);
 assert.equal(await store.claimIntegration(executor),null);assert.equal((await integrationDetail(users[1],queued.integrationId)).integration.status,'stale');assert.equal((await enqueue(old)).integrationId,queued.integrationId);
 const next=await enqueue(governed(),users[2]),c=await claimIntegration(next.integrationId);assert.equal(await executeIntegration(store,c,root),'checked');reviewCandidate=c.id;
 await review(users[3],'approve');assert.equal((await reviewState()).approvals,0);await review(users[0],'approve');assert.equal((await reviewState()).reviewSatisfied,true);
 await review(users[3],'request_changes');assert.equal((await reviewState()).blockers,1);assert.equal((await reviewState()).reviewSatisfied,false);await review(users[3],'withdraw');assert.equal((await reviewState()).reviewSatisfied,true);
 await admin.query("UPDATE collab.repositories SET base_sha=$2 WHERE id=$1",[repository.id,'d'.repeat(40)]);assert.equal((await reviewState()).reviewSatisfied,false);await admin.query("UPDATE collab.repositories SET base_sha=$2 WHERE id=$1",[repository.id,repository.baseSha]);
 await withdrawResult(users[1],reviewSource,{reason:'Withdrawal must invalidate formal approvals as well as checks'});assert.equal((await reviewState()).approvals,0);assert.equal((await reviewState()).reviewSatisfied,false);
});

test("policy changes during real checks stop execution and cannot certify a stale candidate",async()=>{
 reviewSource=(await result('Policy race source',{'review.txt':'review version 2'})).resultId;
 const slow=await profile("require('node:fs').writeFileSync('../policy-started',String(process.pid));setTimeout(()=>{},30000)");await publishPolicy({profileId:slow});
 const accepted=await enqueue({...governed(),profileId:slow}),c=await claimIntegration(accepted.integrationId);const work=executeIntegration(store,c,root,undefined,30);let pid=0;
 await until(async()=>{try{pid=Number(await readFile(path.join(root,'workspaces',c.checkId,'policy-started'),'utf8'));return pid>0;}catch{return false;}});
 await publishPolicy();assert.equal(await work,'stale');await until(async()=>{try{process.kill(pid,0);return false;}catch(error){return (error as NodeJS.ErrnoException).code==='ESRCH';}});
 assert.equal((await reviewState(c.id)).reviewSatisfied,false);assert.equal(await store.heartbeatIntegration(c),false);
});

let codeCandidate:string,codeResult:string,codeSnapshot:string;
test("reviewers browse the exact combined Git delta with pagination, modes, encoding, omissions and stable identities",async()=>{
 const source2=path.join(root,'review-source');await exec('git',['clone','--no-local',source,source2]);
 await writeFile(path.join(source2,'diff.txt'),'alpha\nsame\nomega\n');await writeFile(path.join(source2,'delete.txt'),'removed text\n');await writeFile(path.join(source2,'mode.sh'),'echo reviewed\n');await writeFile(path.join(source2,'secret-deleted.txt'),'sk-'+ 'a'.repeat(28));
 await exec('git',['add','.'],{cwd:source2});await exec('git',['-c','user.name=Review fixture','-c','user.email=review@test.invalid','commit','-m','Code review baseline'],{cwd:source2});
 repository=await importLocalRepository(admin,root,{projectId:project,actorId:users[0],source:source2,name:'Review bytes'});sourceProfile=await profile("require('node:assert/strict').equal(require('node:fs').readFileSync('code.txt','utf8'),'baseline\\n')");policyVersion=0;await publishPolicy();
 const files:Record<string,string|null>={'diff.txt':'alpha\nchanged\nomega\n','delete.txt':null,'secret-deleted.txt':null,'crlf.txt':'one\r\ntwo\r\n','binary.dat':'binary\0bytes','large.txt':'x'.repeat(300000),'literal.html':'<img src=x onerror="globalThis.reviewInjected=true">','direction.txt':'start\u202Eend'};
 for(let i=0;i<105;i++)files[`page-${String(i).padStart(3,'0')}.txt`]=String(i);
 const c=await claimTask((await task('Exact code review')).id),sourceResult=await finish(c,files,undefined,"fs.chmodSync('mode.sh',0o755);fs.writeFileSync('utf16.txt',Buffer.from([255,254,65,0]));require('node:child_process').execFileSync('git',['add','-A']);require('node:child_process').execFileSync('git',['commit','-m','Saved review input']);");
 codeResult=sourceResult.resultId;codeSnapshot=sourceResult.snapshotId;
 const accepted=await enqueue({...request([codeResult]),expectedPolicyId:policyId});codeCandidate=accepted.integrationId;assert.equal(await executeIntegration(store,await claimIntegration(codeCandidate),root),'checked');
 const first=await integrationCode(users[3],codeCandidate,{});assert.equal(first.files.length,100);assert.equal(first.nextOffset,100);const second=await integrationCode(users[3],codeCandidate,{offset:100,diffHash:first.diffHash});assert.equal(second.nextOffset,null);assert.equal(first.files.length+second.files.length,first.total);assert.equal(second.diffHash,first.diffHash);
 const get=(file:string)=>integrationCodeFile(users[3],codeCandidate,{path:file,diffHash:first.diffHash});
 const diff=await get('diff.txt');assert.equal(diff.before?.text,'alpha\nsame\nomega\n');assert.equal(diff.after?.text,'alpha\nchanged\nomega\n');assert.ok(diff.lines.some(line=>line.kind==='removed'&&line.before===2&&line.text==='same'));assert.ok(diff.lines.some(line=>line.kind==='added'&&line.after===2&&line.text==='changed'));
 const deleted=await get('delete.txt');assert.equal(deleted.after,null);assert.equal(deleted.file.kind,'deleted');assert.ok(deleted.lines.some(line=>line.kind==='removed'));
 const mode=await get('mode.sh');assert.equal(mode.before?.mode,'100644');assert.equal(mode.after?.mode,'100755');assert.equal(mode.lines.length,0);
 assert.equal((await get('crlf.txt')).after?.lineEndings,'crlf');assert.equal((await get('binary.dat')).after?.text,null);assert.equal((await get('utf16.txt')).after?.encoding,'unsupported');assert.equal((await get('large.txt')).omitted,'non_text_or_large');
 const secret=await get('secret-deleted.txt');assert.equal(secret.omitted,'secret_pattern');assert.equal(secret.before,null);assert.equal(secret.after,null);assert.ok(!JSON.stringify(secret).includes('a'.repeat(28)));assert.equal((await get('.env')).omitted,'private_path');
 assert.equal((await get('literal.html')).after?.text,files['literal.html']);assert.equal((await get('direction.txt')).after?.text,'start⟦U+202E⟧end');
 const checkout=path.join(root,'workspaces',codeCandidate,'checkout');await exec('git',['reset','--soft',repository.baseSha],{cwd:checkout});await writeFile(path.join(checkout,'diff.txt'),'mutable files must not appear');
 assert.equal((await get('diff.txt')).after?.text,diff.after?.text);assert.equal((await integrationCode(users[3],codeCandidate,{})).diffHash,first.diffHash);
 await assert.rejects(integrationCode(users[4],codeCandidate,{}),/不存在/);await assert.rejects(integrationCodeFile(users[3],codeCandidate,{path:'../../private',diffHash:first.diffHash}),/不存在/);await assert.rejects(integrationCode(users[3],codeCandidate,{diffHash:'f'.repeat(64)}),/不匹配/);
 await withdrawResult(users[1],codeResult,{reason:'Historical exact code remains readable but no longer reviewable'});assert.equal((await get('diff.txt')).inputState,'stale');assert.equal((await integrationCode(users[3],codeCandidate,{})).diffHash,first.diffHash);
});

test("code reads reject corrupt objects, altered snapshot bytes and symlinked Git state without invoking project diff drivers",async()=>{
 const page=await integrationCode(users[3],codeCandidate,{}),gitDir=path.join(root,'repositories',repository.id,'git');
 const pack=path.join(gitDir,'objects','pack',(await readdir(path.join(gitDir,'objects','pack'))).find(name=>name.endsWith('.pack'))!),packed=await readFile(pack);
 await chmod(pack,0o600);try{await writeFile(pack,Buffer.alloc(packed.length));await assert.rejects(integrationCode(users[3],codeCandidate,{}),/校验失败/);}finally{await writeFile(pack,packed);await chmod(pack,0o444);}
 const fixture=path.join(root,'hash-fixture.txt');await writeFile(fixture,'independent object hash verification');const oid=(await exec('git',[`--git-dir=${gitDir}`,'hash-object','-w',fixture])).stdout.trim(),loose=path.join(gitDir,'objects',oid.slice(0,2),oid.slice(2));
 await chmod(loose,0o600);await writeFile(loose,deflateSync(Buffer.from('blob 17\0tampered content!')));const reader=await ReviewGit.open(root,['repositories',repository.id,'git'],new AbortController().signal);await assert.rejects(reader.objects([oid],'blob'),/integration_code_unavailable/);await rm(loose);
 const checkout=path.join(root,'workspaces',codeCandidate,'checkout'),marker=path.join(root,'external-diff-ran');await exec('git',['config','diff.external',`touch ${marker}`],{cwd:checkout});await exec('git',['config','diff.test.textconv',`touch ${marker}`],{cwd:checkout});
 assert.ok((await integrationCodeFile(users[3],codeCandidate,{path:'diff.txt',diffHash:page.diffHash})).lines.length);await assert.rejects(readFile(marker),/ENOENT/);
 const configFile=path.join(checkout,'.git','config'),configBytes=await readFile(configFile);await rm(configFile);await symlink(path.join(gitDir,'config'),configFile);try{await assert.rejects(integrationCode(users[3],codeCandidate,{}),/校验失败/);}finally{await rm(configFile);await writeFile(configFile,configBytes);}
 const manifest=JSON.parse(await readFile(path.join(root,'snapshots',codeCandidate,'manifest.json'),'utf8')),entry=manifest.worktree.find((e:{path:string})=>e.path==='diff.txt'),blob=path.join(root,'snapshots',codeCandidate,'blobs',entry.hash),bytes=await readFile(blob);
 try{await writeFile(blob,'tampered');await assert.rejects(integrationCode(users[3],codeCandidate,{}),/校验失败/);}finally{await writeFile(blob,bytes);}
 assert.ok(codeSnapshot);
});

test("revocation during an actual code read blocks its response and concurrent readers have a bounded admission limit",async()=>{
 const {ReviewGit:SharedReviewGit}=createRequire(import.meta.url)('../../lib/collab/runtime/review-git.ts') as {ReviewGit:typeof ReviewGit};
 const original=SharedReviewGit.prototype.tree;let entered=0;let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;});
 SharedReviewGit.prototype.tree=async function(commit:string){entered++;await waiting;return original.call(this,commit);};
 try{
  const first=integrationCode(users[3],codeCandidate,{}),second=integrationCode(users[1],codeCandidate,{});await until(async()=>entered>=2);
  await assert.rejects(integrationCode(users[0],codeCandidate,{}),/稍后重试/);
  await admin.query("UPDATE collab.project_memberships SET active=false WHERE project_id=$1 AND user_id=$2",[project,users[3]]);release();
  await assert.rejects(first,/不存在/);assert.equal((await second).identity.integrationId,codeCandidate);
 }finally{release();SharedReviewGit.prototype.tree=original;await admin.query("UPDATE collab.project_memberships SET active=true WHERE project_id=$1 AND user_id=$2",[project,users[3]]);}
 const controller=new AbortController();controller.abort();await assert.rejects(integrationCode(users[3],codeCandidate,{},controller.signal),/校验失败/);
});

test("conflicts expose verified common-base and both competing snapshots without writing any resolution",async()=>{
 const a=await result('Three-way A',{'diff.txt':'alpha\nleft\nomega\n'}),b=await result('Three-way B',{'diff.txt':'alpha\nright\nomega\n'},users[2]);
 const accepted=await enqueue({...request([a.resultId,b.resultId]),expectedPolicyId:policyId}),c=await claimIntegration(accepted.integrationId);assert.equal(await executeIntegration(store,c,root),'conflicted');
 const listing=await integrationCode(users[3],c.id,{}),file=await integrationCodeFile(users[3],c.id,{path:'diff.txt',diffHash:listing.diffHash});assert.equal(file.base?.text,'alpha\nsame\nomega\n');assert.deepEqual(new Set([file.before?.text,file.after?.text]),new Set(['alpha\nleft\nomega\n','alpha\nright\nomega\n']));
 assert.equal(await readFile(path.join(root,'workspaces',a.claim.workspace.id,'checkout/diff.txt'),'utf8'),'alpha\nleft\nomega\n');assert.equal(await readFile(path.join(root,'workspaces',b.claim.workspace.id,'checkout/diff.txt'),'utf8'),'alpha\nright\nomega\n');assert.equal(file.lines.length,0);
});

test("fixed integration line discussions bind source tasks, preserve historical bytes and protect referenced artifacts",async()=>{
 const {discussionCommand,discussionDetail,discussions}=await import("../../lib/collab/discussions");
 const {reviewDiscussionContext,reviewDiscussionCode}=await import("../../lib/collab/review-discussions");
 const r=await result("Discuss fixed integration",{"inline.txt":"first\nsecond\n"});
 const queued=await enqueue({...request([r.resultId]),expectedPolicyId:policyId}),claim=await claimIntegration(queued.integrationId);
 assert.equal(await executeIntegration(store,claim,root),"checked");
 const page=await integrationCode(users[3],claim.id,{}),context=await reviewDiscussionContext(users[3],"integration",claim.id);
 assert.ok(context.tasks.some(t=>t.id===r.claim.run.task_id));
 const anchor={kind:"integration" as const,sourceId:claim.id,sourceHash:context.sourceHash,diffHash:page.diffHash,path:"inline.txt",side:"after" as const,startLine:1,endLine:2};
 const input={action:"create" as const,title:"Inspect these exact lines",body:"Discuss this combination before approval",mentions:[users[1]],anchor:null,replacement:null,reviewAnchor:anchor,idempotencyKey:randomUUID()};
 const posted=await discussionCommand(users[3],r.claim.run.task_id,input);
 assert.deepEqual((await discussionDetail(users[1],posted.threadId)).thread.review_anchor,anchor);
 const metadata=(await asUser(users[1],db=>db.query("SELECT collab.result_evidence_metadata($1) AS value",[r.resultId]))).rows[0].value;
 assert.deepEqual(metadata.discussions.find((d:{id:string})=>d.id===posted.threadId).reviewAnchor,anchor);
 await assert.rejects(discussionCommand(users[3],r.claim.run.task_id,{...input,reviewAnchor:{...anchor,side:"before"},idempotencyKey:randomUUID()}),/行范围/);
 await assert.rejects(discussionCommand(users[3],r.claim.run.task_id,{...input,reviewAnchor:{...anchor,sourceHash:"0".repeat(64)},idempotencyKey:randomUUID()}),/不匹配/);
 const other=await task("Unrelated comment task");await assert.rejects(discussionCommand(users[3],other.id,{...input,idempotencyKey:randomUUID()}),/invalid_discussion/);
 const {side,startLine,endLine,...source}=anchor;void side;void startLine;void endLine;
 assert.equal((await discussions(users[3],r.claim.run.task_id,0,source)).total,1);
 assert.equal((await discussions(users[3],r.claim.run.task_id,0,{...source,diffHash:"0".repeat(64)})).total,0);
 assert.equal((await admin.query("SELECT collab_worker.artifact_protection('integration',$1) AS reason",[claim.id])).rows[0].reason,"integration_referenced");
 await withdrawResult(users[1],r.resultId,{reason:"Replace source after this fixed review comment"});
 const historical=await reviewDiscussionCode(users[3],anchor);assert.equal(historical.current,false);assert.equal(historical.text,"first\nsecond\n");
 await assert.rejects(reviewDiscussionContext(users[4],"integration",claim.id),/not_found/);
 await writeFile(path.join(root,"snapshots",claim.id,"manifest.json"),"{}");
 await assert.rejects(reviewDiscussionCode(users[3],anchor),/校验失败/);
 assert.deepEqual((await discussionDetail(users[1],posted.threadId)).thread.review_anchor,anchor);

});
