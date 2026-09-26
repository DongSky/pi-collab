import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
export async function verifyEditor({base,projectId,ownerContext,memberContext,owner,member}){
 for(const page of [owner,member])page.on('pageerror',e=>console.error('Editor browser error:',e.message));
 const worker=async(mode,id)=>JSON.parse((await exec(process.execPath,['--import','tsx','scripts/e2e-snapshot-worker.ts',mode,...(id?[id]:[])],{timeout:60000})).stdout.trim());
 const post=async(p,data,c=memberContext)=>{const r=await c.request.post(`${base}/api/collab/${p}`,{headers:{Origin:base},data});assert.ok(r.ok(),`${p}: HTTP ${r.status()}`);return r.json();};
 const get=async(p,c=memberContext)=>{const r=await c.request.get(`${base}/api/collab/${p}`);assert.ok(r.ok());return r.json();};
 const model=JSON.parse((await exec(process.execPath,['--import','tsx','scripts/e2e-capacity-worker.ts',projectId])).stdout.trim()),repo=await worker('init',projectId);
 const task=await post(`projects/${projectId}/tasks`,{title:'双人实时共编验收',description:'人工共编后冻结交给 AI',acceptance:'并发文字保留且新工作区接续'});
 await post(`tasks/${task.id}/runs`,{repositoryId:repo.id,baseSha:repo.baseSha,modelProfileId:model.modelId,expectedVersion:task.version,prompt:'Prepare collaborative draft',idempotencyKey:randomUUID()});const first=await worker('run',task.id),run=await get(`runs/${first.runId}`);
 const snapshot=await post(`runs/${first.runId}/snapshots`,{expectedRevision:run.run.revision,note:'人工共编起点',idempotencyKey:randomUUID()});await worker('capture');
 for(const page of [owner,member]){await page.goto(base);await page.locator('.collab-task-row').filter({hasText:task.title}).click();}
 const a=owner.getByRole('region',{name:'实时共编',exact:true}),b=member.getByRole('region',{name:'实时共编',exact:true});
 await b.getByLabel('共编来源快照',{exact:true}).selectOption(snapshot.snapshotId);await b.getByRole('button',{name:'打开共编草稿',exact:true}).click();
 await b.getByLabel('共编文件',{exact:true}).selectOption('code.txt');await b.locator('.cm-content').waitFor();
 await a.getByLabel('共编文件',{exact:true}).selectOption('code.txt');await a.locator('.cm-content').waitFor();
 // Independent browser sessions type into the same CRDT without replacing the full document.
 await Promise.all([a.locator('.cm-content').click(),b.locator('.cm-content').click()]);
 await Promise.all([owner.keyboard.press('Control+Home'),member.keyboard.press('Control+Home')]);
 await Promise.all([owner.keyboard.insertText('Alice\n'),member.keyboard.insertText('Bob\n')]);
 for(const panel of [a,b]){await panel.locator('.cm-content').filter({hasText:'Alice'}).waitFor();await panel.locator('.cm-content').filter({hasText:'Bob'}).waitFor();}
 await a.locator('.cm-ySelectionCaret').waitFor();await b.getByText('已同步 · 多人共编',{exact:true}).waitFor();
 // Close a separate tab with blocked document writes, then explicitly recover.
 const offline=await memberContext.newPage();await offline.goto(base);await offline.locator('.collab-task-row').filter({hasText:task.title}).click();
 const c=offline.getByRole('region',{name:'实时共编',exact:true});await c.getByLabel('共编文件',{exact:true}).selectOption('code.txt');await c.locator('.cm-content').waitFor();
 await offline.route('**/api/collab/editors/*/documents',route=>route.request().method()==='PUT'?route.abort():route.continue());
 await c.locator('.cm-content').click();await offline.keyboard.press('Control+Home');await offline.keyboard.insertText('Recovered after close\n');
 assert.ok(await offline.evaluate(()=>Object.keys(localStorage).some(k=>k.startsWith('pi-collab:editor-draft:v1:')&&localStorage.getItem(k).includes('Recovered after close'))));
 await offline.close();await member.reload();await member.locator('.collab-task-row').filter({hasText:task.title}).click();await b.getByLabel('共编文件',{exact:true}).selectOption('code.txt');
 await b.getByRole('button',{name:'恢复未同步草稿',exact:true}).waitFor();assert.equal((await b.locator('.cm-content').innerText()).includes('Recovered after close'),false);
 await b.getByRole('button',{name:'恢复未同步草稿',exact:true}).click();await b.getByText('已同步 · 多人共编',{exact:true}).waitFor();await a.locator('.cm-content').filter({hasText:'Recovered after close'}).waitFor();
 assert.equal(await member.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('pi-collab:editor-draft:v1:')).length),0);
 await b.getByLabel('版本 / 交接说明',{exact:true}).fill('双人编辑保留，交给 AI 继续');await b.getByRole('button',{name:'保存版本',exact:true}).click();await b.getByRole('button',{name:'导出版本',exact:true}).waitFor();
 const late=await memberContext.newPage();await late.goto(base);await late.locator('.collab-task-row').filter({hasText:task.title}).click();
 const latePanel=late.getByRole('region',{name:'实时共编',exact:true});await latePanel.getByLabel('共编文件',{exact:true}).selectOption('code.txt');await latePanel.locator('.cm-content').waitFor();
 await late.route('**/api/collab/editors/*/documents',route=>route.request().method()==='PUT'?route.abort():route.continue());await latePanel.locator('.cm-content').click();await late.keyboard.insertText('Frozen unsent text');assert.ok(await late.evaluate(()=>Object.keys(localStorage).some(k=>k.startsWith('pi-collab:editor-draft:v1:')&&localStorage.getItem(k).includes('Frozen unsent text'))));await late.close();
 await b.getByLabel('版本 / 交接说明',{exact:true}).fill('已核对两人的编辑，冻结当前内容');await b.getByRole('button',{name:'冻结并选择交给 AI',exact:true}).click();await member.getByText(/已选择共编冻结版本/).waitFor();
 const session=(await get(`tasks/${task.id}/editor`)).sessions[0];assert.equal(session.state,'frozen');
 const frozen=await memberContext.newPage();await frozen.goto(base);await frozen.locator('.collab-task-row').filter({hasText:task.title}).click();
 const frozenPanel=frozen.getByRole('region',{name:'实时共编',exact:true});await frozenPanel.getByLabel('共编文件',{exact:true}).selectOption('code.txt');await frozenPanel.getByRole('button',{name:'恢复未同步草稿',exact:true}).waitFor();assert.equal(await frozenPanel.getByRole('button',{name:'恢复未同步草稿',exact:true}).isDisabled(),true);
 assert.equal((await frozenPanel.locator('.cm-content').innerText()).includes('Frozen unsent text'),false);
 const downloaded=frozen.waitForEvent('download');await frozenPanel.getByRole('button',{name:'导出未同步草稿',exact:true}).click();const stream=await (await downloaded).createReadStream();let exported='';for await(const chunk of stream)exported+=chunk.toString();assert.ok(exported.includes('Frozen unsent text'));
 await frozenPanel.getByRole('button',{name:'丢弃未同步草稿',exact:true}).click();await frozenPanel.getByRole('region',{name:'未同步草稿恢复'}).waitFor({state:'hidden'});await frozen.close();

 const blocked=await memberContext.request.post(`${base}/api/collab/tasks/${task.id}/runs`,{headers:{Origin:base},data:{repositoryId:repo.id,baseSha:repo.baseSha,prompt:'Old window cannot skip handoff',expectedVersion:(await get(`projects/${projectId}`)).tasks.find(t=>t.id===task.id).version,idempotencyKey:randomUUID()}});assert.equal(blocked.status(),409);
 await b.screenshot({path:'test-results/collab/editor-desktop.png'});await member.setViewportSize({width:390,height:844});assert.equal(await member.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await b.screenshot({path:'test-results/collab/editor-mobile.png'});
 await member.getByLabel('运行模型',{exact:true}).selectOption(model.modelId);
 const [response]=await Promise.all([member.waitForResponse(r=>r.url().endsWith(`/tasks/${task.id}/runs`)&&r.request().method()==='POST'),member.getByRole('button',{name:'启动 AI',exact:true}).click()]);assert.ok(response.ok());const second=await worker('editor',task.id);assert.notEqual(second.workspaceId,first.workspaceId);
 assert.equal((await get(`editors/${session.id}`,ownerContext)).session.state,'handed_off');
 console.log('PASS: two browser CodeMirror edits, named remote cursor, close/reopen unsent draft recovery, persistent checkpoint, freeze, old-run guard and actual Pi fresh workspace handoff without inference.');
}
