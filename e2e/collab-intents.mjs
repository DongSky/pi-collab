import { openTask, showTaskPanel, resizeWorkspace } from './collab-navigation.mjs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function verifyIntentUi({base,projectId,taskId,repository,ownerContext,memberContext,owner,member,admin}) {
 await showTaskPanel(owner, '协作约定');
 const headers={Origin:base},panel=owner.getByRole('region',{name:'修改范围与重叠告警',exact:true});
 const run=(await admin.query('SELECT id FROM collab.runs WHERE task_id=$1 ORDER BY created_at DESC LIMIT 1',[taskId])).rows[0];
 const input={expectedRevision:0,idempotencyKey:randomUUID(),declaration:{paths:['code.txt'],symbols:[],changeType:'fix',summary:'浏览器声明测试',expectedCompletion:null}};
 assert.equal((await memberContext.request.post(`${base}/api/collab/runs/${run.id}/intents`,{headers,data:input})).status(),403);
 assert.equal((await ownerContext.request.post(`${base}/api/collab/runs/${run.id}/intents`,{headers:{Origin:'https://untrusted.invalid'},data:input})).status(),403);
 let lost=true;
 await owner.route(`**/api/collab/runs/${run.id}/intents`,async route=>{
  if(route.request().method()==='POST'&&lost){lost=false;const result=await route.fetch();assert.equal(result.status(),201);await route.abort('failed');}else await route.continue();
 });
 await panel.getByLabel('预期修改路径').fill('code.txt');await panel.getByLabel('范围变更类型').selectOption('fix');await panel.getByLabel('范围说明').fill('修改核心实现，保留原有接口；扩大范围时发布新声明。');
 await panel.getByRole('button',{name:'保存范围声明',exact:true}).click();await panel.getByRole('button',{name:'重试同一范围声明',exact:true}).click();
 await panel.getByRole('status').filter({hasText:'当前范围声明 v1'}).waitFor();
 assert.equal((await admin.query('SELECT 1 FROM collab.work_intents WHERE run_id=$1',[run.id])).rowCount,1);
 // Simulate a background tab where periodic polling is suspended. Durable
 // project events must still invalidate scope data when a peer declares.
 await owner.evaluate(()=>Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'}));
 const created=await ownerContext.request.post(`${base}/api/collab/projects/${projectId}/tasks`,{headers,data:{title:'范围重叠协商任务',description:'必须在独立工作区协作',acceptance:'只产生告警，不更改权限'}});assert.equal(created.status(),200);const peer=await created.json();
 const started=await ownerContext.request.post(`${base}/api/collab/tasks/${peer.id}/runs`,{headers,data:{repositoryId:repository.id,baseSha:repository.baseSha,prompt:'Scope peer fixture',expectedVersion:peer.version,idempotencyKey:randomUUID()}});assert.equal(started.status(),202);const next=await started.json();
 assert.equal((await ownerContext.request.post(`${base}/api/collab/runs/${next.runId}/intents`,{headers,data:input})).status(),201);
 const scopeResponse=await ownerContext.request.get(`${base}/api/collab/runs/${run.id}/intents`);assert.equal(scopeResponse.status(),200);const scoped=await scopeResponse.json();
 assert.ok(scoped.overlaps.some(p=>p.taskId===peer.id),JSON.stringify({current:scoped,peer:(await admin.query('SELECT r.id,r.status,r.task_id,w.repository_id FROM collab.runs r JOIN collab.workspaces w ON w.id=r.workspace_id WHERE r.id=$1',[next.runId])).rows}));
 try {await panel.getByText('范围重叠：范围重叠协商任务',{exact:true}).waitFor();}catch(error){console.log('Scope fixture visible panel:',await panel.innerText());throw error;}
 await owner.evaluate(()=>{delete document.visibilityState;document.dispatchEvent(new Event('visibilitychange'));});
 await member.goto(`${base}/`);await openTask(member, '快照交接验收任务', '协作约定');
 const observer=member.getByRole('region',{name:'修改范围与重叠告警',exact:true});await observer.getByRole('status').filter({hasText:'当前范围声明 v1'}).waitFor();
 await observer.getByText('范围重叠：范围重叠协商任务',{exact:true}).waitFor();assert.equal(await observer.getByRole('button',{name:'保存范围声明',exact:true}).count(),0);
 await panel.screenshot({path:'test-results/collab/work-intents.png'});await resizeWorkspace(owner, {width:390,height:844});await panel.screenshot({path:'test-results/collab/work-intents-mobile.png'});
 assert.ok(await owner.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));await resizeWorkspace(owner, {width:1440,height:1000});
 await showTaskPanel(owner, '验证 / 交付');
 assert.equal((await ownerContext.request.post(`${base}/api/collab/runs/${next.runId}/stop`,{headers,data:{idempotencyKey:randomUUID()}})).status(),202);
}

export async function verifyScopeUi({base,snapshot,ownerContext,owner,admin}) {
 await showTaskPanel(owner, '协作约定');
 const panel=owner.getByRole('region',{name:'修改范围与重叠告警',exact:true});
 await panel.getByRole('button',{name:`核对快照范围 · ${snapshot.id.slice(0,8)}`,exact:true}).click();
 await panel.getByRole('status').filter({hasText:'实际变更 2 项 · 未声明 1 项'}).waitFor();
 await panel.getByText('new.txt · 新增 · 未声明',{exact:true}).waitFor();
 const response=await ownerContext.request.get(`${base}/api/collab/snapshots/${snapshot.id}/scope`);assert.equal(response.status(),200);const report=await response.json();
 assert.equal(report.intentRevision,1);assert.equal(report.undeclaredCount,1);assert.ok(report.excluded.some(e=>e.path==='.env'));
 const closed=await ownerContext.request.post(`${base}/api/collab/runs/${report.runId}/intents`,{headers:{Origin:base},data:{expectedRevision:1,idempotencyKey:randomUUID(),declaration:{paths:['code.txt','new.txt'],symbols:[],changeType:'fix',summary:'Late declaration must fail',expectedCompletion:null}}});assert.equal(closed.status(),409);
 assert.equal((await admin.query('SELECT 1 FROM collab.work_intents WHERE run_id=$1',[report.runId])).rowCount,1);
 await panel.screenshot({path:'test-results/collab/scope-report.png'});await resizeWorkspace(owner, {width:390,height:844});await panel.screenshot({path:'test-results/collab/scope-report-mobile.png'});
 assert.ok(await owner.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));await resizeWorkspace(owner, {width:1440,height:1000});
 await showTaskPanel(owner, '验证 / 交付');
 console.log('PASS: scope declaration permissions/CSRF, lost-response retry, cross-browser overlap evidence, terminal freeze, real Pi undeclared changes and responsive scope report.');
}
