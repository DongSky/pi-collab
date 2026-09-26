import { openTeamAccountMenu } from './collab-navigation.mjs';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
export async function verifyAdministration({base,projectId,ownerContext,memberContext,owner}){
 const exec=promisify(execFile),worker=async mode=>JSON.parse((await exec(process.execPath,['--import','tsx','scripts/e2e-administration-worker.ts',mode])).stdout.trim());
 const model=JSON.parse((await exec(process.execPath,['--import','tsx','scripts/e2e-capacity-worker.ts',projectId])).stdout.trim());await worker('quarantine');
 await owner.goto(base);await openTeamAccountMenu(owner);await owner.getByRole('link',{name:'管理 Browser identity team',exact:true}).click();const pane=owner.getByRole('region',{name:'运行与审计管理'});await pane.getByRole('button',{name:'管理模型',exact:true}).click();
 await pane.getByLabel('模型操作',{exact:true}).selectOption('disable');await pane.getByLabel('模型操作说明',{exact:true}).fill('为团队停用这个验收模型并保留全部历史');await pane.getByRole('checkbox',{name:'确认此操作可能中断使用该模型的 AI',exact:true}).check();await pane.getByRole('button',{name:'提交模型操作',exact:true}).click();await pane.getByText('fixture-model · 已停用 · 本机凭据已配置 · 版本 2',{exact:true}).waitFor();
 const forbidden=await memberContext.request.post(`${base}/api/collab/models/${model.modelId}/manage`,{headers:{Origin:base},data:{action:'enable',expectedVersion:2,idempotencyKey:randomUUID(),reason:'Unprivileged model operation must be denied'}});assert.equal(forbidden.status(),403);
 await pane.getByRole('button',{name:'处理异常运行',exact:true}).click();await pane.getByLabel('处置方式',{exact:true}).selectOption('isolate');await pane.getByLabel('处置说明',{exact:true}).fill('记录旧工作区继续隔离并等待部署管理员核查进程');const [isolated]=await Promise.all([owner.waitForResponse(r=>r.url().endsWith('/disposition')&&r.request().method()==='POST'),pane.getByRole('button',{name:'提交运行处置',exact:true}).click()]);assert.ok(isolated.ok());
 await pane.getByLabel('检索审计',{exact:true}).fill('run.isolation_recorded');const [searched]=await Promise.all([owner.waitForResponse(r=>r.url().includes('/administration?q=run.isolation_recorded')&&r.request().method()==='GET'),pane.getByRole('button',{name:'检索',exact:true}).click()]);assert.equal((await searched.json()).events.length,1);await pane.getByText('run.isolation_recorded',{exact:true}).waitFor();await pane.getByText('model.disable',{exact:true}).waitFor({state:'hidden'});
 await pane.screenshot({path:'test-results/collab/administration-desktop.png'});await owner.setViewportSize({width:390,height:844});assert.equal(await owner.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await pane.screenshot({path:'test-results/collab/administration-mobile.png'});
 await worker('recovery');const ticket=JSON.parse(await readFile(path.join(process.env.PI_COLLAB_E2E_DATA,'account-recovery.json'),'utf8')),password=randomBytes(20).toString('hex');
 const noOrigin=await memberContext.request.post(`${base}/api/collab/account-recovery`,{data:{token:ticket.token,password}});assert.equal(noOrigin.status(),403);
 await owner.goto(`${base}/account-recovery#token=${ticket.token}`);await owner.getByLabel('新密码',{exact:true}).fill(password);await owner.getByLabel('确认新密码',{exact:true}).fill(password);await owner.getByRole('button',{name:'恢复账户',exact:true}).click();await owner.getByRole('status').filter({hasText:'密码已重置'}).waitFor();assert.equal(new URL(owner.url()).hash,'');
 assert.equal((await ownerContext.request.get(`${base}/api/collab/me`)).status(),401);await owner.getByRole('link',{name:'重新登录',exact:true}).click();await owner.getByLabel('邮箱',{exact:true}).fill('browser-owner@pi-collab.test');await owner.getByLabel('密码',{exact:true}).fill(password);await owner.getByRole('button',{name:'登录',exact:true}).click();await owner.waitForURL(`${base}/`);
 console.log('PASS: administrator model control, member rejection, quarantined-run disposition, audit search and single-use all-factor recovery with real browser sign-in/session revocation.');
}
