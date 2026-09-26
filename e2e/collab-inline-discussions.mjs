import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
export async function verifyInlineThread({base,ownerContext,memberContext,owner,ownerCode,memberCode,kind,sourceId,reopenOwner}){
 const context=await(await memberContext.request.get(`${base}/api/collab/review-discussions?kind=${kind}&sourceId=${sourceId}`)).json();
 for(const panel of [ownerCode,memberCode])await panel.getByRole('button',{name:'评论新侧第 1 行',exact:true}).click();
 const a=ownerCode.getByRole('region',{name:'固定差异行内讨论',exact:true}),b=memberCode.getByRole('region',{name:'固定差异行内讨论',exact:true});
 await a.locator('summary').filter({hasText:/^发起讨论$/}).click();
 const title=`固定${kind}代码评论`;
 await a.getByLabel('讨论标题',{exact:true}).fill(title);await a.getByLabel('讨论内容',{exact:true}).fill('请核对这个固定版本的新侧第一行');await a.getByLabel('提及成员',{exact:true}).first().selectOption(context.userId);
 if(reopenOwner){await owner.reload();await reopenOwner();await ownerCode.getByRole('button',{name:'评论新侧第 1 行',exact:true}).click();await a.locator('summary').filter({hasText:/^发起讨论$/}).click();assert.equal(await a.getByLabel('讨论标题',{exact:true}).inputValue(),title);assert.equal(await a.getByLabel('讨论内容',{exact:true}).inputValue(),'请核对这个固定版本的新侧第一行');}
 await a.getByRole('button',{name:'发布讨论',exact:true}).click();await a.getByRole('article',{name:`讨论 ${title}`,exact:true}).waitFor();
 await b.getByRole('button',{name:`待讨论 · ${title}`,exact:true}).click();await b.getByLabel('讨论回复',{exact:true}).fill('已核对原行，后续版本不能复用这条评论位置');await b.getByRole('button',{name:'发布回复',exact:true}).click();await a.getByText('已核对原行，后续版本不能复用这条评论位置',{exact:true}).waitFor();
 const inbox=await(await memberContext.request.get(`${base}/api/collab/inbox`)).json();assert.ok(inbox.items.some(n=>n.kind==='mention'&&n.thread_id));
 const fixed=await a.getByRole('link',{name:'核对评论的固定代码',exact:true}).getAttribute('href');const source=await ownerContext.request.get(base+fixed);assert.equal(source.status(),200);assert.equal((await source.json()).anchor.sourceId,sourceId);
 await a.screenshot({path:`test-results/collab/inline-${kind}-desktop.png`});await owner.setViewportSize({width:390,height:844});assert.equal(await owner.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await a.screenshot({path:`test-results/collab/inline-${kind}-mobile.png`});await owner.setViewportSize({width:1440,height:1000});
 await a.getByRole('button',{name:'标记讨论已解决',exact:true}).click();await b.getByRole('button',{name:`已解决 · ${title}`,exact:true}).waitFor();
 console.log(`PASS: ${kind} fixed-line discussion, two-member reply/resolve, mention, exact source link and desktop/mobile layout.`);
}
export async function verifyInlineIntegration({base,projectId,ownerContext,memberContext,owner,member}){
 const headers={Origin:base};
 const worker=async(mode,...args)=>JSON.parse((await exec(process.execPath,['--import','tsx','scripts/e2e-integration-worker.ts',mode,...args],{timeout:60000})).stdout.trim());
 const repo=JSON.parse((await exec(process.execPath,['--import','tsx','scripts/e2e-snapshot-worker.ts','init',projectId],{timeout:60000})).stdout.trim());
 const post=async(path,data)=>{const r=await ownerContext.request.post(`${base}/api/collab/${path}`,{headers,data});assert.ok(r.ok(),`${path}: ${r.status()}`);return r.json();};
 const task=await post(`projects/${projectId}/tasks`,{title:'整合行内讨论验收',description:'固定组合代码评论',acceptance:'双成员可核对来源'});
 const result=await worker('publish',task.id,repo.id,'collab-alpha.txt','alpha');
 const profile=await post(`projects/${projectId}/validation-profiles`,{repositoryId:repo.id,name:'Inline source check',config:{version:1,steps:[{tool:'node',args:['-e','process.exit(0)'],timeoutSeconds:10}]},idempotencyKey:randomUUID()});
 const queued=await post(`projects/${projectId}/integrations`,{repositoryId:repo.id,targetSha:repo.baseSha,resultIds:[result.resultId],profileId:profile.profileId,idempotencyKey:randomUUID()});assert.equal((await worker('integrate',queued.integrationId)).outcome,'checked');
 async function open(page){await page.goto(base);await page.locator('.collab-task-row').filter({hasText:task.title}).click();const card=page.getByRole('article',{name:`整合 ${queued.integrationId}`,exact:true});await card.locator('summary').filter({hasText:'查看固定代码差异与冲突'}).click();await card.getByRole('button',{name:'读取代码文件列表',exact:true}).click();await card.getByRole('button',{name:'新增 · collab-alpha.txt',exact:true}).click();return card;}
 const ownerCode=await open(owner),memberCode=await open(member);
 await verifyInlineThread({base,ownerContext,memberContext,owner,member,ownerCode,memberCode,kind:'integration',sourceId:queued.integrationId,reopenOwner:()=>open(owner)});
}
