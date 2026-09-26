import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile),evidencePrefix=process.env.PI_COLLAB_RUNTIME==='docker'?'container-terminal':'shared-terminal';
export async function verifySharedTerminal({base,projectId,ownerContext,memberContext,owner,member}){
 for(const page of [owner,member])page.on('pageerror',e=>console.error('Terminal browser:',e.message));
 const worker=async(mode,id)=>JSON.parse((await exec(process.execPath,['--import','tsx','scripts/e2e-snapshot-worker.ts',mode,...(id?[id]:[])],{timeout:60000})).stdout.trim());
 const post=async(p,data,c=memberContext)=>{const r=await c.request.post(`${base}/api/collab/${p}`,{headers:{Origin:base},data});assert.ok(r.ok(),`${p}: HTTP ${r.status()}`);return r.json();};
 const get=async(p,c=memberContext)=>{const r=await c.request.get(`${base}/api/collab/${p}`);assert.ok(r.ok());return r.json();};
 const repo=await worker('init',projectId),task=await post(`projects/${projectId}/tasks`,{title:'共享人工终端验收',description:'两人依次控制同一终端',acceptance:'目录状态和输出保留'});
 for(const page of [owner,member]){await page.goto(base);await page.locator('.collab-task-row').filter({hasText:task.title}).click();}
 await member.getByLabel('运行方式',{exact:true}).selectOption('terminal');await member.getByLabel('运行仓库',{exact:true}).selectOption(repo.id);
 const [response]=await Promise.all([member.waitForResponse(r=>r.url().endsWith(`/tasks/${task.id}/runs`)&&r.request().method()==='POST'),member.getByRole('button',{name:'打开共享终端',exact:true}).click()]);assert.ok(response.ok());const accepted=await response.json();
 const child=spawn(process.execPath,['--import','tsx','scripts/e2e-snapshot-worker.ts','terminal',task.id],{stdio:['ignore','pipe','pipe']});let output='',error='';child.stdout.on('data',b=>{output+=b;});child.stderr.on('data',b=>{error+=b;});const stopped=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('Terminal fixture failed: '+error.slice(-1000))));});void stopped.catch(()=>{});
 try{
  const a=owner.getByRole('region',{name:'共享人工终端',exact:true}),b=member.getByRole('region',{name:'共享人工终端',exact:true});
  await b.getByRole('status').filter({hasText:'你拥有输入权'}).waitFor();await a.getByRole('status').filter({hasText:'旁观模式'}).waitFor();
  await b.getByLabel('终端命令',{exact:true}).fill("mkdir session-dir; cd session-dir; printf 'ALPHA_BROWSER\\n' > output.txt; cat output.txt");await b.getByRole('button',{name:'发送终端命令',exact:true}).click();
  for(const panel of [a,b]){await panel.getByLabel('共享终端屏幕',{exact:true}).scrollIntoViewIfNeeded();await panel.locator('.xterm-accessibility-tree').filter({hasText:'ALPHA_BROWSER'}).waitFor({state:'attached'});}
  const originalHeight=await b.getByLabel('本窗口高度',{exact:true}).inputValue();await a.getByLabel('本窗口高度',{exact:true}).selectOption('480');assert.equal(await b.getByLabel('本窗口高度',{exact:true}).inputValue(),originalHeight);
  const ownerControl=owner.getByRole('region',{name:'会话控制与交接',exact:true}),memberControl=member.getByRole('region',{name:'会话控制与交接',exact:true});
  await ownerControl.getByLabel('接管申请说明',{exact:true}).fill('接手共享终端继续检查当前文件和目录');await ownerControl.getByRole('button',{name:'申请控制权',exact:true}).click();
  await memberControl.getByLabel('处理 Browser Owner 的申请说明',{exact:true}).fill('同意接管，保留当前终端及工作目录');await memberControl.getByRole('button',{name:'同意交接',exact:true}).click();
  await a.getByRole('status').filter({hasText:'你拥有输入权'}).waitFor();await b.getByRole('status').filter({hasText:'旁观模式'}).waitFor();
  await a.getByLabel('共享列数',{exact:true}).fill('90');await a.getByLabel('共享行数',{exact:true}).fill('25');await a.getByRole('button',{name:'应用终端尺寸',exact:true}).click();
  await a.getByLabel('直接键盘输入（点击终端后输入）',{exact:true}).check();await a.locator('.xterm-helper-textarea').focus();await owner.keyboard.type("printf 'BETA_BROWSER\\n' >> output.txt; cat output.txt");await owner.keyboard.press('Enter');
  for(const panel of [a,b]){await panel.getByLabel('共享终端屏幕',{exact:true}).scrollIntoViewIfNeeded();await panel.locator('.xterm-accessibility-tree').filter({hasText:'BETA_BROWSER'}).waitFor({state:'attached'});}
  const denied=await memberContext.request.post(`${base}/api/collab/runs/${accepted.runId}/terminal`,{headers:{Origin:base},data:{expectedVersion:'1',idempotencyKey:crypto.randomUUID(),command:{type:'input',data:'echo SHOULD_NOT_RUN\r'}}});assert.equal(denied.status(),403);
  await a.screenshot({path:`test-results/collab/${evidencePrefix}-desktop.png`});await owner.setViewportSize({width:390,height:844});assert.equal(await owner.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await a.screenshot({path:`test-results/collab/${evidencePrefix}-mobile.png`});
  await a.getByLabel('终端命令',{exact:true}).fill('exit');await a.getByRole('button',{name:'发送终端命令',exact:true}).click();await stopped;
  const result=JSON.parse(output.trim());assert.equal(result.runId,accepted.runId);assert.equal(result.outcome,'completed');
  const run=await get(`runs/${accepted.runId}`,ownerContext);assert.equal(run.run.execution_kind,'terminal');
  console.log('PASS: real shared PTY, two browser outputs, command and direct keyboard modes, independent view dimensions, control transfer, stale input rejection and confirmed exit.');
 }catch(e){
  await member.screenshot({path:'test-results/collab/shared-terminal-failure.png',fullPage:true});
  const control=await get(`runs/${accepted.runId}/control`,ownerContext);console.log('Terminal input status',control.run.status,control.instructions.map(i=>i.status));
  const transcript=await get(`runs/${accepted.runId}/events`,ownerContext);console.log('Terminal output event types',transcript.batches.flatMap(b=>b.payload.events.map(e=>e.type)));
  throw e;
 }finally{if(child.exitCode===null){await post(`runs/${accepted.runId}/stop`,{idempotencyKey:crypto.randomUUID(),controlVersion:(await get(`runs/${accepted.runId}/control`,ownerContext)).run.control.version},ownerContext).catch(()=>{});await stopped.catch(()=>{});}}
}
