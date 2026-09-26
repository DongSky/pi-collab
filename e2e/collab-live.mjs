import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import lockfile from 'proper-lockfile';
import { demoSignIn } from './collab-live-auth.mjs';
const base='http://127.0.0.1:30142', file='.local/live-demo/state.json';
const release = await lockfile.lock('.local/live-demo', { retries: 0 });
const state=JSON.parse(await readFile(file,'utf8'));
if(!state.ready||!state.modelProfileId)throw new Error('Prepare demo and explicitly configure its real model first');
const save=async()=>{await writeFile(file+'.tmp',JSON.stringify(state,null,2)+'\n',{mode:0o600});await rename(file+'.tmp',file);};
const browser=await chromium.launch({headless:true}), contexts=[];
const api=async(context,route,body)=>{
 const response=body===undefined?await context.request.get(base+'/api/collab/'+route):await context.request.post(base+'/api/collab/'+route,{headers:{Origin:base},data:body});
 const value=await response.json(); if(!response.ok())throw new Error(`API ${route}: ${response.status()} ${value.error??'failed'}`);return value;
};
try{
 await mkdir('test-results/collab',{recursive:true});
 for(const name of ['Alice','Bob','Reviewer']){
  const account=state.accounts.find(a=>a.name===name),context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();contexts.push(context);
  await demoSignIn(page,base,account);
  await page.getByRole('heading',{name:'双 AI 商店开发',exact:true}).waitFor();
 }
 state.runRequests??=[];state.runIds??=[];
 if(process.argv.includes('--retry-failed')){
  assert.equal(state.runIds.length,2,'Only retry a recorded pair');
  const prior=await Promise.all(state.runIds.map((id,i)=>api(contexts[i],`runs/${id}`)));
  assert.ok(prior.every(value=>['failed','cancelled'].includes(value.run.status)),'Never retry live, completed or uncertain runs');
  state.attempts??=[];state.attempts.push({runIds:state.runIds,requests:state.runRequests,evidence:state.realRunEvidence});
  state.runIds=[];state.runRequests=[];delete state.realRunEvidence;
  const project=await api(contexts[0],`projects/${state.projectId}`);
  state.tasks=state.tasks.map(task=>({...task,version:project.tasks.find(t=>t.id===task.id).version}));await save();
 }
 for(let i=0;i<2;i++){
  const page=contexts[i].pages()[0];await page.getByRole('button').filter({hasText:state.tasks[i].title}).click();
  await page.getByLabel('运行仓库',{exact:true}).selectOption(state.repository.id);await page.getByLabel('运行模型',{exact:true}).selectOption(state.modelProfileId);
  const target=i?'shipping':'pricing';
  const prompt=`Implement only ${target}.mjs. Read README.md and tests/${target}.test.mjs first. Do not change tests, checkout.mjs, the other task file, or any other file. Implement input validation and all specified behavior. Run node --test tests/${target}.test.mjs to check it. Do not commit or push. Finish with a brief summary. This is real collaborative development; another independent agent owns the other module.`;
  if(!state.runIds[i]){
   const recovering=!!state.runRequests[i];
   if(!state.runRequests[i]){state.runRequests[i]={repositoryId:state.repository.id,baseSha:state.repository.baseSha,prompt,expectedVersion:state.tasks[i].version,idempotencyKey:randomUUID(),modelProfileId:state.modelProfileId};await save();}
   if(recovering){
    state.runIds[i]=(await api(contexts[i],`tasks/${state.tasks[i].id}/runs`,state.runRequests[i])).runId;await save();continue;
   }
   await page.getByLabel('AI 任务指令').fill(state.runRequests[i].prompt);
   // Persist the exact UI request before sending it, and reuse it after a crash.
   await page.route(`**/api/collab/tasks/${state.tasks[i].id}/runs`,async route=>{
    if(route.request().method()==='POST')await route.continue({postData:JSON.stringify(state.runRequests[i])});else await route.continue();
   });
   const response=page.waitForResponse(r=>r.url()===`${base}/api/collab/tasks/${state.tasks[i].id}/runs`&&r.request().method()==='POST');
   await page.getByRole('button',{name:'启动 AI',exact:true}).click();const accepted=await response;
   assert.equal(accepted.status(),202);state.runIds[i]=(await accepted.json()).runId;await save();
   console.log(`STARTED ${i?'Bob':'Alice'} real model run ${state.runIds[i]}`);
  }
 }
 const bobDenied=await contexts[1].request.post(`${base}/api/collab/runs/${state.runIds[0]}/stop`,{headers:{Origin:base},data:{idempotencyKey:randomUUID()}});
 assert.equal(bobDenied.status(),403);
 const reviewerPage=contexts[2].pages()[0];await reviewerPage.getByRole('button').filter({hasText:state.tasks[0].title}).click();
 assert.equal(await reviewerPage.getByRole('button',{name:'启动 AI',exact:true}).count(),0);
 const deadline=Date.now()+240000;let previous='';
 while(true){
  const runs=await Promise.all(state.runIds.map((id,i)=>api(contexts[i],`runs/${id}`)));
  const signature=runs.map(r=>r.run.status).join(',');if(signature!==previous){console.log('RUNS '+signature);previous=signature;}
  if(runs.every(r=>['completed','failed','cancelled','reconciling'].includes(r.run.status))){
   state.realRunEvidence=runs.map(r=>({id:r.run.id,status:r.run.status,workspaceId:r.run.workspace_id,startedAt:r.run.started_at,finishedAt:r.run.finished_at,error:r.run.summary?.error??null}));await save();
   for(let i=0;i<2;i++){await contexts[i].pages()[0].screenshot({path:`test-results/collab/live-${i?'bob':'alice'}.png`,fullPage:true});}
   for(let i=0;i<2;i++){assert.equal(runs[i].run.status,'completed',`Real run ${i} ${runs[i].run.status}: ${runs[i].run.summary?.error??''}`);}
   const [a,b]=state.realRunEvidence;assert.ok(Math.max(Date.parse(a.startedAt),Date.parse(b.startedAt))<Math.min(Date.parse(a.finishedAt),Date.parse(b.finishedAt)),'Real Pi execution intervals must overlap');
   console.log('PASS: two browser owners started real model runs, intervals overlap, Bob cannot stop Alice and Reviewer cannot start. Code and integration acceptance follows.');break;
  }
  if(Date.now()>deadline)throw new Error('Live runs remain active; inspect existing IDs, do not start duplicates');
  await new Promise(resolve=>setTimeout(resolve,2000));
 }
}finally{await browser.close();await release();}
