import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
export async function verifyServicePreviews({base,taskId,validationId,owner,member,ownerContext,memberContext}) {
 const daemon=spawn(process.execPath,['--import','tsx','scripts/e2e-service-worker.ts'],{env:process.env,stdio:['ignore','ignore','inherit']}),exited=new Promise(resolve=>daemon.once('exit',resolve));
 try {
  await owner.setViewportSize({width:1440,height:1000});await member.setViewportSize({width:1440,height:1000});
  const a=owner.getByRole('region',{name:'动态服务预览',exact:true}),b=member.getByRole('region',{name:'动态服务预览',exact:true});
  await b.getByText('启动动态预览',{exact:true}).click();await b.getByLabel('动态预览来源',{exact:true}).selectOption(validationId);await b.getByLabel('动态预览名称',{exact:true}).fill('团队动态服务');await b.getByLabel('安装依赖',{exact:true}).selectOption('npm-ci');
  await b.getByLabel('构建步骤（JSON 数组，可留空）',{exact:true}).fill(JSON.stringify([{tool:'node',args:['-e',"require('node:fs').writeFileSync('build-proof.txt','built')"],timeoutSeconds:10}]));await b.getByLabel('启动参数（JSON 数组）',{exact:true}).fill('["server.cjs"]');await b.getByRole('checkbox',{name:'确认执行此快照中的安装',exact:false}).check();
  await b.getByRole('button',{name:'创建动态服务预览',exact:true}).click();await b.getByRole('article',{name:'动态预览 团队动态服务',exact:true}).getByRole('heading').filter({hasText:'运行中'}).waitFor({timeout:60000});
  await b.getByRole('button',{name:'打开动态预览',exact:true}).click();const bm=member.frameLocator('iframe[title="动态服务沙箱预览"]');await bm.getByRole('heading',{name:'固定快照动态服务',exact:true}).waitFor();await bm.getByText('Cookie 已隔离',{exact:true}).waitFor();await bm.getByRole('button',{name:'调用后端计数',exact:true}).click();await bm.getByText('服务计数 1',{exact:true}).waitFor();
  await a.getByRole('button',{name:'打开动态预览',exact:true}).click();const am=owner.frameLocator('iframe[title="动态服务沙箱预览"]');await am.getByRole('button',{name:'调用后端计数',exact:true}).click();await am.getByText('服务计数 2',{exact:true}).waitFor();
  const url=await a.locator('iframe').getAttribute('src'),list=await(await ownerContext.request.get(`${base}/api/collab/tasks/${taskId}/service-previews`)).json(),p=list.previews[0];assert.notEqual(new URL(url).origin,base);assert.equal(p.runtime,process.env.PI_COLLAB_RUNTIME==='docker'?'docker':'native');
  assert.equal((await ownerContext.request.post(`${base}/api/collab/service-previews/${p.id}`,{data:{}})).status(),403);
  const prefix=process.env.PI_COLLAB_RUNTIME==='docker'?'container-service':'service';await a.screenshot({path:`test-results/collab/${prefix}-desktop.png`});await member.setViewportSize({width:390,height:844});assert.equal(await member.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await b.screenshot({path:`test-results/collab/${prefix}-mobile.png`});
  await a.getByLabel('停止动态预览说明',{exact:true}).fill('团队已经完成动态接口检查，停止临时服务并回收');await a.getByRole('button',{name:'停止动态预览',exact:true}).click();await b.getByText('进程退出已确认，临时副本已回收。',{exact:true}).waitFor({timeout:30000});await b.locator('iframe').waitFor({state:'detached'});assert.equal((await fetch(url)).status,404);
  const done=await(await memberContext.request.get(`${base}/api/collab/tasks/${taskId}/service-previews`)).json();assert.ok(done.logs.some(l=>l.path==='/api'&&l.method==='POST'&&l.code===200));assert.equal(done.previews[0].status,'stopped');
  console.log('PASS: actual executor starts install/build/service from fixed snapshot, two members call dynamic backend, sandbox and CSRF hold, maintainer stop confirms exit and reclaims copy.');
 } finally {daemon.kill('SIGTERM');await exited;}
}
