import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

// These are transport/state-machine fixtures, not simulated model intelligence.
// Real Pi process execution is independently covered by execution.test.ts.
export async function verifyExecutionApi({ base, config, ownerContext, memberContext, owner, member }) {
 const databaseName=process.env.PI_COLLAB_E2E_DATABASE;
 if (!/^pi_collab_test_[a-f0-9]+$/.test(databaseName??'')) throw new Error('An isolated test database is required');
 const connection=(user,password)=>`postgresql://${user}:${encodeURIComponent(password)}@127.0.0.1:${config.databasePort}/${databaseName}`;
 const admin=new Pool({connectionString:connection('pi_collab_admin',config.adminPassword)});
 const worker=new Pool({connectionString:connection('pi_collab_executor',config.executorPassword)});
 const headers={Origin:base};
 const project=(await (await ownerContext.request.get(`${base}/api/collab/projects`)).json()).projects[0];
 const repository=randomUUID(),sha='a'.repeat(40),executor=randomUUID();
 const attach=async(page,after='0')=>page.evaluate(({projectId,after})=>{
  window.__queueEvents=[];window.__queueClosed=false;
  window.__queueStream=new EventSource(`/api/collab/projects/${projectId}/events?after=${after}`);
  window.__queueStream.addEventListener('run_event',event=>window.__queueEvents.push(JSON.parse(event.data)));
  window.__queueStream.addEventListener('access_revoked',()=>{window.__queueClosed=true;window.__queueStream.close();});
 },{projectId:project.id,after});
 try {
  await admin.query("INSERT INTO collab.repositories(id,organization_id,project_id,name,provider,base_sha,default_branch) VALUES($1,$2,$3,'Protocol fixture','local',$4,'main')",[repository,project.organization_id,project.id,sha]);
  await attach(owner);await attach(member);
  const tasks=[];
  for(const [context,title] of [[ownerContext,'Owner API task'],[memberContext,'Member API task']]) {
   const response=await context.request.post(`${base}/api/collab/projects/${project.id}/tasks`,{headers,data:{title,description:'Queue protocol fixture',acceptance:'Protocol only'}});
   assert.equal(response.status(),200);tasks.push(await response.json());
  }
  const accepted=[];
  for(const [index,context] of [ownerContext,memberContext].entries()) {
   const body={repositoryId:repository,baseSha:sha,prompt:'Protocol fixture, no model execution',expectedVersion:tasks[index].version,idempotencyKey:randomUUID()};
   const responses=await Promise.all(Array.from({length:3},()=>context.request.post(`${base}/api/collab/tasks/${tasks[index].id}/runs`,{headers,data:body})));
   for(const response of responses) assert.equal(response.status(),202);
   const results=await Promise.all(responses.map(response=>response.json()));assert.equal(new Set(results.map(result=>result.runId)).size,1);accepted.push(results[0]);
   const conflict=await context.request.post(`${base}/api/collab/tasks/${tasks[index].id}/runs`,{headers,data:{...body,prompt:'Changed payload'}});assert.equal(conflict.status(),409);
  }
  const forbidden=await memberContext.request.post(`${base}/api/collab/runs/${accepted[0].runId}/stop`,{headers,data:{idempotencyKey:randomUUID()}});assert.equal(forbidden.status(),403);
  const csrf=await ownerContext.request.post(`${base}/api/collab/runs/${accepted[0].runId}/stop`,{headers:{Origin:'https://untrusted.invalid'},data:{idempotencyKey:randomUUID()}});assert.equal(csrf.status(),403);
  const claims=[];
  for(let i=0;i<2;i++) claims.push((await worker.query("SELECT collab_worker.claim_result_aware($1,$2) AS result",[executor,process.env.PI_COLLAB_RUNTIME==='docker'?'docker':'native'])).rows[0].result);
  assert.equal(new Set(claims.map(claim=>claim.run.id)).size,2);
  for(const claim of claims) {
   await worker.query('SELECT collab_worker.mark_running($1,$2,$3)',[executor,claim.run.id,claim.run.epoch]);
   await worker.query('SELECT collab_worker.append_output($1,$2,$3,$4,$5)',[executor,claim.run.id,claim.run.epoch,randomUUID(),JSON.stringify([{type:'assistant_text',text:'Protocol transport fixture'}])]);
  }
  await owner.waitForFunction(()=>window.__queueEvents.filter(event=>event.kind==='run.running').length===2);
  await member.waitForFunction(()=>window.__queueEvents.filter(event=>event.kind==='run.running').length===2);
  const cursor=await owner.evaluate(()=>window.__queueEvents.at(-1).sequence);
  await owner.evaluate(()=>window.__queueStream.close());
  for(const claim of claims) await worker.query('SELECT collab_worker.finish($1,$2,$3,$4,$5)',[executor,claim.run.id,claim.run.epoch,'completed',JSON.stringify({kind:'protocol-fixture'})]);
  await attach(owner,cursor);
  await owner.waitForFunction(()=>window.__queueEvents.filter(event=>event.kind==='run.completed').length===2);
  assert.ok(await owner.evaluate(cursor=>window.__queueEvents.every(event=>BigInt(event.sequence)>BigInt(cursor)),cursor));
  const response=await memberContext.request.get(`${base}/api/collab/projects/${project.id}/events?after=999999`);assert.equal(response.status(),200);assert.equal((await response.json()).reset,true);
  const snapshots=await ownerContext.request.get(`${base}/api/collab/runs/${accepted[0].runId}`);assert.equal((await snapshots.json()).workspace.status,'stopped');
  console.log('PASS: browser-authenticated run API idempotency/CSRF/control scope, two durable claims, live SSE and cursor replay (protocol fixtures).');
 } finally {
  await Promise.all([owner,member].map(page=>page.evaluate(()=>window.__queueStream?.close())));
  await admin.end();await worker.end();
 }
 return project.id;
}
