import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
export async function verifyCompatibility({base,projectId,owner,member,ownerContext,memberContext}){
 const post=async(endpoint,data,context=ownerContext)=>{const r=await context.request.post(`${base}/api/collab/${endpoint}`,{headers:{Origin:base},data});assert.ok(r.ok(),`${endpoint}: ${r.status()}`);return r.json();};
 const producer=await post(`projects/${projectId}/tasks`,{title:'接口检查生产任务',description:'结构化变更检查',acceptance:'消费者看到固定版本风险'});
 const consumer=await post(`projects/${projectId}/tasks`,{title:'接口检查消费任务',description:'核对上游修改',acceptance:'风险不会自动成为批准'},memberContext);
 const repositories=await(await ownerContext.request.get(`${base}/api/collab/projects/${projectId}/repositories`)).json(),repository=repositories.repositories[0];
 const content={title:'订单契约 v1',format:'json-schema',definition:JSON.stringify({type:'object',properties:{id:{type:'integer'},status:{enum:['open','done']}},required:['id'],additionalProperties:false}),compatibility:'initial',migrationGuide:'',mockJson:null};
 const first=await post(`tasks/${producer.id}/contracts`,{repositoryId:repository.id,key:'semantic-orders',parentRevisionId:null,content,affectedTaskIds:[consumer.id],idempotencyKey:randomUUID()});
 const revision=await post(`contract-proposals/${first.proposalId}/publish`,{idempotencyKey:randomUUID(),overrideReason:'Bootstrap reviewed fixture contract for both consumers'});
 const initial=await(await ownerContext.request.get(`${base}/api/collab/tasks/${producer.id}/contracts`)).json();
 await owner.goto(base);await owner.locator('.collab-task-row').filter({hasText:producer.title}).click();const panel=owner.getByRole('region',{name:'接口契约与确认',exact:true});
 await panel.getByText('创建或修订契约提案',{exact:true}).click();await panel.getByLabel('契约修订对象',{exact:true}).selectOption(initial.contracts[0].id);
 await panel.getByLabel('契约标题',{exact:true}).fill('订单契约 v2');await panel.getByLabel('接口定义',{exact:true}).fill(JSON.stringify({type:'object',properties:{id:{type:'string'},priority:{type:'integer'}},required:['id','priority'],additionalProperties:false}));await panel.getByRole('button',{name:'提交契约提案',exact:true}).click();
 const proposal=panel.getByRole('article',{name:'契约提案 订单契约 v2',exact:true});await proposal.getByText('发现兼容风险',{exact:true}).waitFor();await proposal.getByText('新增必填字段 priority。',{exact:false}).waitFor();
 await proposal.getByRole('status').filter({hasText:'人工标注为兼容，但自动检查发现风险'}).waitFor();
 const listing=await(await ownerContext.request.get(`${base}/api/collab/tasks/${producer.id}/contracts`)).json(),report=listing.proposals[0].compatibilityReport;
 const fixed=await(await ownerContext.request.get(`${base}/api/collab/contract-revisions/${revision.revisionId}`)).json();assert.equal(report.parentHash,fixed.revision.body_hash);assert.equal(report.status,'attention');
 assert.equal((await fetch(`${base}/api/collab/tasks/${producer.id}/contracts`)).status,401);
 await member.goto(base);await member.locator('.collab-task-row').filter({hasText:consumer.title}).click();const observed=member.getByRole('article',{name:'契约提案 订单契约 v2',exact:true});await observed.getByText('发现兼容风险',{exact:true}).waitFor();
 await observed.getByLabel(`契约确认说明 ${consumer.title}`,{exact:true}).fill('新增必填字段会影响现有调用，先调整消费者再确认。');await observed.getByRole('button',{name:`拒绝契约 · ${consumer.title}`,exact:true}).click();await observed.getByText(/接口检查消费任务 · 拒绝或需重新确认/).waitFor();
 await proposal.screenshot({path:'test-results/collab/compatibility-desktop.png'});await member.setViewportSize({width:390,height:844});await observed.screenshot({path:'test-results/collab/compatibility-mobile.png'});assert.equal(await member.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 console.log('PASS: persisted parent comparison, specific schema risks, contradictory human label, both task owners, consumer rejection, authentication and responsive evidence.');
}
