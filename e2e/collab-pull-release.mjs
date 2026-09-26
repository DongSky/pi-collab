import {verifyInlineThread} from "./collab-inline-discussions.mjs";
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec=promisify(execFile);
export async function verifyPullReleaseUi({base,projectId,ownerContext,memberContext,owner,member}){
 const headers={Origin:base},worker=async(mode,id)=>JSON.parse((await exec(process.execPath,['--import','tsx','scripts/e2e-push-history-worker.ts',mode,id],{timeout:60000})).stdout.trim());
 const get=async(p,c=memberContext)=>{const r=await c.request.get(`${base}/api/collab/${p}`);assert.ok(r.ok(),`${p}: ${r.status()}`);return r.json();};
 const post=async(p,data,c=memberContext)=>{const r=await c.request.post(`${base}/api/collab/${p}`,{headers,data});assert.ok(r.ok(),`${p}: ${r.status()}`);return r.json();};
 const repo=await worker('init',projectId),task=await post(`projects/${projectId}/tasks`,{title:'独立评审与合并验收',description:'固定版本经过评审后交付',acceptance:'远端分支受保护'});
 await post(`tasks/${task.id}/runs`,{repositoryId:repo.id,baseSha:repo.baseSha,prompt:'Local protocol fixture, no model inference',expectedVersion:task.version,idempotencyKey:randomUUID()});
 const run=await worker('run',task.id),state=await get(`runs/${run.runId}/git/preview`);
 const preview=await post(`runs/${run.runId}/push-previews`,{idempotencyKey:randomUUID(),revision:state.revision,head:state.head,expectedRunRevision:state.runRevision});await worker('process',preview.jobId);
 const scope=(await get(`push-previews/${preview.jobId}/confirmations`)).scope;
 const confirmation=await post(`push-previews/${preview.jobId}/confirmations`,{...scope,idempotencyKey:randomUUID(),acknowledgeHistory:true,acknowledgeDestination:true,acknowledgeDisclosure:true});
 const delivery=await post(`push-confirmations/${confirmation.id}/send`,{idempotencyKey:randomUUID(),manifestHash:scope.manifestHash,acknowledgePush:true});await worker('send',preview.jobId);
 const pc=await get(`push-deliveries/${delivery.jobId}/pull-proposals`),proposal=await post(`push-deliveries/${delivery.jobId}/pull-proposals`,{idempotencyKey:randomUUID(),expectedTaskVersion:pc.taskVersion,title:'Independent code delivery',body:'Test fixed review and protected merge'});
 const p=await worker('pull-proposal',proposal.jobId);await post(`pull-proposals/${proposal.jobId}/create`,{idempotencyKey:randomUUID(),requestHash:p.attempt.requestHash,observationHash:p.observationHash,acknowledgeContent:true,acknowledgeNotification:true,acknowledgeVersions:true});await worker('pull-create',proposal.jobId);
 async function capture(){const c=await get(`pull-changes/${proposal.jobId}/observations`);const observation=await post(`pull-changes/${proposal.jobId}/observations`,{idempotencyKey:randomUUID(),expectedTaskVersion:c.taskVersion,expectedObservationVersion:c.observationVersion});await worker('pull-observe',observation.jobId);const r=await get(`pull-changes/${proposal.jobId}/revisions`);const revision=await post(`pull-changes/${proposal.jobId}/revisions`,{idempotencyKey:randomUUID(),expectedTaskVersion:r.taskVersion,expectedObservationVersion:r.observationVersion});assert.equal((await worker('pull-revision',revision.jobId)).status,'ready');return revision.jobId;}
 async function open(page,id){await page.goto(base);await page.locator('.collab-task-row').filter({hasText:task.title}).click();await page.getByRole('button',{name:'审阅全部出站历史',exact:true}).click();const pane=page.locator(`[data-pull-revision="${id}"] details[aria-label="PR 团队评审与交付"]`);await pane.waitFor({state:'attached'});await pane.evaluate(node=>{for(let parent=node;parent;parent=parent.parentElement){if(parent.tagName==='DETAILS')parent.open=true;}});return pane;}
 let revision=await capture(),pane=await open(owner,revision);
 await open(member,revision);
 async function code(page){const card=page.locator(`[data-pull-revision="${revision}"]`),code=card.getByLabel('固定 PR 代码差异',{exact:true});await code.evaluate(node=>{node.open=true;});await code.getByRole('button',{name:'读取固定 PR 文件列表',exact:true}).click();await code.getByRole('button',{name:'修改 · code.txt',exact:true}).click();return code;}
 await verifyInlineThread({base,ownerContext,memberContext,owner,member,ownerCode:await code(owner),memberCode:await code(member),kind:'pull',sourceId:revision});

 await pane.getByLabel('PR 交付说明',{exact:true}).fill('准备发布这个固定草稿供团队评审');await pane.getByRole('checkbox',{name:'确认将此草稿转为待评审并触发 GitHub 通知',exact:true}).check();const [readyResponse]=await Promise.all([owner.waitForResponse(r=>r.url().endsWith(`/pull-revisions/${revision}/release`)&&r.request().method()==='POST'),pane.getByRole('button',{name:'转为待评审',exact:true}).click()]);
 assert.ok(readyResponse.ok());assert.equal((await worker('pull-release',(await readyResponse.json()).jobId)).status,'ready');await pane.getByRole('status').filter({hasText:'已转为待评审'}).waitFor();
 revision=await capture();pane=await open(owner,revision);const peer=await open(member,revision);
 assert.equal(await peer.getByLabel('PR 评审结论',{exact:true}).locator('option[value="approve"]').count(),0);
 await pane.getByLabel('PR 评审结论',{exact:true}).selectOption('approve');await pane.getByLabel('PR 评审说明',{exact:true}).fill('已核对该固定变更及测试说明，同意此版本');await pane.getByRole('button',{name:'提交固定版本评审',exact:true}).click();await peer.getByText('已核对该固定变更及测试说明，同意此版本',{exact:true}).waitFor();
 const policy=await post(`pull-revisions/${revision}/checks-policy`,{idempotencyKey:randomUUID(),expectedVersion:0,reason:'Trust fixed build producer for protected delivery',config:{version:1,required:[{name:'build',appId:'41234'}],maxAgeSeconds:600}},ownerContext);
 const cc=await get(`pull-revisions/${revision}/checks`),checks=await post(`pull-revisions/${revision}/checks`,{idempotencyKey:randomUUID(),expectedTaskVersion:cc.taskVersion,expectedPolicyId:policy.policyId});assert.equal((await worker('pull-checks',checks.jobId)).eligible,true);
 await pane.getByRole('button',{name:'刷新评审与交付',exact:true}).click();await pane.getByLabel('PR 交付说明',{exact:true}).fill('已确认评审及 CI，请将此固定版本合并');await pane.getByRole('checkbox',{name:'确认将固定版本合并到远端默认分支；已核对变更与影响',exact:true}).check();const [mergeResponse]=await Promise.all([owner.waitForResponse(r=>r.url().endsWith(`/pull-revisions/${revision}/release`)&&r.request().method()==='POST'),pane.getByRole('button',{name:'合并到受保护分支',exact:true}).click()]);
 assert.ok(mergeResponse.ok());const result=await worker('pull-release',(await mergeResponse.json()).jobId);assert.equal(result.status,'merged');await pane.getByRole('status').filter({hasText:'GitHub 已确认合并'}).waitFor();await peer.getByRole('status').filter({hasText:'GitHub 已确认合并'}).waitFor();
 const context=await get(`pull-revisions/${revision}/release`);const csrf=await ownerContext.request.post(`${base}/api/collab/pull-revisions/${revision}/reviews`,{data:{idempotencyKey:randomUUID(),diffHash:context.diffHash,decision:'comment',body:'No origin must be denied'}});assert.equal(csrf.status(),403);
 await pane.screenshot({path:'test-results/collab/pull-release-desktop.png'});await owner.setViewportSize({width:390,height:844});assert.equal(await owner.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await pane.screenshot({path:'test-results/collab/pull-release-mobile.png'});
 console.log('PASS: two-member independent fixed review, real API readiness and merge through local GitHub protocol, CI gate, shared result and desktop/mobile UI.');
}
