import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { Pool } from 'pg';

// Browser UI and durable command protocol only. Gateway/Pi model protocol and
// actual provider inference have separate acceptance evidence.
export async function verifyRunUi({ base, config, projectId, ownerContext, owner, member }) {
 const dbName=process.env.PI_COLLAB_E2E_DATABASE;
 if(!/^pi_collab_test_[a-f0-9]+$/.test(dbName??'')) throw new Error('Isolated database required');
 const connection=(user,password)=>`postgresql://${user}:${encodeURIComponent(password)}@127.0.0.1:${config.databasePort}/${dbName}`;
 const admin=new Pool({connectionString:connection('pi_collab_admin',config.adminPassword)}),worker=new Pool({connectionString:connection('pi_collab_executor',config.executorPassword)});
 const original=owner.url(),headers={Origin:base},profile=randomUUID(),executor=randomUUID();
 try {
  const project=(await admin.query('SELECT organization_id FROM collab.projects WHERE id=$1',[projectId])).rows[0];
  await admin.query("INSERT INTO collab.model_profiles(id,organization_id,project_id,name,model_id,api,context_window,max_output_tokens,run_token_limit,run_request_limit) VALUES($1,$2,$3,'Browser protocol fixture','fixture-model','openai-responses',128000,512,1000000,8)",[profile,project.organization_id,projectId]);
  const response=await ownerContext.request.post(`${base}/api/collab/projects/${projectId}/tasks`,{headers,data:{title:'运行界面验收任务',description:'验证命令、输出与停止交互',acceptance:'重复提交只启动一次'}});assert.equal(response.status(),200);const task=await response.json();
  await owner.goto(`${base}/`);await owner.getByRole('button').filter({hasText:'运行界面验收任务'}).click();
  const panel=owner.getByRole('region',{name:'AI 任务运行'});
  await panel.getByLabel('运行模型').selectOption(profile);await panel.getByLabel('AI 任务指令').fill('明确标记的界面协议测试，不发出模型请求。');
  let first=true;
  await owner.route(`**/api/collab/tasks/${task.id}/runs`,async route=>{
   if(route.request().method()==='POST'&&first){first=false;const accepted=await route.fetch();assert.equal(accepted.status(),202);await route.abort('failed');}
   else await route.continue();
  });
  await panel.getByRole('button',{name:'启动 AI',exact:true}).click();await panel.getByRole('button',{name:'重试同一请求'}).waitFor();
  await panel.getByRole('button',{name:'重试同一请求'}).click();await panel.getByRole('status').filter({hasText:'排队中'}).waitFor();
  assert.equal((await admin.query('SELECT 1 FROM collab.runs WHERE task_id=$1',[task.id])).rowCount,1);
  const claim=(await worker.query("SELECT collab_worker.claim_result_aware($1,'native') AS result",[executor])).rows[0].result;
  assert.equal(claim.run.task_id,task.id);
  await worker.query('SELECT collab_worker.mark_running($1,$2,$3)',[executor,claim.run.id,claim.run.epoch]);
  await worker.query('SELECT collab_worker.append_output($1,$2,$3,$4,$5)',[executor,claim.run.id,claim.run.epoch,randomUUID(),JSON.stringify([
   {type:'assistant_text',text:'正在验证独立任务的执行流程。'},
   {type:'message_end',message:{role:'assistant',content:[{type:'text',text:'正在验证独立任务的执行流程。'}]}},
   {type:'tool_execution_start',toolName:'write'},
   {type:'tool_execution_end',toolName:'write',isError:false,content:[{text:'界面协议测试输出：变更等待评审。'}]}
  ])]);
  await panel.getByRole('status').filter({hasText:'AI 执行中'}).waitFor();await panel.getByText('界面协议测试输出：变更等待评审。',{exact:true}).waitFor();
  await owner.reload();await owner.getByRole('button').filter({hasText:'运行界面验收任务'}).click();await panel.getByText('界面协议测试输出：变更等待评审。',{exact:true}).waitFor();
  await member.goto(`${base}/`);await member.getByRole('button').filter({hasText:'运行界面验收任务'}).click();
  const observer=member.getByRole('region',{name:'AI 任务运行'});await observer.getByText('界面协议测试输出：变更等待评审。',{exact:true}).waitFor();
  assert.equal(await observer.getByRole('button',{name:'启动 AI',exact:true}).count(),0);assert.equal(await observer.getByRole('button',{name:'停止运行'}).count(),0);
  await mkdir('test-results/collab',{recursive:true});await panel.scrollIntoViewIfNeeded();await owner.screenshot({path:'test-results/collab/run-ui.png',fullPage:true});
  await owner.setViewportSize({width:390,height:844});await panel.scrollIntoViewIfNeeded();await owner.screenshot({path:'test-results/collab/run-ui-mobile.png',fullPage:true});
  assert.ok(await owner.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  await owner.setViewportSize({width:1440,height:1000});
  await panel.getByRole('button',{name:'停止运行'}).click();await panel.getByRole('status').filter({hasText:'正在停止'}).waitFor();
  assert.equal((await worker.query('SELECT collab_worker.heartbeat($1,$2,$3) AS result',[executor,claim.run.id,claim.run.epoch])).rows[0].result.canExecute,false);
  await worker.query('SELECT collab_worker.finish($1,$2,$3,$4,$5)',[executor,claim.run.id,claim.run.epoch,'cancelled',JSON.stringify({kind:'browser-protocol-fixture'})]);
  await panel.getByRole('status').filter({hasText:'已停止'}).waitFor();
  await panel.getByLabel('运行处理原因').fill('浏览器验收归档保留文件与运行历史。');
  await panel.getByRole('button',{name:'归档工作区',exact:true}).click();
  await panel.getByRole('status').filter({hasText:'工作区已归档'}).waitFor();
  assert.equal((await admin.query('SELECT status FROM collab.workspaces WHERE id=$1',[claim.workspace.id])).rows[0].status,'archived');
  // Explicitly marked recovery protocol fixture. Real process/receipt behavior is
  // exercised by recovery.test.ts, including executor SIGKILL and RPC timeout.
  await panel.getByRole('button',{name:'启动 AI',exact:true}).click();
  await panel.getByRole('status').filter({hasText:'排队中'}).waitFor();
  const recoveryClaim=(await worker.query("SELECT collab_worker.claim_result_aware($1,'native') AS result",[executor])).rows[0].result;
  await worker.query('SELECT collab_worker.quarantine($1,$2,$3,$4)',[executor,recoveryClaim.run.id,recoveryClaim.run.epoch,'browser-recovery-protocol-fixture']);
  await panel.getByRole('status').filter({hasText:'待对账'}).waitFor();
  const revision=(await admin.query('SELECT revision FROM collab.runs WHERE id=$1',[recoveryClaim.run.id])).rows[0].revision;
  const forbidden=await member.context().request.post(`${base}/api/collab/runs/${recoveryClaim.run.id}/actions`,{headers,data:{action:'recover',expectedRevision:revision,idempotencyKey:randomUUID(),reason:'Observer cannot release an old writer'}});
  assert.equal(forbidden.status(),403);
  const csrf=await ownerContext.request.post(`${base}/api/collab/runs/${recoveryClaim.run.id}/actions`,{headers:{Origin:'https://untrusted.invalid'},data:{action:'recover',expectedRevision:revision,idempotencyKey:randomUUID(),reason:'Cross-origin recovery must be rejected'}});
  assert.equal(csrf.status(),403);
  let firstRecovery=true;
  await owner.route(`**/api/collab/runs/${recoveryClaim.run.id}/actions`,async route=>{
   if(firstRecovery){firstRecovery=false;const accepted=await route.fetch();assert.equal(accepted.status(),202);await route.abort('failed');}
   else await route.continue();
  });
  await panel.getByLabel('运行处理原因').fill('核对旧进程退出证据并保留未知命令。');
  await panel.getByRole('button',{name:'检查旧进程并解除阻塞'}).click();
  await panel.getByRole('button',{name:'重试同一处理请求'}).click();
  await panel.getByText('等待执行器核对进程退出证据…',{exact:true}).waitFor();
  const actions=await admin.query('SELECT id FROM collab.run_actions WHERE run_id=$1',[recoveryClaim.run.id]);assert.equal(actions.rowCount,1);
  await worker.query("SELECT collab_worker.resolve_recovery($1,'receipt_missing',NULL)",[actions.rows[0].id]);
  await panel.getByText('缺少进程启动记录，无法确认旧写入者退出。工作区继续隔离。',{exact:true}).waitFor();
  await panel.getByLabel('运行处理原因').fill('补充检查退出证据后再次申请解除阻塞。');
  await panel.getByRole('button',{name:'检查旧进程并解除阻塞'}).click();
  await panel.getByText('等待执行器核对进程退出证据…',{exact:true}).waitFor();
  const pending=(await admin.query("SELECT id FROM collab.run_actions WHERE run_id=$1 AND status='pending'",[recoveryClaim.run.id])).rows[0];
  await worker.query("SELECT collab_worker.resolve_recovery($1,'stop_confirmed',$2)",[pending.id,'a'.repeat(64)]);
  await panel.getByRole('status').filter({hasText:'已停止'}).waitFor();
  await panel.getByText('执行器已记录进程退出。原命令的外部副作用仍需人工核对。',{exact:true}).waitFor();
  assert.equal((await admin.query("SELECT status FROM collab.commands WHERE run_id=$1 AND kind='start'",[recoveryClaim.run.id])).rows[0].status,'unknown');
  await owner.reload();await owner.getByRole('button').filter({hasText:'运行界面验收任务'}).click();
  await panel.getByText('执行器已记录进程退出。原命令的外部副作用仍需人工核对。',{exact:true}).waitFor();
  await panel.scrollIntoViewIfNeeded();await owner.screenshot({path:'test-results/collab/run-recovery.png',fullPage:true});
  await owner.setViewportSize({width:390,height:844});await panel.scrollIntoViewIfNeeded();await owner.screenshot({path:'test-results/collab/run-recovery-mobile.png',fullPage:true});
  assert.ok(await owner.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));await owner.setViewportSize({width:1440,height:1000});
  console.log('PASS: run UI selection, lost-response retry, durable output after reload, observer permissions, stop confirmation and mobile layout (protocol fixtures).');
  console.log('PASS: archival, recovery lost-response retry, missing evidence isolation, scoped/CSRF rejection, unknown-command preservation and refresh replay (protocol fixtures).');
 } finally {await owner.goto(original);await admin.end();await worker.end();}
}
