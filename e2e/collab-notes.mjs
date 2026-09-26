import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
export async function verifyNotesUi({base,producer,consumer,ownerContext,memberContext,owner,member,admin}) {
 const headers={Origin:base},panel=owner.getByRole('region',{name:'任务协作说明',exact:true}),observer=member.getByRole('region',{name:'任务协作说明',exact:true});
 await observer.getByText('协作工具协议诊断记录：已读取固定契约。',{exact:true}).waitFor();await observer.getByText(/AI 提交 · 运行/).waitFor();
 const body='<script>globalThis.collabNoteInjected=true</script> 请核对订单接口；此说明不授予权限。';
 const input={targetTaskId:consumer.id,kind:'question',body,resultIds:[],revisionIds:[],idempotencyKey:randomUUID()};
 assert.equal((await memberContext.request.post(`${base}/api/collab/tasks/${producer.id}/notes`,{headers,data:input})).status(),403);
 assert.equal((await ownerContext.request.post(`${base}/api/collab/tasks/${producer.id}/notes`,{headers:{Origin:'https://untrusted.invalid'},data:input})).status(),403);
 let lost=true;await owner.route(`**/api/collab/tasks/${producer.id}/notes`,async route=>{if(route.request().method()==='POST'&&lost){lost=false;const response=await route.fetch();assert.equal(response.status(),201);await route.abort('failed');}else await route.continue();});
 await panel.getByLabel('协作说明目标任务',{exact:true}).selectOption(consumer.id);await panel.getByLabel('协作说明内容',{exact:true}).fill(body);await panel.getByRole('button',{name:'提交协作说明',exact:true}).click();await panel.getByRole('button',{name:'重试同一协作说明',exact:true}).click();
 await panel.getByRole('status').filter({hasText:'协作说明已保存'}).waitFor();await observer.getByText(body,{exact:true}).waitFor();assert.equal(await member.evaluate(()=>globalThis.collabNoteInjected),undefined);
 assert.equal((await admin.query('SELECT count(*)::int AS n FROM collab.coordination_notes WHERE source_task_id=$1 AND body=$2',[producer.id,body])).rows[0].n,1);
 await observer.getByLabel('协作说明目标任务',{exact:true}).selectOption(producer.id);await observer.getByLabel('协作说明类型',{exact:true}).selectOption('handoff');await observer.getByLabel('协作说明内容',{exact:true}).fill('已看到 v2 迁移要求，将在新运行中按固定版本重新验证。');await observer.getByRole('button',{name:'提交协作说明',exact:true}).click();
 await panel.getByText('已看到 v2 迁移要求，将在新运行中按固定版本重新验证。',{exact:true}).waitFor();
 await member.reload();await member.getByRole('button').filter({hasText:'契约消费任务'}).click();
 const replay=member.getByRole('region',{name:'任务协作说明',exact:true});await replay.getByText(body,{exact:true}).waitFor();await replay.getByText('协作工具协议诊断记录：已读取固定契约。',{exact:true}).waitFor();
 await replay.screenshot({path:'test-results/collab/coordination-notes.png'});await member.setViewportSize({width:390,height:844});await replay.screenshot({path:'test-results/collab/coordination-notes-mobile.png'});assert.ok(await member.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));await member.setViewportSize({width:1440,height:1000});
 console.log('PASS: cross-browser scoped notes, attribution, immutable references, lost-response retry, literal untrusted content, refresh replay, authorization/CSRF and responsive layouts (agent-note protocol fixture).');
}
