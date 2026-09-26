import {verifyServicePreviews} from './collab-service-previews.mjs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile),evidencePrefix=process.env.PI_COLLAB_RUNTIME==='docker'?'container-preview':'preview';
export async function verifyPreviews({base,projectId,owner,member,ownerContext,memberContext}){
 const worker=async(mode,id)=>JSON.parse((await exec(process.execPath,['--import','tsx','scripts/e2e-snapshot-worker.ts',mode,...(id?[id]:[])],{timeout:60000})).stdout.trim());
 const post=async(endpoint,data,context=memberContext)=>{const r=await context.request.post(`${base}/api/collab/${endpoint}`,{headers:{Origin:base},data});assert.ok(r.ok(),`${endpoint}: ${r.status()}`);return r.json();};
 const get=async endpoint=>{const r=await memberContext.request.get(`${base}/api/collab/${endpoint}`);assert.ok(r.ok());return r.json();};
 const repository=await worker('init',projectId),task=await post(`projects/${projectId}/tasks`,{title:'固定检查点评审页面',description:'通过验证后提供静态沙箱',acceptance:'双成员访问互相独立且可撤回'});
 await post(`tasks/${task.id}/runs`,{repositoryId:repository.id,baseSha:repository.baseSha,prompt:'Static checkpoint fixture',expectedVersion:task.version,idempotencyKey:randomUUID()});const run=await worker('preview',task.id),detail=await get(`runs/${run.runId}`),snapshot=await post(`runs/${run.runId}/snapshots`,{expectedRevision:detail.run.revision,note:'静态页面评审检查点',idempotencyKey:randomUUID()});await worker('capture');
 const profile=await post(`projects/${projectId}/validation-profiles`,{repositoryId:repository.id,name:'固定静态页面校验',config:{version:1,steps:[{tool:'node',args:['check.cjs'],timeoutSeconds:10}]},idempotencyKey:randomUUID()},ownerContext),validation=await post(`snapshots/${snapshot.snapshotId}/validations`,{profileId:profile.profileId,idempotencyKey:randomUUID()});assert.equal((await worker('validate')).outcome,'passed');
 for(const page of [owner,member]){await page.goto(base);await page.locator('.collab-task-row').filter({hasText:task.title}).click();}
 const a=owner.getByRole('region',{name:'检查点独立预览',exact:true}),b=member.getByRole('region',{name:'检查点独立预览',exact:true});await b.getByText('从验证检查点创建预览',{exact:true}).click();await b.getByLabel('预览验证来源',{exact:true}).selectOption(validation.validationId);await b.getByLabel('预览名称',{exact:true}).fill('团队固定静态页面');await b.getByRole('button',{name:'创建固定静态预览',exact:true}).click();await b.getByRole('article',{name:'预览 团队固定静态页面',exact:true}).getByText(/可预览/).waitFor();
 await b.getByRole('button',{name:'打开独立预览',exact:true}).click();const bm=member.frameLocator('iframe[title="固定检查点沙箱预览"]');await bm.getByRole('heading',{name:'已验证的固定页面',exact:true}).waitFor();await bm.getByText('沙箱阻止 Cookie 访问',{exact:true}).waitFor();await bm.getByRole('button',{name:'团队点击 0',exact:true}).click();await bm.getByRole('button',{name:'团队点击 1',exact:true}).waitFor();
 await a.getByRole('button',{name:'打开独立预览',exact:true}).click();const am=owner.frameLocator('iframe[title="固定检查点沙箱预览"]');await am.getByRole('button',{name:'团队点击 0',exact:true}).waitFor();
 const url=await b.locator('iframe').getAttribute('src');assert.notEqual(new URL(url).origin,base);assert.equal((await fetch(url)).headers.get('set-cookie'),null);
 await a.locator('iframe').screenshot({path:`test-results/collab/${evidencePrefix}-desktop.png`});await member.setViewportSize({width:390,height:844});await b.locator('iframe').screenshot({path:`test-results/collab/${evidencePrefix}-mobile.png`});assert.equal(await member.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await a.getByLabel('撤销预览说明',{exact:true}).fill('本次页面评审已结束，撤销所有临时访问。');await a.getByRole('button',{name:'撤销此预览',exact:true}).click();await b.locator('iframe').waitFor({state:'detached'});assert.equal((await fetch(url)).status,404);
 const listing=await get(`tasks/${task.id}/previews`);assert.equal(listing.previews[0].status,'revoked');assert.ok(listing.logs.some(l=>l.path==='app.js'&&l.status===200));assert.equal((await fetch(`${base}/api/collab/tasks/${task.id}/previews`)).status,401);
 await verifyServicePreviews({base,taskId:task.id,validationId:validation.validationId,owner,member,ownerContext,memberContext});
 console.log('PASS: real Pi static checkpoint and fixed validation, two-browser independent interactive sandboxes, separate origin, blocked cookie access, resource log and immediate revocation; no inference or external deployment.');
}
