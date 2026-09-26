import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { Pool } from 'pg';

export async function verifyProjectMembership({ base, config, projectId, ownerContext, memberContext, owner, member }) {
 const dbName=process.env.PI_COLLAB_E2E_DATABASE;
 if(!/^pi_collab_test_[a-f0-9]+$/.test(dbName??'')) throw new Error('Isolated database required');
 const connection=(user,password)=>`postgresql://${user}:${encodeURIComponent(password)}@127.0.0.1:${config.databasePort}/${dbName}`;
 const admin=new Pool({connectionString:connection('pi_collab_admin',config.adminPassword)}),worker=new Pool({connectionString:connection('pi_collab_executor',config.executorPassword)});
 const original=owner.url(),headers={Origin:base},executor=randomUUID();
 const ownerUser=(await(await ownerContext.request.get(`${base}/api/collab/me`)).json()).user;
 const memberUser=(await(await memberContext.request.get(`${base}/api/collab/me`)).json()).user;
 const attach=async()=>{
  await member.evaluate(projectId=>{
   window.__projectEvents=[];window.__projectRevoked=false;window.__projectStream?.close();
   window.__projectStream=new EventSource(`/api/collab/projects/${projectId}/events`);
   window.__projectStream.addEventListener('run_event',event=>window.__projectEvents.push(JSON.parse(event.data)));
   window.__projectStream.addEventListener('access_revoked',()=>{window.__projectRevoked=true;window.__projectStream.close();});
  },projectId);
  await member.waitForFunction(()=>window.__projectEvents.length>0);
 };
 try {
  const originalProject=(await(await ownerContext.request.get(`${base}/api/collab/projects/${projectId}`)).json()).project;
  const secondResponse=await ownerContext.request.post(`${base}/api/collab/projects`,{headers,data:{organizationId:originalProject.organization_id,name:'独立权限项目',description:'验证项目权限相互独立'}});assert.equal(secondResponse.status(),200);const second=await secondResponse.json();
  await owner.goto(`${base}/projects/${second.id}/members`);
  await owner.getByLabel('成员邮箱',{exact:true}).fill(memberUser.email);await owner.getByLabel('授予项目角色').selectOption('developer');await owner.getByRole('button',{name:'添加到项目'}).click();await owner.getByText('成员已加入项目。',{exact:true}).waitFor();
  assert.equal((await memberContext.request.get(`${base}/api/collab/projects/${second.id}`)).status(),200);
  assert.equal((await memberContext.request.get(`${base}/api/collab/projects/${projectId}/members`)).status(),403);
  const repo=(await(await memberContext.request.get(`${base}/api/collab/projects/${projectId}/repositories`)).json()).repositories[0];
  const models=(await(await memberContext.request.get(`${base}/api/collab/projects/${projectId}/models`)).json()).models;
  const runs=[];
  for(const title of ['成员撤权中的运行','排队中的运行']) {
   const created=await memberContext.request.post(`${base}/api/collab/projects/${projectId}/tasks`,{headers,data:{title,description:'成员权限协议测试',acceptance:'撤销旧运行权限'}});assert.equal(created.status(),200);const task=await created.json();
   const accepted=await memberContext.request.post(`${base}/api/collab/tasks/${task.id}/runs`,{headers,data:{repositoryId:repo.id,baseSha:repo.base_sha,modelProfileId:models[0].id,prompt:'Protocol fixture only',expectedVersion:task.version,idempotencyKey:randomUUID()}});assert.equal(accepted.status(),202);runs.push({task,...await accepted.json()});
  }
  const claim=(await worker.query("SELECT collab_worker.claim_result_aware($1,'native') AS result",[executor])).rows[0].result;assert.equal(claim.run.id,runs[0].runId);
  await worker.query('SELECT collab_worker.mark_running($1,$2,$3)',[executor,claim.run.id,claim.run.epoch]);
  await attach();
  await owner.goto(`${base}/projects/${projectId}/members`);
  const row=owner.locator('form.collab-member-settings').filter({has:owner.getByText('Browser Member',{exact:true})});
  await row.getByLabel('Browser Member 的项目角色').selectOption('reviewer');await row.getByRole('button',{name:'保存权限'}).click();await owner.getByText('项目权限已更新；该成员原有的排队与执行中运行将停止。',{exact:true}).waitFor();
  await member.waitForFunction(()=>window.__projectRevoked===true,{},{timeout:5000});
  assert.equal((await(await ownerContext.request.get(`${base}/api/collab/runs/${runs[0].runId}`)).json()).run.status,'stopping');
  assert.equal((await(await ownerContext.request.get(`${base}/api/collab/runs/${runs[1].runId}`)).json()).run.status,'cancelled');
  assert.equal((await memberContext.request.get(`${base}/api/collab/me`)).status(),200);
  await worker.query('SELECT collab_worker.finish($1,$2,$3,$4,$5)',[executor,claim.run.id,claim.run.epoch,'cancelled',JSON.stringify({kind:'project-membership-browser-fixture'})]);
  await attach();
  await row.getByLabel('Browser Member 的项目访问').uncheck();await row.getByRole('button',{name:'保存权限'}).click();
  await member.waitForFunction(()=>window.__projectRevoked===true,{},{timeout:5000});
  for(const suffix of ['', '/audit', '/repositories', '/models','/events']) assert.equal((await memberContext.request.get(`${base}/api/collab/projects/${projectId}${suffix}`)).status(),404);
  assert.equal((await memberContext.request.get(`${base}/api/collab/runs/${runs[0].runId}/events`)).status(),404);
  assert.equal((await memberContext.request.get(`${base}/api/collab/projects/${second.id}`)).status(),200);
  assert.equal((await memberContext.request.get(`${base}/api/collab/me`)).status(),200);
  const assignment=owner.locator('form.collab-task-assignment').filter({has:owner.getByText('成员撤权中的运行',{exact:true})});
  await assignment.getByRole('combobox').selectOption(ownerUser.id);await assignment.getByRole('button',{name:'转交任务'}).click();await owner.getByText('负责人已更新。旧运行先停止，新负责人需重新发起运行。',{exact:true}).waitFor();
  assert.equal((await admin.query('SELECT owner_id FROM collab.tasks WHERE id=$1',[runs[0].task.id])).rows[0].owner_id,ownerUser.id);
  await row.getByLabel('Browser Member 的项目角色').selectOption('maintainer');await row.getByLabel('Browser Member 的项目访问').check();await row.getByRole('button',{name:'保存权限'}).click();
  await owner.getByText('项目权限已更新；该成员原有的排队与执行中运行将停止。',{exact:true}).waitFor();
  await member.goto(`${base}/projects/${projectId}/members`);
  const ownerRow=member.locator('form.collab-member-settings').filter({has:member.getByText('Browser Owner',{exact:true})});
  await ownerRow.getByLabel('Browser Owner 的项目访问').uncheck();await ownerRow.getByRole('button',{name:'保存权限'}).click();await member.getByText('项目权限已更新；该成员原有的排队与执行中运行将停止。',{exact:true}).waitFor();
  assert.equal((await ownerContext.request.get(`${base}/api/collab/projects/${projectId}`)).status(),404);
  await owner.goto(original);await owner.getByLabel('Identity project 的接管原因').fill('维护者交接后需要恢复项目管理并核对运行状态。');
  const recovery=owner.locator('.collab-governance-row').filter({has:owner.getByText('Identity project',{exact:true})});await recovery.getByRole('button',{name:'应急加入项目'}).click();await recovery.getByRole('link',{name:'管理项目成员'}).waitFor();
  const audit=await(await ownerContext.request.get(`${base}/api/collab/projects/${projectId}/audit`)).json();assert.ok(audit.events.some(event=>event.action==='project.emergency_access'&&event.detail.reason==='维护者交接后需要恢复项目管理并核对运行状态。'));
  await recovery.getByRole('link',{name:'管理项目成员'}).click();
  await row.getByLabel('Browser Member 的项目角色').selectOption('developer');await row.getByRole('button',{name:'保存权限'}).click();await owner.getByText('项目权限已更新；该成员原有的排队与执行中运行将停止。',{exact:true}).waitFor();
  await mkdir('test-results/collab',{recursive:true});await owner.screenshot({path:'test-results/collab/project-members.png',fullPage:true});
  await owner.setViewportSize({width:390,height:844});await owner.screenshot({path:'test-results/collab/project-members-mobile.png',fullPage:true});assert.ok(await owner.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await owner.setViewportSize({width:1440,height:1000});
  console.log('PASS: project member UI add/demote/remove/regrant, scoped SSE revocation, unaffected second project, task handoff, MFA-backed emergency access and audit (protocol fixtures).');
 } finally {await member.evaluate(()=>window.__projectStream?.close());await owner.goto(original);await admin.end();await worker.end();}
}
