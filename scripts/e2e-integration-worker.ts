import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import path from "node:path";
import {Pool} from "pg";
import {z} from "zod";
import {localConfig,applicationEnvironment,connectionString,executorConnectionString} from "./local-config";
import {database} from "../lib/collab/database";
import {ExecutionStore} from "../lib/collab/execution-store";
import {startRun,runDetail} from "../lib/collab/runs";
import {executeClaim} from "../lib/collab/executor";
import {NativeRuntimeBackend} from "../lib/collab/runtime/backends";
import {requestSnapshot,processSnapshots} from "../lib/collab/snapshots";
import {createValidationProfile,requestValidation} from "../lib/collab/validations";
import {executeValidation} from "../lib/collab/validation-worker";
import {publishResult} from "../lib/collab/task-results";
import {executePromotion} from "../lib/collab/promotion-worker";
import {executeIntegration} from "../lib/collab/integration-worker";
const dbName=process.env.PI_COLLAB_E2E_DATABASE??"",root=process.env.PI_COLLAB_E2E_DATA??"";
if(!/^pi_collab_test_[a-f0-9]+$/.test(dbName)||!path.basename(root).startsWith("identity-e2e-"))throw new Error("Isolated integration fixture required");
const config=await localConfig();Object.assign(process.env,applicationEnvironment(config),{DATABASE_URL:connectionString(config,false,dbName),PI_COLLAB_DATA_DIR:root});
const admin=new Pool({connectionString:connectionString(config,true,dbName)}),store=new ExecutionStore(executorConnectionString(config,dbName)),executor=randomUUID();
try{
 if(process.argv[2]==="publish"){
  const taskId=z.uuid().parse(process.argv[3]),repositoryId=z.uuid().parse(process.argv[4]),file=z.enum(["collab-alpha.txt","collab-beta.txt"]).parse(process.argv[5]),value=z.enum(["alpha","beta","conflict"]).parse(process.argv[6]);
  const task=(await admin.query("SELECT t.*,p.created_by AS maintainer FROM collab.tasks t JOIN collab.projects p ON p.id=t.project_id WHERE t.id=$1",[taskId])).rows[0];assert.ok(task);
  const repo=(await admin.query("SELECT base_sha FROM collab.repositories WHERE id=$1 AND project_id=$2",[repositoryId,task.project_id])).rows[0];assert.ok(repo);
  await startRun(task.owner_id,taskId,{repositoryId,baseSha:repo.base_sha,prompt:"Integration browser source diagnostic",expectedVersion:task.version,idempotencyKey:randomUUID()});
  const claim=await store.claim(executor,"native");assert.ok(claim);assert.equal(claim.run.task_id,taskId);
  assert.equal(await executeClaim(store,executor,claim,{dataRoot:root,backend:new NativeRuntimeBackend(),driver:async agent=>{await agent.peer.command("bash",{command:`printf '${value}' > ${file}`});if(value==="alpha")await agent.peer.command("bash",{command:"printf '<img src=x onerror=\"globalThis.reviewInjected=true\">' > collab-review.html"});return{kind:"browser-real-pi-integration-input",modelInference:false};}}),"completed");
  const run=(await runDetail(task.owner_id,claim.run.id)).run,snapshot=await requestSnapshot(task.owner_id,run.id,{expectedRevision:run.revision,idempotencyKey:randomUUID(),note:"Actual Pi input for local integration"});await processSnapshots(store,root);
  const p=await createValidationProfile(task.maintainer,task.project_id,{repositoryId,name:`Source ${value} check`,idempotencyKey:randomUUID(),config:{version:1,steps:[{tool:"node",args:["-e",`require('node:assert/strict').equal(require('node:fs').readFileSync('${file}','utf8'),'${value}')`],timeoutSeconds:10}]}});
  await requestValidation(task.owner_id,snapshot.snapshotId,{profileId:p.profileId,idempotencyKey:randomUUID()});const v=await store.claimValidation(executor);assert.ok(v);assert.equal(await executeValidation(store,v,root),"passed");
  const version=(await admin.query("SELECT version FROM collab.tasks WHERE id=$1",[taskId])).rows[0].version;
  const result=await publishResult(task.owner_id,taskId,{validationId:v.id,expectedVersion:version,idempotencyKey:randomUUID(),note:"Real Pi source; combined validation still required"});console.log(JSON.stringify(result));
 }else if(process.argv[2]==="integrate"){
  const expected=z.uuid().parse(process.argv[3]),claim=await store.claimIntegration(executor);assert.ok(claim);assert.equal(claim.id,expected);console.log(JSON.stringify({integrationId:claim.id,outcome:await executeIntegration(store,claim,root)}));
 }else if(process.argv[2]==="promote"||process.argv[2]==="promotion-crash"){
  const expected=z.uuid().parse(process.argv[3]),claim=await store.claimPromotion(executor);assert.ok(claim);assert.equal(claim.id,expected);
  const hooks=process.argv[2]==="promotion-crash"?{afterTargetUpdate:async()=>{throw new Error("promotion_simulated_crash");}}:{};
  console.log(JSON.stringify({promotionId:claim.id,outcome:await executePromotion(store,claim,root,undefined,5000,hooks)}));
 }else if(process.argv[2]==="repair-run"){
  const taskId=z.uuid().parse(process.argv[3]),claim=await store.claim(executor,"native");assert.ok(claim?.resolution);assert.equal(claim.run.task_id,taskId);assert.equal(claim.resolution.sources.length,3);
  const outcome=await executeClaim(store,executor,claim,{dataRoot:root,backend:new NativeRuntimeBackend(),gatewayUrl:`http://127.0.0.1:${config.gatewayPort}/v1`,driver:async agent=>{
   const result=await agent.peer.command("bash",{command:"node -e 'const fs=require(\"node:fs\"),a=require(\"node:assert/strict\");a.equal(JSON.parse(fs.readFileSync(\"../resolution.json\",\"utf8\")).sources.length,3);a.equal(fs.readFileSync(\"collab-beta.txt\",\"utf8\"),\"beta\");fs.writeFileSync(\"collab-alpha.txt\",\"resolved\");process.stdout.write(\"Repaired alpha; preserved the later beta input; no binary/rename/deletion conflicts in this fixture.\");'"});assert.equal((result.data as {exitCode:number}).exitCode,0);
   return{kind:"browser-real-pi-repair",modelInference:false};
  }});assert.equal(outcome,"completed");console.log(JSON.stringify({runId:claim.run.id,workspaceId:claim.workspace.id,outcome}));
 }else if(process.argv[2]==="capture"){
  await processSnapshots(store,root);console.log(JSON.stringify({captured:true}));
 }else if(process.argv[2]==="validate"){
  const claim=await store.claimValidation(executor);assert.ok(claim);console.log(JSON.stringify({validationId:claim.id,outcome:await executeValidation(store,claim,root)}));
 }else throw new Error("Unsupported integration fixture action");
}finally{await store.close();await admin.end();if(globalThis.__piCollabPool){await database().end();globalThis.__piCollabPool=undefined;}}
