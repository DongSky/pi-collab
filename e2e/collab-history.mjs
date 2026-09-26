import assert from 'node:assert/strict';
import {verifyHistoryArchives} from './collab-history-archives.mjs';
export async function verifyHistory({base,projectId,ownerContext,memberContext,owner,member}){
 await owner.goto(base);await owner.getByRole('button',{name:'个人历史',exact:true}).click();const pane=owner.getByRole('region',{name:'个人历史导入'});
 const data=[{type:'session',id:'fixture-private-id',cwd:'/private/do-not-upload'}, {type:'message',message:{role:'user',content:'Selected legacy question'}},{type:'message',message:{role:'assistant',content:[{type:'text',text:'Selected legacy answer'},{type:'thinking',thinking:'private thought'}]}},{type:'message',message:{role:'toolResult',content:'private tool output'}}].map(v=>JSON.stringify(v)).join('\n');
 await pane.getByLabel('选择 Pi 会话文件',{exact:true}).setInputFiles({name:'history.jsonl',mimeType:'application/jsonl',buffer:Buffer.from(data)});
 await pane.getByText('共 2 条候选消息',{exact:false}).waitFor();await pane.locator('summary').first().click();await pane.getByLabel('导入此条',{exact:true}).first().check();
 await pane.getByLabel('历史消息 1',{exact:true}).fill('Reviewed legacy question');await pane.getByRole('checkbox',{name:'我已核对所选文字',exact:false}).check();
 const submitted=owner.waitForRequest(r=>r.method()==='POST'&&r.url()===`${base}/api/collab/projects/${projectId}/history`);
 await pane.getByRole('button',{name:'导入所选文字',exact:true}).click();const body=(await submitted).postDataJSON();assert.deepEqual(body.messages,[{role:'user',text:'Reviewed legacy question'}]);assert.equal(JSON.stringify(body).includes('private'),false);
 await pane.getByRole('status').filter({hasText:'已导入'}).waitFor();let listing=await memberContext.request.get(`${base}/api/collab/projects/${projectId}/history`);assert.equal((await listing.json()).histories.length,0);
 const shared=await ownerContext.request.post(`${base}/api/collab/projects/${projectId}/history`,{headers:{Origin:base},data:{...body,title:'Shared reviewed history',shared:true}});assert.equal(shared.status(),200);const id=(await shared.json()).id;
 await member.goto(base);await member.getByRole('button',{name:'个人历史',exact:true}).click();await member.getByRole('button',{name:'Shared reviewed history',exact:true}).click();await member.getByText('Reviewed legacy question',{exact:true}).waitFor();assert.equal(await member.getByRole('button',{name:'删除导入记录',exact:true}).count(),0);
 assert.equal((await memberContext.request.delete(`${base}/api/collab/projects/${projectId}/history/${id}`,{headers:{Origin:base},data:{}})).status(),404);
 await pane.screenshot({path:'test-results/collab/history-desktop.png'});await owner.setViewportSize({width:390,height:844});assert.equal(await owner.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await pane.screenshot({path:'test-results/collab/history-mobile.png'});
 assert.equal((await ownerContext.request.delete(`${base}/api/collab/projects/${projectId}/history/${id}`,{headers:{Origin:base},data:{}})).status(),200);
 listing=await memberContext.request.get(`${base}/api/collab/projects/${projectId}/history`);assert.equal((await listing.json()).histories.length,0);
 await verifyHistoryArchives({base,projectId,ownerContext,memberContext,owner,member});
 console.log('PASS: selected browser-only history preview, editing, private import, explicit project share, member read and owner-only deletion.');
}
