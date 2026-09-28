import { resizeWorkspace } from './collab-navigation.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function verifyValidationUi({base,projectId,taskId,snapshot,manifest,repository,ownerContext,memberContext,owner,worker,admin}) {
 const headers={Origin:base},panel=owner.getByRole('region',{name:'快照验证',exact:true});
 await panel.getByText('创建验证配置版本',{exact:true}).click();
 await panel.getByLabel('验证配置名称').fill('固定工作版本检查');
 await panel.getByLabel('验证配置仓库').selectOption(repository.id);
 const script="require('node:assert/strict').equal(require('node:fs').readFileSync('code.txt','utf8'),'working\\n')";
 await panel.getByLabel('步骤 1 参数').fill(`-e\n${script}`);
 await panel.screenshot({path:'test-results/collab/validations-profile.png'});
 await resizeWorkspace(owner, {width:390,height:844});await panel.screenshot({path:'test-results/collab/validations-profile-mobile.png'});
 assert.ok(await owner.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));await resizeWorkspace(owner, {width:1440,height:1000});
 const saved=owner.waitForResponse(response=>response.url().endsWith(`/projects/${projectId}/validation-profiles`)&&response.request().method()==='POST');
 await panel.getByRole('button',{name:'保存验证配置',exact:true}).click();assert.equal((await saved).status(),201);
 const profiles=await ownerContext.request.get(`${base}/api/collab/projects/${projectId}/validation-profiles`);assert.equal(profiles.status(),200);
 const profile=(await profiles.json()).profiles.find(p=>p.name==='固定工作版本检查');assert.ok(profile);
 await panel.getByText('创建验证配置版本',{exact:true}).click();
 await panel.getByText('手动验证（高级）',{exact:true}).click();
 await panel.getByLabel('待验证快照').selectOption(snapshot.id);
 await panel.getByLabel('验证配置',{exact:true}).selectOption(profile.id);
 const invalidCreate=await memberContext.request.post(`${base}/api/collab/projects/${projectId}/validation-profiles`,{headers,data:{repositoryId:repository.id,name:'Forbidden',config:profile.config,idempotencyKey:randomUUID()}});assert.equal(invalidCreate.status(),403);
 const forbidden=await memberContext.request.post(`${base}/api/collab/snapshots/${snapshot.id}/validations`,{headers,data:{profileId:profile.id,idempotencyKey:randomUUID()}});assert.equal(forbidden.status(),403);
 const csrf=await ownerContext.request.post(`${base}/api/collab/snapshots/${snapshot.id}/validations`,{headers:{Origin:'https://untrusted.invalid'},data:{profileId:profile.id,idempotencyKey:randomUUID()}});assert.equal(csrf.status(),403);
 let lost=true;
 await owner.route(`**/api/collab/snapshots/${snapshot.id}/validations`,async route=>{
  if(lost){lost=false;const response=await route.fetch();assert.equal(response.status(),202);await route.abort('failed');}else await route.continue();
 });
 await panel.getByRole('button',{name:'执行快照验证',exact:true}).click();
 await panel.getByRole('button',{name:'重试同一验证操作'}).click();await panel.getByRole('status').filter({hasText:'验证排队中'}).waitFor();
 assert.equal((await admin.query('SELECT 1 FROM collab.validations WHERE snapshot_id=$1',[snapshot.id])).rowCount,1);
 const result=await worker('validate');assert.equal(result.outcome,'passed');
 await panel.getByRole('status').filter({hasText:'指定检查通过'}).waitFor();
 const response=await ownerContext.request.get(`${base}/api/collab/validations/${result.validationId}`);assert.equal(response.status(),200);
 const {validation}=await response.json();assert.equal(validation.evidence.worktreeCommit,manifest.worktreeCommit);
 assert.equal(validation.evidence.steps[0].exitCode,0);assert.equal(validation.evidence.steps[0].cleanupConfirmed,true);
 assert.equal((await memberContext.request.get(`${base}/api/collab/validations/${result.validationId}`)).status(),200);
 await panel.scrollIntoViewIfNeeded();await owner.screenshot({path:'test-results/collab/validations.png',fullPage:true});
 await resizeWorkspace(owner, {width:390,height:844});await panel.scrollIntoViewIfNeeded();await owner.screenshot({path:'test-results/collab/validations-mobile.png',fullPage:true});
 assert.ok(await owner.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));await resizeWorkspace(owner, {width:1440,height:1000});
 await panel.getByRole('button',{name:'执行快照验证',exact:true}).click();await panel.getByRole('status').filter({hasText:'验证排队中'}).waitFor();
 await panel.getByRole('button',{name:'停止验证',exact:true}).click();await panel.getByRole('status').filter({hasText:'验证已停止'}).waitFor();
 assert.equal((await ownerContext.request.get(`${base}/api/collab/tasks/${taskId}/validations`)).status(),200);
 console.log('PASS: browser immutable validation configuration, scope/CSRF, lost-response retry, actual command evidence on exact working code, queued cancellation and mobile layout.');
 return {validationId:result.validationId};
}
