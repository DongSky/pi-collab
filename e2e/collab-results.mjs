import { openTask, resizeWorkspace } from './collab-navigation.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function verifyResultUi({base,projectId,taskId,validationId,repository,ownerContext,memberContext,owner,member,worker,admin}) {
 const headers={Origin:base},panel=owner.getByRole('region',{name:'任务成果与依赖版本',exact:true});
 const response=await ownerContext.request.post(`${base}/api/collab/projects/${projectId}/tasks`,{headers,data:{title:'固定依赖下游任务',description:'消费确定版本成果',acceptance:'旧版本不得被替换'}});assert.equal(response.status(),200);const downstream=await response.json();
 assert.equal((await ownerContext.request.post(`${base}/api/collab/tasks/${downstream.id}/dependencies`,{headers,data:{dependsOn:taskId,kind:'strict'}})).status(),200);
 const updated=(await admin.query('SELECT version FROM collab.tasks WHERE id=$1',[downstream.id])).rows[0];
 const started=await ownerContext.request.post(`${base}/api/collab/tasks/${downstream.id}/runs`,{headers,data:{repositoryId:repository.id,baseSha:repository.baseSha,prompt:'Dependency diagnostic',expectedVersion:updated.version,idempotencyKey:randomUUID()}});assert.equal(started.status(),202);const waiting=await started.json();
 await worker('waiting');
 const expectedVersion=(await admin.query('SELECT version FROM collab.tasks WHERE id=$1',[taskId])).rows[0].version;
 const body={validationId,expectedVersion,idempotencyKey:randomUUID(),note:'发布可消费的固定工作代码'};
 assert.equal((await memberContext.request.post(`${base}/api/collab/tasks/${taskId}/results`,{headers,data:body})).status(),403);
 assert.equal((await ownerContext.request.post(`${base}/api/collab/tasks/${taskId}/results`,{headers:{Origin:'https://untrusted.invalid'},data:body})).status(),403);
 let lost=true;
 await owner.route(`**/api/collab/tasks/${taskId}/results`,async route=>{
  if(route.request().method()==='POST'&&lost){lost=false;const accepted=await route.fetch();assert.equal(accepted.status(),201);await route.abort('failed');}else await route.continue();
 });
 await panel.getByLabel('成果验证记录').selectOption(validationId);await panel.getByLabel('成果说明').fill('接口与工作文件已经通过指定检查，可供下游消费；合并前仍需组合验证。');
 await panel.getByRole('button',{name:'发布成果版本',exact:true}).click();await panel.getByRole('button',{name:'重试同一成果操作'}).click();
 await panel.getByRole('status').filter({hasText:'成果 v1 · 当前版本'}).waitFor();
 const result=(await admin.query('SELECT id FROM collab.task_results WHERE task_id=$1',[taskId])).rows;assert.equal(result.length,1);
 const consumed=await worker('dependency',downstream.id);assert.equal(consumed.runId,waiting.runId);assert.equal(consumed.resultId,result[0].id);
 await member.goto(`${base}/`);await openTask(member, '固定依赖下游任务');
 const observer=member.getByRole('region',{name:'任务成果与依赖版本',exact:true});await observer.getByRole('status').filter({hasText:'依赖版本当前有效'}).waitFor();
 await observer.getByText(/快照交接验收任务 · 严格 · v1/).waitFor();assert.equal(await observer.getByRole('button',{name:'发布成果版本'}).count(),0);
 await panel.screenshot({path:'test-results/collab/task-results.png'});await resizeWorkspace(owner, {width:390,height:844});await panel.screenshot({path:'test-results/collab/task-results-mobile.png'});
 assert.ok(await owner.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));await resizeWorkspace(owner, {width:1440,height:1000});
 await panel.getByText('撤回此成果',{exact:true}).click();await panel.getByLabel('成果 v1 撤回原因').fill('接口检查需要补充，暂时撤回这一成果供后续修复。');
 await panel.getByRole('button',{name:'确认撤回成果 v1'}).click();await panel.getByRole('status').filter({hasText:'成果 v1 · 已撤回'}).waitFor();
 await observer.getByRole('status').filter({hasText:'依赖需要重新验证'}).waitFor();
 assert.equal((await memberContext.request.get(`${base}/api/collab/runs/${waiting.runId}/dependencies`)).status(),200);
 console.log('PASS: browser published-result permissions/CSRF and lost-response retry, strict wait, actual Pi consumption of fixed input, observer version display, withdrawal invalidation and responsive layout.');
}
