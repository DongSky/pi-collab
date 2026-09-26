import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { z } from "zod";
import { localConfig, connectionString, executorConnectionString, brokerConnectionString } from "./local-config";
import { ExecutionStore } from "../lib/collab/execution-store";
import { ResourceStore } from "../lib/collab/resources/store";
import { executeResourceJob } from "../lib/collab/resources/worker";
import { coordinate } from "../lib/collab/coordination-server";
import { masterKey } from "../lib/collab/gateway/credentials";
const databaseName=process.env.PI_COLLAB_E2E_DATABASE??"",root=process.env.PI_COLLAB_E2E_DATA??"";
if(!/^pi_collab_test_[a-f0-9]+$/.test(databaseName)||!path.basename(root).startsWith("identity-e2e-"))throw new Error("Isolated resource browser fixture required");
const config=await localConfig(),admin=new Pool({connectionString:connectionString(config,true,databaseName)}),worker=new ExecutionStore(executorConnectionString(config,databaseName)),broker=new ResourceStore(brokerConnectionString(config,databaseName));
const key=await masterKey(path.join(root,"resource-test.key"),true),mode=process.argv[2];
try{
 if(mode==="environment-reconcile"){await broker.reconcile();await broker.reconcileEnvironments();await broker.provision(key);console.log(JSON.stringify({ready:true}));}
 else if(mode==="provision"){await broker.provision(key);console.log(JSON.stringify({ready:true}));}
 else if(mode==="start"){
  const a=z.uuid().parse(process.argv[3]),b=z.uuid().parse(process.argv[4]),resourceId=z.uuid().parse(process.argv[5]),executor=randomUUID();
  const runs=[];
  for(const taskId of[a,b]){const claim=await worker.claim(executor,"native");assert.ok(claim);assert.equal(claim.run.task_id,taskId);await worker.running(executor,claim.run.id,claim.run.epoch);
   const request=await coordinate(worker,executor,claim.run.id,claim.run.epoch,"request_resource",{resourceIds:[resourceId],idempotencyKey:randomUUID()});runs.push({runId:claim.run.id,requestId:request.requestId});}
  console.log(JSON.stringify({runs,fixture:"control-protocol; PostgreSQL jobs run separately"}));
 }else if(mode==="finish"){
  const runId=z.uuid().parse(process.argv[3]),run=(await admin.query("SELECT id,executor_id,epoch::text FROM collab.runs WHERE id=$1",[runId])).rows[0];assert.ok(run);
  await worker.finish(run.executor_id,run.id,run.epoch,"completed",{kind:"browser-resource-control-fixture",modelInference:false});console.log(JSON.stringify({finished:true}));
 }else if(mode==="release"||mode==="sql"||mode==="queue"){
  const runId=z.uuid().parse(process.argv[3]),run=(await admin.query("SELECT id,executor_id,epoch::text FROM collab.runs WHERE id=$1",[runId])).rows[0];assert.ok(run);await worker.heartbeat(run.executor_id,run.id,run.epoch);await worker.renewResources(run.executor_id,run.id,run.epoch);
  const context=await coordinate(worker,run.executor_id,run.id,run.epoch,"get_context",{}),request=context.resources.requests.find((q:{status:string})=>q.status==="granted");assert.ok(request);
  if(mode==="release"){await coordinate(worker,run.executor_id,run.id,run.epoch,"release_resource",{requestId:request.id,idempotencyKey:randomUUID()});await worker.finish(run.executor_id,run.id,run.epoch,"completed",{kind:"browser-resource-control-fixture",modelInference:false});console.log(JSON.stringify({released:true}));}
  else{const grant=request.grants[0],accepted=await coordinate(worker,run.executor_id,run.id,run.epoch,"execute_resource",{requestId:request.id,resourceId:grant.resourceId,fence:grant.fence,sql:"SELECT 47 AS browser_proof",idempotencyKey:randomUUID()});
   if(mode==="queue")console.log(JSON.stringify({jobId:accepted.jobId}));
   else{const job=await broker.claim(randomUUID());assert.equal(job?.id,accepted.jobId);assert.ok(job);assert.equal(await executeResourceJob(broker,job,key),"succeeded");console.log(JSON.stringify({jobId:job.id}));}}
 }else throw new Error("Unsupported isolated resource fixture action");
}finally{key.fill(0);await admin.end();await worker.close();await broker.close();}
