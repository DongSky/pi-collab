import { chromium } from 'playwright';
import { readFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const accounts=JSON.parse(await readFile('.local/demo-accounts.json','utf8'));
// Development-only fixture: never point this smoke test at a shared production instance.
const browser=await chromium.launch({headless:true});
const contexts=[];
try {
 for (const account of accounts) {
  const context=await browser.newContext({viewport:{width:1440,height:960}});contexts.push(context);
  const page=await context.newPage();await page.goto('http://127.0.0.1:30142/sign-in');
  await page.getByLabel('邮箱',{exact:true}).fill(account.email);await page.getByLabel('密码',{exact:true}).fill(account.password);
  await page.getByRole('button',{name:'登录',exact:true}).click();await page.waitForURL('http://127.0.0.1:30142/',{timeout:30000});
  await page.getByText(account.name,{exact:true}).first().waitFor();
  const projects=await (await context.request.get('http://127.0.0.1:30142/api/collab/projects')).json();
  assert.equal(projects.projects.some(p=>p.id==='33333333-3333-4333-8333-333333333333'),account.name!=='Outsider');
  const legacy=await context.request.get('http://127.0.0.1:30142/api/sessions');assert.equal(legacy.status(),404);
  if(account.name==='Reviewer') assert.equal(await page.getByRole('button',{name:'＋ 新建任务',exact:true}).count(),0);
  console.log(account.name+': sign-in, scoped project visibility, legacy gate passed');
 }
 const alice=contexts[0].pages()[0];const stamp=Date.now();
 await alice.getByRole('button',{name:'＋ 新建任务',exact:true}).click();
 await alice.getByLabel('任务名称').fill('后端订单接口 '+stamp);await alice.getByLabel('目标与修改范围').fill('定义订单分页接口，与前端任务约定响应格式。');await alice.getByLabel('验收标准').fill('接口分页与契约测试通过。');
 await alice.getByRole('button',{name:'创建',exact:true}).click();await alice.getByRole('heading',{name:'后端订单接口 '+stamp}).waitFor();
 await contexts[1].pages()[0].getByRole('button',{name:'刷新',exact:true}).click();await contexts[1].pages()[0].getByText('后端订单接口 '+stamp,{exact:true}).waitFor();
 const bob=contexts[1].pages()[0];await bob.getByRole('button',{name:'＋ 新建任务',exact:true}).click();await bob.getByLabel('任务名称').fill('前端订单页面 '+stamp);await bob.getByLabel('目标与修改范围').fill('根据后端契约实现订单列表。');await bob.getByLabel('验收标准').fill('分页、空状态与错误状态均可用。');await bob.getByRole('button',{name:'创建',exact:true}).click();await bob.getByRole('heading',{name:'前端订单页面 '+stamp}).waitFor();
 await bob.getByLabel('添加依赖',{exact:true}).selectOption({label:'后端订单接口 '+stamp});await bob.getByRole('button',{name:'添加依赖',exact:true}).click();await bob.getByText('等待上游结果',{exact:true}).waitFor();
 await mkdir('test-results/collab',{recursive:true});
 await bob.screenshot({path:'test-results/collab/task-dependencies.png',fullPage:true});
 const unauth=await browser.newContext();const response=await unauth.request.get('http://127.0.0.1:30142/api/collab/projects');assert.equal(response.status(),401);await unauth.close();
 const privateResponse=await contexts[3].request.get('http://127.0.0.1:30142/api/collab/projects/33333333-3333-4333-8333-333333333333');assert.equal(privateResponse.status(),404);
 console.log('PASS: four independent browser sessions, shared task changes, dependency creation, reviewer restrictions, unauthenticated rejection and cross-organization IDOR denial.');
} finally {await browser.close();}
