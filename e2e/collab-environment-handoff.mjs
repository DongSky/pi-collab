import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
export async function verifyEnvironmentHandoff({base,projectId,ownerContext,memberContext,owner}){
 const exec=promisify(execFile),worker=async(mode,id)=>JSON.parse((await exec(process.execPath,['--import','tsx','scripts/e2e-snapshot-worker.ts',mode,...(id?[id]:[])],{timeout:60000})).stdout.trim());
 const post=async(p,data,c=memberContext)=>{const r=await c.request.post(`${base}/api/collab/${p}`,{headers:{Origin:base},data});assert.ok(r.ok(),`${p}: ${r.status()}`);return r.json();};
 const get=async(p,c=memberContext)=>{const r=await c.request.get(`${base}/api/collab/${p}`);assert.ok(r.ok());return r.json();};
 const model=JSON.parse((await exec(process.execPath,['--import','tsx','scripts/e2e-capacity-worker.ts',projectId])).stdout.trim()),repo=await worker('init-environment',projectId);
 await owner.goto(base);await owner.getByRole('button',{name:'资源与费用',exact:true}).click();const recipe=owner.getByRole('region',{name:'运行环境配方',exact:true});await recipe.getByRole('button',{name:'配置环境重建',exact:true}).click();await recipe.getByLabel('依赖安装',{exact:true}).selectOption('npm-ci');await recipe.getByLabel('配方修改说明',{exact:true}).fill('交接时自动从固定锁文件重新构建依赖');await recipe.getByRole('button',{name:'发布环境配方',exact:true}).click();await recipe.getByText('版本 1',{exact:false}).waitFor();
 const t=await post(`projects/${projectId}/tasks`,{title:'环境交接验收',description:'新成员继续固定依赖环境',acceptance:'依赖重新安装且旧工作区不变'});
 await post(`tasks/${t.id}/runs`,{repositoryId:repo.id,baseSha:repo.baseSha,modelProfileId:model.modelId,expectedVersion:t.version,prompt:'Environment fixture; no model inference',idempotencyKey:randomUUID()});const first=await worker('environment',t.id),detail=await get(`runs/${first.runId}`);
 const snapshot=await post(`runs/${first.runId}/snapshots`,{idempotencyKey:randomUUID(),expectedRevision:detail.run.revision,note:'固定 npm 依赖与运行时，交给下一位成员重建'});await worker('capture');
 await post(`projects/${projectId}/environment-recipe`,{install:'none',expectedVersion:1,reason:'新默认配方不会改写此前交接版本'},ownerContext);
 const me=await get('me',ownerContext),task=(await get(`projects/${projectId}`)).tasks.find(x=>x.id===t.id);const assigned=await ownerContext.request.patch(`${base}/api/collab/tasks/${t.id}/owner`,{headers:{Origin:base},data:{ownerId:me.user.id,expectedVersion:task.version}});assert.ok(assigned.ok());
 await owner.goto(base);await owner.locator('.collab-task-row').filter({hasText:t.title}).click();const snapshots=owner.getByRole('region',{name:'任务交接快照',exact:true});await snapshots.getByText('环境交接与重建',{exact:true}).click();await snapshots.getByText('配方版本 1',{exact:false}).waitFor();await snapshots.getByRole('button',{name:'选择此交接环境，准备新运行',exact:true}).click();assert.equal(await owner.getByLabel('恢复来源',{exact:true}).inputValue(),snapshot.snapshotId);
 const [response]=await Promise.all([owner.waitForResponse(r=>r.url().endsWith(`/tasks/${t.id}/runs`)&&r.request().method()==='POST'),owner.getByRole('button',{name:'启动 AI',exact:true}).click()]);assert.ok(response.ok());
 const second=await worker('environment',t.id);assert.notEqual(first.workspaceId,second.workspaceId);const handoff=await get(`runs/${second.runId}/environment`,ownerContext);assert.equal(handoff.environment.status,'ready');assert.equal(handoff.environment.recipe.install,'npm-ci');assert.equal(handoff.environment.recipe.version,1);assert.equal(handoff.environment.recipe.sourceRunId,first.runId);
 await snapshots.screenshot({path:'test-results/collab/environment-handoff-desktop.png'});await owner.setViewportSize({width:390,height:844});assert.equal(await owner.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await snapshots.screenshot({path:'test-results/collab/environment-handoff-mobile.png'});
 console.log('PASS: published npm environment recipe, actual Pi dependency installation, fixed snapshot handoff to another owner, UI-selected fresh restoration preserving the original recipe.');
}
