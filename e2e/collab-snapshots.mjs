import { openTask, taskAgent, showAgentTab, resizeWorkspace } from './collab-navigation.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { verifyValidationUi } from './collab-validations.mjs';
import { verifyResultUi } from './collab-results.mjs';
import { verifyIntentUi, verifyScopeUi } from './collab-intents.mjs';
import { verifyContractUi } from './collab-contracts.mjs';
import { verifyResourceUi } from './collab-resources.mjs';
import { verifyIntegrationUi } from './collab-integrations.mjs';

const exec=promisify(execFile);
export async function verifySnapshotUi({base,config,projectId,ownerContext,memberContext,owner,member,browser}) {
 const dbName=process.env.PI_COLLAB_E2E_DATABASE;
 if(!/^pi_collab_test_[a-f0-9]+$/.test(dbName??'')) throw new Error('Isolated database required');
 const admin=new Pool({connectionString:`postgresql://pi_collab_admin:${encodeURIComponent(config.adminPassword)}@127.0.0.1:${config.databasePort}/${dbName}`});
 const worker=async(mode,id)=>JSON.parse((await exec(process.execPath,['--import','tsx','scripts/e2e-snapshot-worker.ts',mode,...(id?[id]:[])],{timeout:60000})).stdout.trim());
 const original=owner.url(),headers={Origin:base};let freshContext;
 try {
  const repository=await worker('init',projectId);
  const response=await ownerContext.request.post(`${base}/api/collab/projects/${projectId}/tasks`,{headers,data:{title:'快照交接验收任务',description:'保存工作进度并在新浏览器恢复',acceptance:'暂存和未跟踪文件保留，旧凭据不复制'}});assert.equal(response.status(),200);const task=await response.json();
  await owner.goto(`${base}/`);await openTask(owner, '快照交接验收任务');
  const panel=taskAgent(owner),snapshots=owner.getByRole('region',{name:'任务交接快照'});
  await showAgentTab(owner, '设置');await panel.getByLabel('运行仓库').waitFor();
  // Delay an explicit refresh, then complete a newer one. This exercises the
  // stale-response guard in both production and Strict Mode development.
  let releaseConfiguration,configurationCaptured;
  const configurationGate=new Promise(resolve=>{releaseConfiguration=resolve;});
  const captured=new Promise(resolve=>{configurationCaptured=resolve;});let configurationRequests=0;
  const configurationUrl=`**/api/collab/projects/${projectId}/models`;
  await owner.route(configurationUrl,async route=>{
   if(++configurationRequests===1){const response=await route.fetch();configurationCaptured();await configurationGate;await route.fulfill({response,headers:{...response.headers(),'x-collab-delayed-config':'yes'}});}else await route.continue();
  });
  await panel.getByRole('button',{name:'刷新运行记录',exact:true}).click();await captured;
  const refreshed=owner.waitForResponse(response=>response.url().endsWith(`/projects/${projectId}/models`));
  await panel.getByRole('button',{name:'刷新运行记录',exact:true}).click();await(await refreshed).finished();
  await panel.getByLabel('运行仓库').selectOption(repository.id);await showAgentTab(owner, '对话');
  const delayed=owner.waitForResponse(response=>response.headers()['x-collab-delayed-config']==='yes');releaseConfiguration();await(await delayed).finished();
  await owner.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await panel.getByLabel('运行仓库').inputValue(),repository.id,'A stale configuration response must not reset the chosen repository');await owner.unroute(configurationUrl);
  await panel.getByRole('button',{name:'启动 AI',exact:true}).click();await panel.getByRole('status').filter({hasText:'排队中'}).waitFor();
  assert.equal((await admin.query('SELECT w.repository_id FROM collab.runs r JOIN collab.workspaces w ON w.id=r.workspace_id WHERE r.task_id=$1 ORDER BY r.created_at DESC LIMIT 1',[task.id])).rows[0].repository_id,repository.id,'The admitted run must keep the selected repository');
  console.log("CHECK: scope declarations");
  await verifyIntentUi({base,projectId,taskId:task.id,repository,ownerContext,memberContext,owner,member,admin});
  const first=await worker('run',task.id);await panel.getByRole('status').filter({hasText:'本次运行结束'}).waitFor();
  const revision=(await admin.query('SELECT revision FROM collab.runs WHERE id=$1',[first.runId])).rows[0].revision;
  const forbidden=await memberContext.request.post(`${base}/api/collab/runs/${first.runId}/snapshots`,{headers,data:{idempotencyKey:randomUUID(),expectedRevision:revision,note:'Observer cannot request a capture'}});assert.equal(forbidden.status(),403);
  const csrf=await ownerContext.request.post(`${base}/api/collab/runs/${first.runId}/snapshots`,{headers:{Origin:'https://untrusted.invalid'},data:{idempotencyKey:randomUUID(),expectedRevision:revision,note:'Cross-origin capture rejected'}});assert.equal(csrf.status(),403);
  let lost=true;
  await owner.route(`**/api/collab/runs/${first.runId}/snapshots`,async route=>{
   if(lost){lost=false;const accepted=await route.fetch();assert.equal(accepted.status(),202);await route.abort('failed');}else await route.continue();
  });
  await snapshots.getByLabel('快照交接说明').fill('已保存暂存和工作修改；接手后重新运行项目验证。');
  await snapshots.getByRole('button',{name:'保存交接快照'}).click();await snapshots.getByRole('button',{name:'重试同一快照请求'}).click();
  await snapshots.getByRole('status').filter({hasText:'等待生成快照'}).waitFor();
  assert.equal((await admin.query('SELECT 1 FROM collab.snapshots WHERE run_id=$1',[first.runId])).rowCount,1);
  await worker('capture');await snapshots.getByRole('status').filter({hasText:'快照可恢复'}).waitFor();
  const snapshot=(await admin.query('SELECT id FROM collab.snapshots WHERE run_id=$1',[first.runId])).rows[0];
  const manifestResponse=await ownerContext.request.get(`${base}/api/collab/snapshots/${snapshot.id}`);assert.equal(manifestResponse.status(),200);
  const {manifest}=await manifestResponse.json();assert.equal(manifest.runId,first.runId);assert.ok(manifest.excluded.some(file=>file.path==='.env'));
  console.log("CHECK: snapshot scope");
  await verifyScopeUi({base,snapshot,ownerContext,owner,admin});
  console.log("CHECK: snapshot validation");
  const validation=await verifyValidationUi({base,projectId,taskId:task.id,snapshot,manifest,repository,ownerContext,memberContext,owner,worker,admin});
  console.log("CHECK: task results");
  await verifyResultUi({base,projectId,taskId:task.id,validationId:validation.validationId,repository,ownerContext,memberContext,owner,member,worker,admin});
  await snapshots.getByText(/变更 \d+ 项 · 排除 \d+ 项/).click();await snapshots.getByText('.env · 私密路径',{exact:true}).waitFor();
  await snapshots.scrollIntoViewIfNeeded();await owner.screenshot({path:'test-results/collab/snapshots.png',fullPage:true});
  await resizeWorkspace(owner, {width:390,height:844});await snapshots.scrollIntoViewIfNeeded();await owner.screenshot({path:'test-results/collab/snapshots-mobile.png',fullPage:true});
  assert.ok(await owner.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));await resizeWorkspace(owner, {width:1440,height:1000});
  await member.goto(`${base}/`);await openTask(member, '快照交接验收任务');
  await member.getByRole('region',{name:'任务交接快照'}).getByRole('status').filter({hasText:'快照可恢复'}).waitFor();
  assert.equal(await member.getByRole('button',{name:'保存交接快照'}).count(),0);
  // New browser storage has only an authorized session, no source-page state.
  freshContext=await browser.newContext({storageState:await ownerContext.storageState(),viewport:{width:1440,height:1000}});
  const fresh=await freshContext.newPage();await fresh.goto(`${base}/`);await openTask(fresh, '快照交接验收任务');
  const next=taskAgent(fresh);await showAgentTab(fresh, '设置');await next.getByLabel('恢复来源').selectOption(snapshot.id);await showAgentTab(fresh, '对话');
  assert.equal(await next.getByLabel('运行仓库').inputValue(),repository.id);assert.ok((await next.getByLabel('AI 任务指令').inputValue()).includes('接手后重新运行项目验证'));
  await next.getByRole('button',{name:'启动 AI',exact:true}).click();await next.getByRole('status').filter({hasText:'排队中'}).waitFor();
  const restored=await worker('restore',task.id);assert.notEqual(first.workspaceId,restored.workspaceId);
  await next.getByRole('status').filter({hasText:'本次运行结束'}).waitFor();
  const tokens=(await admin.query('SELECT token_hash FROM collab_gateway.capabilities WHERE run_id=ANY($1::uuid[])',[[first.runId,restored.runId]])).rows;
  assert.equal(tokens.length,2);assert.equal(new Set(tokens.map(token=>token.token_hash)).size,2);
  console.log("CHECK: interface contracts");
  await verifyContractUi({base,projectId,repository,ownerContext,memberContext,owner,member,worker,admin});
  console.log("CHECK: managed resources");
  await verifyResourceUi({base,projectId,repository,ownerContext,memberContext,owner,member,admin});
  console.log("CHECK: integration and repair");
  await verifyIntegrationUi({base,projectId,repository,ownerContext,memberContext,owner,member,admin,browser});
  console.log('PASS: browser snapshot idempotency, scope/CSRF, real Pi file capture, exclusions, manifest access, fresh-browser restoration and fresh run capabilities (diagnostic tools; no model inference).');
 } finally {await freshContext?.close();await owner.goto(original).catch(() => {});await admin.end();}
}
