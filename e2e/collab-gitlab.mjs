import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {randomUUID} from 'node:crypto';
export async function verifyGitLab({base,projectId,owner,member,ownerContext,memberContext}){
 const child=fork('scripts/e2e-gitlab.ts',[projectId],{execArgv:['--import','tsx'],stdio:['ignore','ignore','ignore','ipc']}),pending=new Map();
 const ready=new Promise((resolve,reject)=>{child.on('message',m=>{if(m.ready)resolve(m);else{const p=pending.get(m.id);if(p){pending.delete(m.id);if(m.error)p.reject(new Error(m.error));else p.resolve(m.result);}}});child.on('exit',()=>{reject(new Error('GitLab fixture exited'));for(const p of pending.values())p.reject(new Error('GitLab fixture exited'));});});
 const action=mode=>new Promise((resolve,reject)=>{const id=randomUUID();pending.set(id,{resolve,reject});child.send({id,mode});});
 const listing=async context=>{const response=await context.request.get(`${base}/api/collab/projects/${projectId}/gitlab`);assert.ok(response.ok());return response.json();};
 async function command(page,panel,label){const [response]=await Promise.all([page.waitForResponse(r=>r.url().endsWith(`/projects/${projectId}/gitlab`)&&r.request().method()==='POST'),panel.getByRole('button',{name:label,exact:true}).click()]);assert.ok(response.ok(),`${label}: ${response.status()}`);const queued=await response.json(),finished=await action('work');assert.equal(finished.status,'completed',label);return queued.id;}
 try{
  const connected=await ready;await owner.goto(base);await owner.locator('.collab-task-row').filter({hasText:'Owner API task'}).click();let a=owner.getByRole('region',{name:'GitLab 协作交付',exact:true});
  await a.getByLabel('GitLab 操作说明',{exact:true}).fill('导入已核对的 GitLab 团队仓库');await command(owner,a,'导入 GitLab 仓库');
  const seeded=await action('seed');for(const page of [owner,member]){await page.goto(base);await page.locator('.collab-task-row').filter({hasText:seeded.title}).click();}
  a=owner.getByRole('region',{name:'GitLab 协作交付',exact:true});const b=member.getByRole('region',{name:'GitLab 协作交付',exact:true});
  await b.getByLabel('GitLab 操作说明',{exact:true}).fill('提交已验证的固定成果供团队评审');await b.getByLabel('GitLab 成果版本',{exact:true}).selectOption(seeded.resultId);const prepare=await command(member,b,'准备 GitLab 变更预览');
  await b.getByRole('button',{name:'打开固定变更预览',exact:true}).click();const preview=b.getByRole('region',{name:'GitLab 固定变更预览',exact:true});await preview.getByText('modified · code.txt',{exact:true}).click();await preview.getByText('GitLab changed',{exact:true}).waitFor();
  await preview.getByRole('checkbox').check();await command(member,preview,'发送固定版本并创建草稿 MR');
  await a.getByLabel('GitLab 操作说明',{exact:true}).fill('独立核对代码与 CI 后完成交付');await a.getByRole('button',{name:'打开固定变更预览',exact:true}).click();const review=a.getByRole('region',{name:'GitLab 固定变更预览',exact:true});
  await review.getByLabel('GitLab 独立评审说明',{exact:true}).fill('已独立检查固定代码及验证结果，同意合并此版本。');await review.getByRole('button',{name:'批准固定版本',exact:true}).click();await a.getByText(/Browser Owner · 批准/).waitFor();
  await command(owner,a,'转为待评审 MR');await command(owner,a,'核对评审与 CI 后合并');await command(owner,a,'同步 GitLab 默认分支');assert.equal((await action('verify')).verified,true);
  const view=await listing(memberContext);assert.ok(view.operations.some(o=>o.kind==='merge'&&o.status==='completed'));assert.ok(view.reviews.some(r=>r.operation_id===prepare&&r.decision==='approve'));
  assert.equal((await fetch(`${base}/api/collab/projects/${projectId}/gitlab`)).status,401);
  const csrf=await ownerContext.request.post(`${base}/api/collab/projects/${projectId}/gitlab`,{headers:{Origin:'https://invalid.test'},data:{connectionId:connected.connectionId,command:{kind:'sync',reason:'Untrusted origin must fail',idempotencyKey:randomUUID()}}});assert.equal(csrf.status(),403);
  const denied=await memberContext.request.post(`${base}/api/collab/projects/${projectId}/gitlab`,{headers:{Origin:base},data:{connectionId:connected.connectionId,command:{kind:'sync',reason:'Developer cannot update baseline',idempotencyKey:randomUUID()}}});assert.equal(denied.status(),403);
  await review.screenshot({path:'test-results/collab/gitlab-desktop.png'});await member.setViewportSize({width:390,height:844});await preview.screenshot({path:'test-results/collab/gitlab-mobile.png'});assert.equal(await member.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  console.log('PASS: GitLab two-member import, fixed validated result, draft MR, independent review, CI-gated real Git merge, baseline sync, permissions and responsive browser flow (loopback protocol, no external GitLab writes).');
 }finally{child.disconnect();await new Promise(resolve=>child.once('exit',resolve));}
}
