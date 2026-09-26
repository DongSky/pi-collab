import { openTeamAccountMenu } from './collab-navigation.mjs';
import {verifyInlineIntegration} from "./collab-inline-discussions.mjs";
import { resolveCollabSuite } from './collab-suites.mjs';
import {verifySubtasks} from "./collab-subtasks.mjs";
import {verifyEvidence} from "./collab-evidence.mjs";
import { chromium } from 'playwright';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { randomBytes, createHmac } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { verifyExecutionApi } from './collab-execution-api.mjs';
import { verifyRunUi } from './collab-run-ui.mjs';
import { verifyProjectMembership } from './collab-project-members.mjs';
import { verifySnapshotUi } from './collab-snapshots.mjs';
import { verifyWorkspaceGitUi } from './collab-workspace-git.mjs';
import { verifyTaskPushPreviewsUi } from './collab-push-history.mjs';
import { verifyProjectMap } from './collab-project-map.mjs';
import { verifyHistory } from './collab-history.mjs';
import { verifyEnvironmentHandoff } from './collab-environment-handoff.mjs';
import { verifyAdministration } from './collab-administration.mjs';
import { verifyCapacity } from './collab-capacity.mjs';
import { verifyPullReleaseUi } from './collab-pull-release.mjs';
import { verifySharedTerminal } from './collab-shared-terminal.mjs';
import { verifyPreviews } from './collab-previews.mjs';
import { verifyMemory } from './collab-memory.mjs';
import { verifyGitLab } from './collab-gitlab.mjs';
import { verifyCompatibility } from './collab-compatibility.mjs';
import { verifyOidc } from './collab-oidc.mjs';
import { verifyEditor } from './collab-editor.mjs';
import { verifyDiscussions } from './collab-discussions.mjs';
import { verifyRunControl } from './collab-run-control.mjs';
process.env.PI_COLLAB_E2E_FOCUS = resolveCollabSuite(process.env.PI_COLLAB_E2E_FOCUS);
const base = process.env.PI_COLLAB_E2E_URL;
const data = process.env.PI_COLLAB_E2E_DATA;
if (!base?.startsWith('http://127.0.0.1:') || !data?.includes('identity-e2e-')) throw new Error('Use npm run test:collab:identity:e2e with its isolated server');
const config = JSON.parse(await readFile('.local/config.json', 'utf8'));
const password = randomBytes(20).toString('hex');
const browser = await chromium.launch({ headless: true });
function totp(secret) {
 const bits = [...secret].map(c => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5,'0')).join('');
 const key = Buffer.from(bits.match(/.{8}/g).map(byte => parseInt(byte,2)));
 const counter = Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));
 const digest = createHmac('sha1',key).update(counter).digest(), offset = digest[19]&15;
 return ((digest.readUInt32BE(offset)&0x7fffffff)%1000000).toString().padStart(6,'0');
}
async function signIn(page,email,secret) {
 await page.goto(`${base}/sign-in`);
 await page.getByLabel('邮箱',{exact:true}).fill(email);await page.getByLabel('密码',{exact:true}).fill(password);
 await page.getByRole('button',{name:'登录',exact:true}).click();
 if (secret) {await page.getByLabel('验证码',{exact:true}).fill(totp(secret));await page.getByRole('button',{name:'验证并继续'}).click();}
 await page.waitForURL(`${base}/`);
}
try {
 const ownerContext=await browser.newContext({viewport:{width:1440,height:1000}}), owner=await ownerContext.newPage();
 await owner.goto(`${base}/setup`);await owner.getByLabel('初始化令牌').fill(config.bootstrapToken);await owner.getByLabel('团队名称').fill('Browser identity team');await owner.getByLabel('姓名',{exact:true}).fill('Browser Owner');await owner.getByLabel('邮箱',{exact:true}).fill('browser-owner@pi-collab.test');await owner.getByLabel('新账户密码').fill(password);
 await owner.getByRole('button',{name:'创建工作空间'}).click();await owner.getByRole('heading',{name:'工作空间已创建',exact:true}).waitFor();
 await owner.goto(`${base}/setup`);await owner.getByRole('heading',{name:'初始化已完成'}).waitFor();
 await signIn(owner,'browser-owner@pi-collab.test');
 const oldContext=await browser.newContext(),old=await oldContext.newPage();await signIn(old,'browser-owner@pi-collab.test');
 await owner.getByRole('link',{name:'账户安全',exact:true}).click();await owner.getByLabel('当前密码').fill(password);await owner.getByRole('button',{name:'设置验证器'}).click();
 const secret=await owner.getByLabel('设置密钥').inputValue();
 await owner.getByLabel('验证码',{exact:true}).fill(totp(secret));await owner.getByRole('button',{name:'验证并启用'}).click();await owner.getByText('多因素验证已启用。请离线保存恢复码；旧会话已撤销。',{exact:true}).waitFor();
 await owner.getByRole('button',{name:'已保存，隐藏恢复码'}).click();
 assert.equal((await oldContext.request.get(`${base}/api/collab/me`)).status(),401);
 await owner.goto(`${base}/`);await owner.getByRole('button',{name:'＋ 新建项目',exact:true}).click();await owner.getByLabel('项目名称').fill('Identity project');await owner.getByRole('button',{name:'创建',exact:true}).click();await owner.getByRole('heading',{name:'Identity project',exact:true}).waitFor();
 await openTeamAccountMenu(owner);await owner.getByRole('link',{name:'管理 Browser identity team'}).click();
 await owner.getByLabel('受邀邮箱').fill('browser-member@pi-collab.test');await owner.getByLabel('同时加入项目').selectOption({label:'Identity project'});await owner.getByRole('button',{name:'创建邀请链接'}).click();
 const inviteURL=await owner.getByLabel('邀请链接（仅此次显示，48 小时有效）').inputValue();
 const memberContext=await browser.newContext(),member=await memberContext.newPage();await member.goto(inviteURL);await member.getByLabel('姓名',{exact:true}).fill('Browser Member');await member.getByLabel('新账户密码').fill(password);await member.getByRole('button',{name:'接受邀请'}).click();await member.getByRole('heading',{name:'已加入团队',exact:true}).waitFor();
 await signIn(member,'browser-member@pi-collab.test');await member.getByRole('heading',{name:'Identity project',exact:true}).waitFor();
 const projectId=await verifyExecutionApi({base,config,ownerContext,memberContext,owner,member});
 if (process.env.PI_COLLAB_E2E_FOCUS === 'workspace-git') {
  console.log("CHECK: workspace Git");
  await verifyWorkspaceGitUi({base,config,projectId,owner,member,ownerContext,memberContext});
 } else if (process.env.PI_COLLAB_E2E_FOCUS === 'subtasks') {
  await verifySubtasks({base,projectId,owner,member,ownerContext,memberContext});
 } else if (process.env.PI_COLLAB_E2E_FOCUS === 'evidence') {
  await verifyEvidence({base,projectId,owner,member,ownerContext,memberContext});
 } else if (process.env.PI_COLLAB_E2E_FOCUS === 'previews') {
  await verifyPreviews({base,projectId,owner,member,ownerContext,memberContext});
 } else if (process.env.PI_COLLAB_E2E_FOCUS === 'memory') {
  await verifyMemory({base,projectId,owner,member,ownerContext,memberContext});
 } else if (process.env.PI_COLLAB_E2E_FOCUS === 'gitlab') {
  await verifyGitLab({base,projectId,owner,member,ownerContext,memberContext});
 } else if (process.env.PI_COLLAB_E2E_FOCUS === 'compatibility') {
  await verifyCompatibility({base,projectId,owner,member,ownerContext,memberContext});
 } else if (process.env.PI_COLLAB_E2E_FOCUS === 'oidc') {
  await verifyOidc({base,owner,member,ownerContext,memberContext,browser,secret,totp,signIn});
 } else if (process.env.PI_COLLAB_E2E_FOCUS === 'history') {
  await verifyHistory({base,projectId,ownerContext,memberContext,owner,member});
 } else if (process.env.PI_COLLAB_E2E_FOCUS === 'environment-handoff') {
  await verifyEnvironmentHandoff({base,projectId,ownerContext,memberContext,owner,member});
 } else if (process.env.PI_COLLAB_E2E_FOCUS === 'administration') {
  await verifyAdministration({base,projectId,ownerContext,memberContext,owner,member});
 } else if (process.env.PI_COLLAB_E2E_FOCUS === 'capacity') {
  await verifyCapacity({base,projectId,ownerContext,memberContext,owner,member});
 } else if (process.env.PI_COLLAB_E2E_FOCUS === 'pull-release') {
  await verifyPullReleaseUi({base,projectId,ownerContext,memberContext,owner,member});
 } else if (process.env.PI_COLLAB_E2E_FOCUS === 'shared-terminal') {
  await verifySharedTerminal({base,config,projectId,ownerContext,memberContext,owner,member});
 } else if (process.env.PI_COLLAB_E2E_FOCUS === 'inline-integration') {
  await verifyInlineIntegration({base,projectId,ownerContext,memberContext,owner,member});
 } else if (process.env.PI_COLLAB_E2E_FOCUS === 'editor') {
  await verifyEditor({base,config,projectId,ownerContext,memberContext,owner,member});
 } else if (process.env.PI_COLLAB_E2E_FOCUS === 'discussions') {
  await verifyDiscussions({base,config,projectId,ownerContext,memberContext,owner,member});
 } else if (process.env.PI_COLLAB_E2E_FOCUS === 'run-control') {
  await verifyRunControl({base,config,projectId,ownerContext,memberContext,owner,member});
 } else if (process.env.PI_COLLAB_E2E_FOCUS === 'project-map') {
  await verifyProjectMap({base,config,projectId,ownerContext,memberContext,owner,member});
 } else if (process.env.PI_COLLAB_E2E_FOCUS === 'push-history') {
  console.log("CHECK: outgoing Git history");
  await verifyTaskPushPreviewsUi({base,config,projectId,ownerContext,memberContext,owner,member});
  console.log('PASS: focused outgoing-history browser acceptance (not the full identity suite).');
 } else {
 console.log("CHECK: run controls and recovery");
 await verifyRunUi({base,config,projectId,ownerContext,memberContext,owner,member});
 console.log("CHECK: workspace Git");
 await verifyWorkspaceGitUi({base,config,projectId,ownerContext,memberContext,owner,member});
 console.log("CHECK: outgoing Git history");
 await verifyTaskPushPreviewsUi({base,config,projectId,ownerContext,memberContext,owner,member});
 console.log("CHECK: snapshots and collaboration");
 await verifySnapshotUi({base,config,projectId,ownerContext,memberContext,owner,member,browser});
 console.log("CHECK: project membership");
 await verifyProjectMembership({base,config,projectId,ownerContext,memberContext,owner,member});
 assert.equal(await member.getByRole('link',{name:'管理 Browser identity team'}).count(),0);
 const duplicate=await browser.newContext(),duplicatePage=await duplicate.newPage();await duplicatePage.goto(inviteURL);await duplicatePage.getByText('邀请已失效、被撤销或已使用。',{exact:true}).waitFor();assert.equal(await duplicatePage.getByRole('button',{name:'接受邀请'}).isDisabled(),true);
 await member.goto(`${base}/forgot-password`);await member.getByLabel('账户邮箱').fill('browser-member@pi-collab.test');await member.getByRole('button',{name:'获取重置链接'}).click();await member.getByRole('status').waitFor();
 const mailbox=path.join(data,'mailbox');const mails=await readdir(mailbox);assert.equal(mails.length,1);
 const mail=JSON.parse(await readFile(path.join(mailbox,mails[0]),'utf8'));const reset=mail.text.match(/https?:\/\/\S+/)[0];
 await member.goto(reset);await member.getByLabel('新密码',{exact:true}).fill(password);await member.getByRole('button',{name:'保存新密码'}).click();await member.getByText('密码已重置，旧会话已撤销，请重新登录。',{exact:true}).waitFor();
 assert.equal((await memberContext.request.get(`${base}/api/collab/me`)).status(),401);await signIn(member,'browser-member@pi-collab.test');
 await member.evaluate(projectId=>{window.__revoked=false;window.__revocationStream=new EventSource(`/api/collab/projects/${projectId}/events`);window.__revocationStream.addEventListener('access_revoked',()=>{window.__revoked=true;window.__revocationStream.close();});},projectId);
 await owner.reload();
 const row=owner.locator('form.collab-member-settings').filter({has:owner.getByText('Browser Member',{exact:true})});await row.getByRole('checkbox',{name:'启用'}).uncheck();
 await Promise.all([owner.waitForResponse(response=>response.url().includes('/api/collab/organizations/')&&response.request().method()==='GET'),row.getByRole('button',{name:'保存',exact:true}).click()]);
 assert.equal((await memberContext.request.get(`${base}/api/collab/me`)).status(),401);
 await member.waitForFunction(()=>window.__revoked===true);
 const ownerRow=owner.locator('form.collab-member-settings').filter({has:owner.getByText('Browser Owner',{exact:true})});await ownerRow.getByRole('combobox').selectOption('member');await ownerRow.getByRole('button',{name:'保存',exact:true}).click();await owner.getByText('团队必须至少保留一位启用的所有者。',{exact:true}).waitFor();
 await owner.reload();await owner.getByRole('heading',{name:'团队成员',exact:true}).waitFor();
 await owner.getByRole('heading',{name:'邀请记录',exact:true}).scrollIntoViewIfNeeded();
 await mkdir('test-results/collab',{recursive:true});await owner.screenshot({path:'test-results/collab/identity-members.png',fullPage:true});
 await owner.setViewportSize({width:390,height:844});
 await owner.getByRole('heading',{name:'邀请记录',exact:true}).scrollIntoViewIfNeeded();
 assert.equal(await owner.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await owner.screenshot({path:'test-results/collab/identity-members-mobile.png',fullPage:true});
 await signIn(old,'browser-owner@pi-collab.test',secret);await old.getByLabel('当前项目',{exact:true}).selectOption({label:'Identity project'});await old.locator('.wb-title-project').filter({hasText:/^Identity project$/}).waitFor();
 assert.equal(await old.getByLabel('当前项目',{exact:true}).inputValue(),projectId);assert.equal((await oldContext.request.get(`${base}/api/collab/projects/${projectId}`)).status(),200);
 console.log('PASS: isolated full-stack browser setup, real MFA enrollment/login, invitation registration/replay, password reset, session revocation, member deactivation and last-owner protection.');
 }
} finally {await browser.close();}
