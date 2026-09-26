import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { Pool } from 'pg';

export async function verifyRunControl({ base, config, projectId, ownerContext, memberContext, owner, member }) {
 const databaseName = process.env.PI_COLLAB_E2E_DATABASE;
 if (!/^pi_collab_test_[a-f0-9]+$/.test(databaseName ?? '')) throw new Error('Isolated database required');
 const worker = new Pool({ connectionString: `postgresql://pi_collab_executor:${encodeURIComponent(config.executorPassword)}@127.0.0.1:${config.databasePort}/${databaseName}` });
 const executor = randomUUID(); let heartbeat, claim, heartbeatWork = Promise.resolve();
 const post = async (context, path, data) => {
  const response = await context.request.post(`${base}/api/collab/${path}`, { headers: { Origin: base }, data });
  assert.ok(response.ok(), `Control fixture ${path}: HTTP ${response.status()}`); return response.json();
 };
 try {
  const repository = (await (await memberContext.request.get(`${base}/api/collab/projects/${projectId}/repositories`)).json()).repositories[0];
  const task = await post(memberContext, `projects/${projectId}/tasks`, { title: '会话交接：当前 AI', description: 'Browser protocol fixture', acceptance: 'Control changes without changing run identity' });
  const accepted = await post(memberContext, `tasks/${task.id}/runs`, { repositoryId: repository.id, baseSha: repository.base_sha, prompt: 'Shared control protocol fixture', expectedVersion: task.version, idempotencyKey: randomUUID() });
  claim = (await worker.query("SELECT collab_worker.claim_result_aware($1,'native') AS result", [executor])).rows[0].result;
  assert.equal(claim.run.id, accepted.runId);
  await worker.query('SELECT collab_worker.mark_running($1,$2,$3)', [executor, claim.run.id, claim.run.epoch]);
  heartbeat = setInterval(() => { heartbeatWork = heartbeatWork.then(() => worker.query('SELECT collab_worker.heartbeat($1,$2,$3)', [executor, claim.run.id, claim.run.epoch])).catch(() => {}); }, 1000);
  const questionInput={question:'实现前需要确定哪个接口版本？',choices:['保持现有接口','采用新版接口'],idempotencyKey:randomUUID()};
  const question=(await worker.query("SELECT collab_worker.coordinate($1,$2,$3,'ask_user',$4) AS result",[executor,claim.run.id,claim.run.epoch,questionInput])).rows[0].result;
  for (const page of [owner, member]) {
   await page.goto(`${base}/`);
   await page.locator('.collab-task-row').filter({ hasText: task.title }).click();
   await page.getByLabel('会话控制与交接', { exact: true }).getByText('Browser Member', { exact: true }).waitFor();
  }
  const ownerControl = owner.getByLabel('会话控制与交接', { exact: true }), memberControl = member.getByLabel('会话控制与交接', { exact: true });
  const ownerQuestions=owner.getByRole('region',{name:'AI 提问与回答'}),memberQuestions=member.getByRole('region',{name:'AI 提问与回答'});
  await memberQuestions.getByLabel('回答 AI',{exact:true}).waitFor();assert.equal(await ownerQuestions.getByRole('button',{name:'提交回答并继续',exact:true}).count(),0);
  assert.ok((await(await memberContext.request.get(`${base}/api/collab/inbox`)).json()).items.some(n=>n.task_id===task.id&&n.kind==='run.waiting_input'));
  const memberInbox=member.getByLabel('站内收件箱',{exact:true}),ownerInbox=owner.getByLabel('站内收件箱',{exact:true});
  await memberInbox.getByRole('button',{name:/^收件箱/}).click();
  await memberInbox.getByLabel('通知静默时长',{exact:true}).selectOption('1');
  await memberInbox.getByRole('button',{name:'开始静默',exact:true}).click();
  await memberInbox.getByRole('button',{name:'收件箱 · 已静默',exact:true}).waitFor();
  const quiet=await(await memberContext.request.get(`${base}/api/collab/inbox/preferences`)).json();assert.equal(quiet.quiet,true);
  assert.equal((await(await ownerContext.request.get(`${base}/api/collab/inbox/preferences`)).json()).quiet,false);
  const deniedPreferences=await memberContext.request.put(`${base}/api/collab/inbox/preferences`,{data:{expectedVersion:quiet.version,quietUntil:null}});assert.equal(deniedPreferences.status(),403);
  await member.reload();await memberInbox.getByRole('button',{name:'收件箱 · 已静默',exact:true}).waitFor();
  await ownerControl.getByLabel('接管申请说明', { exact: true }).fill('我来接手补充剩余测试与验证工作');
  await ownerControl.getByRole('button', { name: '申请控制权', exact: true }).click();
  await memberInbox.getByRole('button',{name:'收件箱 · 已静默',exact:true}).click();
  await memberInbox.getByRole('button',{name:/有人申请控制权/}).waitFor();
  const unread=await(await memberContext.request.get(`${base}/api/collab/inbox`)).json();assert.ok(unread.items.some(n=>n.task_id===task.id&&n.kind==='control.requested'&&!n.read_at));
  await mkdir('test-results/collab',{recursive:true});await memberInbox.screenshot({path:'test-results/collab/notifications-desktop.png'});
  await member.setViewportSize({width:390,height:844});assert.equal(await member.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await memberInbox.screenshot({path:'test-results/collab/notifications-mobile.png'});await member.setViewportSize({width:1440,height:1000});
  await memberInbox.getByRole('button',{name:'恢复未读提示',exact:true}).click();await memberInbox.getByRole('button',{name:/^收件箱 · .*条未读$/}).waitFor();
  await memberInbox.getByRole('button',{name:/有人申请控制权/}).click();
  await memberControl.getByLabel('处理 Browser Owner 的申请说明', { exact: true }).fill('同意接手，请继续补充测试并汇报结果');
  await memberControl.getByRole('button', { name: '同意交接', exact: true }).click();
  await ownerInbox.getByRole('button',{name:/^收件箱/}).click();await ownerInbox.getByRole('button',{name:/控制权申请已同意/}).click();
  await ownerControl.getByLabel('给当前 AI 的指令', { exact: true }).waitFor();
  await ownerQuestions.getByLabel('回答 AI',{exact:true}).waitFor();
  const questionAnswer={expectedVersion:'2',answer:'采用新版接口并保留兼容层',idempotencyKey:randomUUID()};
  assert.equal((await memberContext.request.post(`${base}/api/collab/questions/${question.questionId}/answer`,{headers:{Origin:base},data:questionAnswer})).status(),403);
  assert.equal((await ownerContext.request.post(`${base}/api/collab/questions/${question.questionId}/answer`,{data:questionAnswer})).status(),403);
  await owner.reload();await owner.locator('.collab-task-row').filter({hasText:task.title}).click();
  await ownerQuestions.getByText(questionInput.question,{exact:true}).waitFor();
  await ownerQuestions.getByRole('button',{name:'采用新版接口',exact:true}).click();await ownerQuestions.getByLabel('回答 AI',{exact:true}).fill(questionAnswer.answer);
  await ownerQuestions.screenshot({path:'test-results/collab/questions-desktop.png'});
  await owner.setViewportSize({width:390,height:844});assert.equal(await owner.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await ownerQuestions.screenshot({path:'test-results/collab/questions-mobile.png'});await owner.setViewportSize({width:1440,height:1000});
  let loseAnswer=true,answerKey;await owner.route(`**/api/collab/questions/${question.questionId}/answer`,async route=>{
   if(loseAnswer){loseAnswer=false;answerKey=route.request().postDataJSON().idempotencyKey;assert.ok((await route.fetch()).ok());await route.abort();}
   else{assert.equal(route.request().postDataJSON().idempotencyKey,answerKey);await route.continue();}
  });
  await ownerQuestions.getByRole('button',{name:'提交回答并继续',exact:true}).click();await ownerQuestions.getByRole('button',{name:'重试同一回答',exact:true}).click();
  await memberQuestions.getByText(questionAnswer.answer,{exact:true}).waitFor();
  const received=(await worker.query("SELECT collab_worker.coordinate($1,$2,$3,'ask_user',$4) AS result",[executor,claim.run.id,claim.run.epoch,questionInput])).rows[0].result;
  assert.equal(received.answer,questionAnswer.answer);assert.equal(received.authorName,'Browser Owner');assert.equal(received.controlVersion,'2');
  await memberControl.locator('.collab-control-owner').filter({ hasText: 'Browser Owner' }).waitFor();
  assert.equal(await member.getByRole('button', { name: '停止运行', exact: true }).count(), 0);
  const denied = await memberContext.request.post(`${base}/api/collab/runs/${claim.run.id}/instructions`, { headers: { Origin: base }, data: { expectedVersion: '1', idempotencyKey: randomUUID(), kind: 'steer', message: 'Stale page instruction' } });
  assert.equal(denied.status(), 403);
  const noCsrf = await ownerContext.request.post(`${base}/api/collab/runs/${claim.run.id}/instructions`, { data: { expectedVersion: '2', idempotencyKey: randomUUID(), kind: 'steer', message: 'No origin' } });
  assert.equal(noCsrf.status(), 403);
  await ownerControl.getByLabel('给当前 AI 的指令', { exact: true }).fill('继续验证订单接口的边界情况');
  await ownerControl.getByRole('button', { name: '发送运行指令', exact: true }).click();
  await ownerControl.getByText('继续验证订单接口的边界情况', { exact: true }).waitFor();
  const item = (await worker.query('SELECT collab_worker.claim_run_instruction($1,$2,$3) AS result', [executor, claim.run.id, claim.run.epoch])).rows[0].result;
  assert.ok(item); assert.equal(item.kind, 'steer');
  await worker.query("SELECT collab_worker.finish_run_instruction($1,$2,$3,$4,'delivered')", [executor, claim.run.id, claim.run.epoch, item.id]);
  await memberControl.locator('.collab-control-instruction').filter({ hasText: '运行已接收' }).waitFor();
  const thread=await post(memberContext,`tasks/${task.id}/discussions`,{action:'create',title:'交给当前 AI 的协作建议',body:'只选择此评论：检查订单重试的幂等性',mentions:[],anchor:null,replacement:null,idempotencyKey:randomUUID()});
  await post(memberContext,`tasks/${task.id}/discussions`,{action:'reply',threadId:thread.threadId,body:'未选择的评论不能自动发送',mentions:[],idempotencyKey:randomUUID()});
  assert.equal((await worker.query('SELECT collab_worker.claim_run_instruction($1,$2,$3) AS result',[executor,claim.run.id,claim.run.epoch])).rows[0].result,null);
  const discussions=owner.getByLabel('任务讨论与代码建议',{exact:true});
  await discussions.getByRole('button',{name:'待讨论 · 交给当前 AI 的协作建议',exact:true}).click();
  const handoff=discussions.getByLabel('选取讨论交给 AI',{exact:true});await handoff.locator('summary').click();
  await handoff.getByLabel(`选取评论 ${thread.messageId}`,{exact:true}).check();await handoff.getByRole('button',{name:'预览所选讨论',exact:true}).click();
  await handoff.getByLabel('讨论交接预览',{exact:true}).getByText('只选择此评论：检查订单重试的幂等性',{exact:true}).waitFor();
  assert.equal((await worker.query('SELECT collab_worker.claim_run_instruction($1,$2,$3) AS result',[executor,claim.run.id,claim.run.epoch])).rows[0].result,null);
  const deniedContext=await memberContext.request.post(`${base}/api/collab/runs/${claim.run.id}/discussion-context`,{headers:{Origin:base},data:{threadId:thread.threadId,messageIds:[String(thread.messageId)]}});assert.equal(deniedContext.status(),403);
  await handoff.screenshot({path:'test-results/collab/discussion-context-desktop.png'});
  await owner.setViewportSize({width:390,height:844});assert.equal(await owner.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await handoff.screenshot({path:'test-results/collab/discussion-context-mobile.png'});await owner.setViewportSize({width:1440,height:1000});
  let lostContext=true,contextKey;await owner.route(`**/api/collab/runs/${claim.run.id}/discussion-instructions`,async route=>{
   if(lostContext){lostContext=false;contextKey=route.request().postDataJSON().idempotencyKey;assert.ok((await route.fetch()).ok());await route.abort();}
   else{assert.equal(route.request().postDataJSON().idempotencyKey,contextKey);await route.continue();}
  });
  await handoff.getByRole('button',{name:'确认发送给当前 AI',exact:true}).click();await handoff.getByRole('button',{name:'重试同一讨论交接',exact:true}).waitFor();
  await owner.reload();await owner.locator('.collab-task-row').filter({hasText:task.title}).click();
  await discussions.getByRole('button',{name:'待讨论 · 交给当前 AI 的协作建议',exact:true}).click();await handoff.locator('summary').click();
  await handoff.getByRole('button',{name:'重试同一讨论交接',exact:true}).click();await handoff.getByRole('status').filter({hasText:'所选讨论已保存到指令记录'}).waitFor();
  const quoted=(await worker.query('SELECT collab_worker.claim_run_instruction($1,$2,$3) AS result',[executor,claim.run.id,claim.run.epoch])).rows[0].result;
  assert.equal(quoted.kind,'follow_up');assert.ok(quoted.message.includes('只选择此评论'));assert.ok(!quoted.message.includes('未选择的评论'));assert.ok(quoted.message.includes('Browser Member'));assert.ok(quoted.message.includes('quoted project data'));
  await worker.query("SELECT collab_worker.finish_run_instruction($1,$2,$3,$4,'delivered')",[executor,claim.run.id,claim.run.epoch,quoted.id]);
  assert.equal((await worker.query('SELECT collab_worker.claim_run_instruction($1,$2,$3) AS result',[executor,claim.run.id,claim.run.epoch])).rows[0].result,null);
  await ownerControl.getByRole('button',{name:'来自讨论：交给当前 AI 的协作建议 · 1 条评论',exact:true}).click();await discussions.getByRole('heading',{name:'交给当前 AI 的协作建议',exact:true}).waitFor();
  const detail = await (await ownerContext.request.get(`${base}/api/collab/runs/${claim.run.id}`)).json();
  assert.equal(detail.run.requested_by, claim.run.requested_by); assert.equal(detail.run.workspace_id, claim.run.workspace_id);
  await mkdir('test-results/collab', { recursive: true });
  await ownerControl.screenshot({ path: 'test-results/collab/run-control-desktop.png' });
  await owner.setViewportSize({ width: 390, height: 844 });
  assert.equal(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await ownerControl.screenshot({ path: 'test-results/collab/run-control-mobile.png' });
  await worker.query("SELECT collab_worker.coordinate($1,$2,$3,'ask_user',$4)",[executor,claim.run.id,claim.run.epoch,{question:'停止时取消这个待回答问题',choices:[],idempotencyKey:randomUUID()}]);
  await owner.getByRole('button', { name: '停止运行', exact: true }).click();
  await owner.getByText('正在停止', { exact: true }).waitFor();
  clearInterval(heartbeat); await heartbeatWork;
  await worker.query("SELECT collab_worker.finish($1,$2,$3,'cancelled','{}')", [executor, claim.run.id, claim.run.epoch]);
  claim = undefined;
  await memberControl.getByText('本次运行不再接受控制权交接或新指令。后续工作请通过任务的新运行继续。', { exact: true }).waitFor();
  console.log('PASS: selected-comment preview/confirmation, quoted source provenance, same-key refresh retry after lost response with one instruction, original discussion navigation, persisted personal quiet period without dropped notifications, account isolation/CSRF, unread resume, request and decision inbox navigation, two-member control request/approval, shared controller and instructions, old operator rejection, CSRF, new controller stop, preserved provenance and responsive layout (protocol fixture; actual Pi delivery covered by gateway test).');
 } finally { clearInterval(heartbeat); await heartbeatWork; await worker.end(); }
}
