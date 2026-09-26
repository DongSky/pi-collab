import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { Pool } from 'pg';
const exec=promisify(execFile);
export async function verifyDiscussions({base,config,projectId,memberContext,owner,member}) {
 const name=process.env.PI_COLLAB_E2E_DATABASE;
 if(!/^pi_collab_test_[a-f0-9]+$/.test(name??''))throw new Error('Isolated database required');
 const admin=new Pool({connectionString:`postgresql://pi_collab_admin:${encodeURIComponent(config.adminPassword)}@127.0.0.1:${config.databasePort}/${name}`});
 const worker=async(mode,id)=>JSON.parse((await exec(process.execPath,['--import','tsx','scripts/e2e-snapshot-worker.ts',mode,...(id?[id]:[])],{timeout:60000})).stdout.trim());
 const post=async(context,p,data)=>{const response=await context.request.post(`${base}/api/collab/${p}`,{headers:{Origin:base},data});assert.ok(response.ok(),`Discussion fixture ${p}: HTTP ${response.status()}`);return response.json();};
 try{
  const repository=await worker('init',projectId),profile=randomUUID();
  const project=(await admin.query('SELECT organization_id FROM collab.projects WHERE id=$1',[projectId])).rows[0];
  await admin.query("INSERT INTO collab.model_profiles(id,organization_id,project_id,name,model_id,api,context_window,max_output_tokens,run_token_limit,run_request_limit) VALUES($1,$2,$3,'Suggestion diagnostic','fixture-model','openai-responses',128000,512,1000000,8)",[profile,project.organization_id,projectId]);
  const task=await post(memberContext,`projects/${projectId}/tasks`,{title:'固定代码讨论验收',description:'讨论不会自动成为 AI 指令',acceptance:'采纳后新工作区与原目录隔离'});
  await post(memberContext,`tasks/${task.id}/runs`,{repositoryId:repository.id,baseSha:repository.baseSha,prompt:'Prepare review snapshot',expectedVersion:task.version,idempotencyKey:randomUUID()});
  const first=await worker('run',task.id);
  const run=(await(await memberContext.request.get(`${base}/api/collab/runs/${first.runId}`)).json()).run;
  const snapshot=await post(memberContext,`runs/${first.runId}/snapshots`,{expectedRevision:run.revision,note:'讨论用的固定代码',idempotencyKey:randomUUID()});await worker('capture');
  const memberId=(await(await memberContext.request.get(`${base}/api/collab/me`)).json()).user.id;
  for(const page of [owner,member]){await page.goto(`${base}/`);await page.locator('.collab-task-row').filter({hasText:task.title}).click();}
  const discussion=owner.getByLabel('任务讨论与代码建议',{exact:true});
  await discussion.getByText('发起讨论',{exact:true}).click();await discussion.getByLabel('讨论标题',{exact:true}).fill('修改第二版文案');await discussion.getByLabel('讨论内容',{exact:true}).fill('请核对这个固定版本，采纳时保留原来的目录。');await discussion.getByLabel('提及成员',{exact:true}).selectOption([memberId]);
  await discussion.getByText('引用固定代码或提出修改建议',{exact:true}).click();await discussion.getByLabel('讨论代码版本',{exact:true}).selectOption(snapshot.snapshotId);await discussion.getByLabel('讨论代码文件',{exact:true}).selectOption('code.txt');await discussion.getByLabel('附带代码替换建议',{exact:true}).check();await discussion.getByLabel('建议替换内容',{exact:true}).fill('reviewed\n');
  await owner.reload();await owner.locator('.collab-task-row').filter({hasText:task.title}).click();await discussion.getByText('发起讨论',{exact:true}).click();
  assert.equal(await discussion.getByLabel('讨论标题',{exact:true}).inputValue(),'修改第二版文案');assert.equal(await discussion.getByLabel('讨论内容',{exact:true}).inputValue(),'请核对这个固定版本，采纳时保留原来的目录。');
  await discussion.getByText('引用固定代码或提出修改建议',{exact:true}).click();await discussion.getByLabel('讨论代码文件',{exact:true}).getByRole('option',{name:'code.txt',exact:true}).waitFor({state:'attached'});
  assert.equal(await discussion.getByLabel('讨论代码版本',{exact:true}).inputValue(),snapshot.snapshotId);assert.equal(await discussion.getByLabel('建议替换内容',{exact:true}).inputValue(),'reviewed\n');
  let lost=true,requestKey;await owner.route(`**/api/collab/tasks/${task.id}/discussions`,async route=>{if(route.request().method()==='POST'&&route.request().postDataJSON().action==='create'){const data=route.request().postDataJSON();if(lost){lost=false;requestKey=data.idempotencyKey;const accepted=await route.fetch();assert.ok(accepted.ok());await route.abort();}else{assert.equal(data.idempotencyKey,requestKey);await route.continue();}}else await route.continue();});
  await discussion.getByRole('button',{name:'发布讨论',exact:true}).click();await discussion.getByRole('button',{name:'重试同一讨论操作',exact:true}).waitFor();
  await owner.reload();await owner.locator('.collab-task-row').filter({hasText:task.title}).click();await discussion.getByRole('button',{name:'重试同一讨论操作',exact:true}).click();await discussion.getByRole('heading',{name:'修改第二版文案',exact:true}).waitFor();
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM collab.discussion_threads WHERE task_id=$1',[task.id])).rows[0].n,1);
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM collab.inbox WHERE task_id=$1 AND kind=\'mention\'',[task.id])).rows[0].n,1);

  const memberInbox=member.getByLabel('站内收件箱',{exact:true});await memberInbox.getByRole('button',{name:/^收件箱/}).click();await memberInbox.getByRole('button',{name:/提及了你/}).click();
  const md=member.getByLabel('任务讨论与代码建议',{exact:true});await md.getByRole('heading',{name:'修改第二版文案',exact:true}).waitFor();await md.getByLabel('讨论回复',{exact:true}).fill('已确认此修改，准备在新工作区验证。');
  const original=(await(await memberContext.request.get(`${base}/api/collab/tasks/${task.id}/discussions`)).json()).threads[0];
  const other=await post(memberContext,`tasks/${task.id}/discussions`,{action:'create',title:'另一个独立话题',body:'Replies belong to this thread',mentions:[],anchor:null,replacement:null,idempotencyKey:randomUUID()});
  await md.getByRole('button',{name:'待讨论 · 另一个独立话题',exact:true}).click();assert.equal(await md.getByLabel('讨论回复',{exact:true}).inputValue(),'');await md.getByLabel('讨论回复',{exact:true}).fill('仅属于另一个话题的草稿');
  await md.getByRole('button',{name:'待讨论 · 修改第二版文案 · 代码建议',exact:true}).click();assert.equal(await md.getByLabel('讨论回复',{exact:true}).inputValue(),'已确认此修改，准备在新工作区验证。');
  await member.reload();await member.locator('.collab-task-row').filter({hasText:task.title}).click();await md.getByRole('heading',{name:'修改第二版文案',exact:true}).waitFor();assert.equal(await md.getByLabel('讨论回复',{exact:true}).inputValue(),'已确认此修改，准备在新工作区验证。');
  await md.getByRole('button',{name:'发布回复',exact:true}).click();
await discussion.getByText('已确认此修改，准备在新工作区验证。',{exact:true}).waitFor();
  for(let i=0;i<55;i++)await post(memberContext,`tasks/${task.id}/discussions`,{action:'reply',threadId:original.id,body:`分页验收回复 ${i}`,mentions:[],idempotencyKey:randomUUID()});
  await member.reload();await member.locator('.collab-task-row').filter({hasText:task.title}).click();await md.getByRole('button',{name:'更多回复',exact:true}).click();await md.getByText('分页验收回复 54',{exact:true}).waitFor();
  const polled=member.waitForResponse(r=>r.url().includes(`/discussions/${original.id}?after=`)&&r.request().method()==='GET');await polled;
  assert.equal(await md.getByText('分页验收回复 54',{exact:true}).count(),1);assert.equal(await md.getByText('分页验收回复 0',{exact:true}).count(),1);
  await md.getByRole('button',{name:'待讨论 · 另一个独立话题',exact:true}).click();assert.equal(await md.getByLabel('讨论回复',{exact:true}).inputValue(),'仅属于另一个话题的草稿');
  assert.equal((await(await memberContext.request.get(`${base}/api/collab/discussions/${other.threadId}`)).json()).messages.length,1);
  await md.getByRole('button',{name:'待讨论 · 修改第二版文案 · 代码建议',exact:true}).click();
  await md.getByRole('button',{name:'在新工作区采纳建议…',exact:true}).click();assert.equal(await member.getByLabel('恢复来源',{exact:true}).inputValue(),snapshot.snapshotId);await member.getByLabel('运行模型',{exact:true}).selectOption(profile);await member.getByRole('button',{name:'启动 AI',exact:true}).click();
  await member.getByRole('status').filter({hasText:'排队中'}).waitFor();const applied=await worker('suggestion',task.id);assert.notEqual(applied.workspaceId,first.workspaceId);
  await md.getByText(/已应用于独立工作区 · 运行/).waitFor();
  await md.getByRole('button',{name:'标记讨论已解决',exact:true}).click();await discussion.getByRole('button',{name:'重新打开讨论',exact:true}).waitFor();
  const thread=original;
  const denied=await memberContext.request.post(`${base}/api/collab/tasks/${task.id}/discussions`,{data:{action:'reply',threadId:thread.id,body:'No origin',mentions:[],idempotencyKey:randomUUID()}});assert.equal(denied.status(),403);
  await mkdir('test-results/collab',{recursive:true});await discussion.screenshot({path:'test-results/collab/discussions-desktop.png'});
  await owner.setViewportSize({width:390,height:844});assert.equal(await owner.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await discussion.screenshot({path:'test-results/collab/discussions-mobile.png'});
  console.log('PASS: two-member fixed-code suggestion, refresh draft recovery, exact replay after lost acknowledgement, thread-scoped replies, expanded pagination across polls, mention inbox navigation, reply, fresh-workspace application through actual Pi without inference, resolution, CSRF and responsive layout.');
 }finally{await admin.end();}
}
