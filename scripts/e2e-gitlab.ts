import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {Pool} from 'pg';
import {localConfig,applicationEnvironment,connectionString,gitConnectionString,executorConnectionString} from './local-config';
import {database} from '../lib/collab/database';
import {gitlabFixture} from '../tests/collab/fixtures/gitlab';
import {registerGitLab} from '../lib/collab/gitlab/registration';
import {processGitLab} from '../lib/collab/gitlab/worker';
import {createTask} from '../lib/collab/tasks';
import {startRun,runDetail} from '../lib/collab/runs';
import {ExecutionStore} from '../lib/collab/execution-store';
import {executeClaim} from '../lib/collab/executor';
import {NativeRuntimeBackend} from '../lib/collab/runtime/backends';
import {requestSnapshot,processSnapshots} from '../lib/collab/snapshots';
import {createValidationProfile,requestValidation} from '../lib/collab/validations';
import {executeValidation} from '../lib/collab/validation-worker';
import {publishResult} from '../lib/collab/task-results';
const name=process.env.PI_COLLAB_E2E_DATABASE??'',root=process.env.PI_COLLAB_E2E_DATA??'',project=process.argv[2];
if(!/^pi_collab_test_[a-f0-9]+$/.test(name)||!path.basename(root).startsWith('identity-e2e-')||!process.send)throw new Error('Isolated IPC fixture required');
const config=await localConfig();Object.assign(process.env,applicationEnvironment(config),{DATABASE_URL:connectionString(config,false,name),PI_COLLAB_DATA_DIR:root});
const admin=new Pool({connectionString:connectionString(config,true,name)}),broker=new Pool({connectionString:gitConnectionString(config,name)}),store=new ExecutionStore(executorConnectionString(config,name)),key=randomBytes(32),fixture=await gitlabFixture(root);
const actor=(await admin.query('SELECT created_by FROM collab.projects WHERE id=$1',[project])).rows[0].created_by,member=(await admin.query(`SELECT user_id FROM collab.project_memberships WHERE project_id=$1 AND role='developer' AND active`,[project])).rows[0].user_id;
const connection=await registerGitLab(admin,key,{projectId:project,actorId:actor,origin:fixture.origin,remoteId:'101',name:'浏览器 GitLab 仓库',reason:'Connect isolated GitLab browser protocol fixture'},fixture.token);
process.send!({ready:true,connectionId:connection.id});
let queue=Promise.resolve();
async function seed(){
 const repository=(await admin.query('SELECT repository_id FROM collab.gitlab_connections WHERE id=$1',[connection.id])).rows[0].repository_id;
 assert.ok(repository);const task=await createTask(member,project,{title:'GitLab 双成员交付',description:'固定成果与独立评审',acceptance:'真实 Git 合并并同步新基线'}),executor=randomUUID();
 await startRun(member,task.id,{repositoryId:repository,baseSha:await fixture.head(),prompt:'No inference fixture',expectedVersion:task.version,idempotencyKey:randomUUID()});const claim=(await store.claim(executor,'native'))!;
 assert.equal(claim.run.task_id,task.id);assert.equal(await executeClaim(store,executor,claim,{dataRoot:root,backend:new NativeRuntimeBackend(),driver:async(agent,_claim,ws)=>{
  await writeFile(path.join(ws.checkout,'code.txt'),'GitLab changed\n');await writeFile(path.join(ws.checkout,'check.cjs'),"require('node:assert/strict').equal(require('node:fs').readFileSync('code.txt','utf8'),'GitLab changed\\n');\n");await agent.peer.command('bash',{command:'node check.cjs'});return{modelInference:false};
 }}),'completed');
 const run=(await runDetail(member,claim.run.id)).run,snapshot=await requestSnapshot(member,run.id,{expectedRevision:run.revision,note:'Browser GitLab fixed result',idempotencyKey:randomUUID()});await processSnapshots(store,root);
 const profile=await createValidationProfile(actor,project,{repositoryId:repository,name:'GitLab browser code check',idempotencyKey:randomUUID(),config:{version:1,steps:[{tool:'node',args:['check.cjs'],timeoutSeconds:10}]}}),validation=await requestValidation(member,snapshot.snapshotId,{profileId:profile.profileId,idempotencyKey:randomUUID()});assert.equal(await executeValidation(store,(await store.claimValidation(executor))!,root),'passed');
 const version=(await admin.query('SELECT version FROM collab.tasks WHERE id=$1',[task.id])).rows[0].version,result=await publishResult(member,task.id,{validationId:validation.validationId,expectedVersion:version,note:'Checked GitLab browser result',idempotencyKey:randomUUID()});return{taskId:task.id,title:task.title,resultId:result.resultId};
}
process.on('message',(message:{id:string;mode:string})=>{queue=queue.then(async()=>{
 try{let result:unknown;if(message.mode==='work')result=await processGitLab(broker,root,async()=>Buffer.from(key));else if(message.mode==='seed')result=await seed();else if(message.mode==='verify'){const c=(await admin.query('SELECT r.base_sha FROM collab.gitlab_connections c JOIN collab.repositories r ON r.id=c.repository_id WHERE c.id=$1',[connection.id])).rows[0];assert.equal(c.base_sha,await fixture.head());assert.equal(await fixture.command(['show','main:code.txt']),'GitLab changed');result={verified:true};}else throw new Error('Unsupported fixture mode');process.send?.({id:message.id,result});}
 catch{process.send?.({id:message.id,error:'GitLab browser fixture action failed'});}
 });});
await new Promise<void>(resolve=>process.once('disconnect',resolve));await queue;
await fixture.close();key.fill(0);await store.close();await broker.end();await database().end();await admin.end();
