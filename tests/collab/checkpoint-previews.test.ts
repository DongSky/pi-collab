import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {Pool} from 'pg';
import {localConfig,applicationEnvironment,connectionString,executorConnectionString,gatewayConnectionString} from '../../scripts/local-config';
import {startNativeDatabase} from '../../scripts/native-database';
import {migrate} from '../../scripts/migrate';
import {provisioningAuth} from '../../lib/collab/auth';
import {database} from '../../lib/collab/database';
import {createProject} from '../../lib/collab/projects';
import {createTask} from '../../lib/collab/tasks';
import {startRun,runDetail} from '../../lib/collab/runs';
import {ExecutionStore} from '../../lib/collab/execution-store';
import {executeClaim} from '../../lib/collab/executor';
import {runtimeBackend} from '../../lib/collab/runtime/backends';
import {requestSnapshot,processSnapshots} from '../../lib/collab/snapshots';
import {createValidationProfile,requestValidation} from '../../lib/collab/validations';
import {executeValidation} from '../../lib/collab/validation-worker';
import {importLocalRepository} from '../../lib/collab/repository-import';
import {gitSource} from './fixtures/git-source';
import {createPreview,openPreview,revokePreview,listPreviews} from '../../lib/collab/checkpoint-previews';
import {previewHandler,sweepPreviews} from '../../lib/collab/preview-server';
import {previewDirectory} from '../../lib/collab/preview-artifacts';
const mode=process.env.PI_COLLAB_TEST_DOCKER==='1'?'docker':'native';
const config=await localConfig(),name=`pi_collab_test_${randomBytes(6).toString('hex')}`,native=await startNativeDatabase(config),root=await mkdtemp(path.join(tmpdir(),'pi-collab-preview-'));
Object.assign(process.env,applicationEnvironment(config),{DATABASE_URL:connectionString(config,false,name),PI_COLLAB_DATA_DIR:root,PI_COLLAB_RUNTIME:mode,BETTER_AUTH_URL:'http://127.0.0.1:39999'});
const admin=new Pool({connectionString:connectionString(config,true,name)}),gateway=new Pool({connectionString:gatewayConnectionString(config,name)}),store=new ExecutionStore(executorConnectionString(config,name)),org=randomUUID(),users:string[]=[];
const handler=previewHandler(gateway,root,'http://127.0.0.1:39999'),server=createServer((req,res)=>void handler(req,res));
let project:string,taskId:string,validationId:string,checkout:string;
before(async()=>{
 await migrate(config,name);const auth=provisioningAuth(admin);for(let i=0;i<4;i++)users.push((await auth.api.signUpEmail({body:{name:`Preview ${i}`,email:`preview${i}@test.invalid`,password:randomBytes(20).toString('hex')}})).user.id);
 await admin.query("INSERT INTO collab.organizations(id,name,created_by) VALUES($1,'Preview team',$2)",[org,users[0]]);for(let i=0;i<3;i++)await admin.query('INSERT INTO collab.memberships(organization_id,user_id,role) VALUES($1,$2,$3)',[org,users[i],i===0?'owner':'member']);await admin.query('UPDATE public."user" SET "twoFactorEnabled"=true WHERE id=$1',[users[0]]);
 project=(await createProject(users[0],{organizationId:org,name:'Checkpoint preview project',description:''})).id;for(let i=1;i<3;i++)await admin.query('INSERT INTO collab.project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,$4)',[org,project,users[i],i===1?'developer':'reviewer']);
 await gitSource(root);const repository=await importLocalRepository(admin,root,{projectId:project,actorId:users[0],source:path.join(root,'source'),name:'Preview source'}),task=await createTask(users[1],project,{title:'Static checkpoint',description:'',acceptance:'Immutable reviewed preview'});taskId=task.id;
 await startRun(users[1],task.id,{repositoryId:repository.id,baseSha:repository.baseSha,prompt:'Static preview fixture without inference',expectedVersion:task.version,idempotencyKey:randomUUID()});const executor=randomUUID(),claim=(await store.claim(executor,mode))!;
 assert.equal(await executeClaim(store,executor,claim,{dataRoot:root,backend:runtimeBackend(mode),driver:async(agent,_claim,ws)=>{checkout=ws.checkout;await mkdir(path.join(checkout,'preview'));await writeFile(path.join(checkout,'preview/index.html'),'<h1>Fixed checkpoint</h1><script src="app.js"></script>');await writeFile(path.join(checkout,'preview/app.js'),'document.body.dataset.ready="true";');await writeFile(path.join(checkout,'preview/.env'),'PRIVATE_TEST_VALUE=not-for-browser');await writeFile(path.join(checkout,'check.cjs'),"require('node:assert/strict').match(require('node:fs').readFileSync('preview/index.html','utf8'),/Fixed checkpoint/)");await agent.peer.command('bash',{command:'node check.cjs'});return{modelInference:false};}}),'completed');
 const run=(await runDetail(users[1],claim.run.id)).run,snapshot=await requestSnapshot(users[1],run.id,{expectedRevision:run.revision,note:'Static review checkpoint',idempotencyKey:randomUUID()});await processSnapshots(store,root);const profile=await createValidationProfile(users[0],project,{repositoryId:repository.id,name:'Static page fixture',config:{version:1,steps:[{tool:'node',args:['check.cjs'],timeoutSeconds:10}]},idempotencyKey:randomUUID()}),v=await requestValidation(users[1],snapshot.snapshotId,{profileId:profile.profileId,idempotencyKey:randomUUID()});validationId=v.validationId;assert.equal(await executeValidation(store,(await store.claimValidation(executor))!,root),'passed');const recorded=(await admin.query('SELECT evidence FROM collab.validations WHERE id=$1',[validationId])).rows[0].evidence;assert.equal(recorded.environment.policy,mode==='docker'?'container-fixed-validation-v1':'native-trusted-v1');if(mode==='docker')assert.match(recorded.environment.image,/^sha256:/);
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));process.env.PI_COLLAB_PREVIEW_ORIGIN=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
});
after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await store.close();await gateway.end();await database().end();globalThis.__piCollabPool=undefined;await admin.end();const cleanup=new Pool({connectionString:connectionString(config,true,'postgres')});await cleanup.query(`DROP DATABASE "${name}" WITH (FORCE)`);await cleanup.end();await native.stop();await rm(root,{recursive:true,force:true});});
const create=()=>createPreview(users[2],taskId,{validationId,title:'Fixed page',folder:'preview',entry:'index.html'});
test('reviewer creates isolated immutable static artifact, secret omissions remain unavailable, short-lived access and logs are scoped',async()=>{
 const p=await create(),access=await openPreview(users[1],p.id);await writeFile(path.join(checkout,'preview/index.html'),'<h1>Later AI edits</h1>');const page=await fetch(access.url,{headers:{Cookie:'do-not-use-browser-cookie=private'}});assert.equal(page.status,200);assert.match(await page.text(),/Fixed checkpoint/);assert.match(page.headers.get('content-security-policy')!,/sandbox allow-scripts/);assert.match(page.headers.get('content-security-policy')!,/connect-src 'none'/);assert.equal(page.headers.get('set-cookie'),null);assert.equal((await fetch(access.url.replace('index.html','app.js'))).status,200);assert.equal((await fetch(access.url.replace('index.html','.env'))).status,404);assert.equal((await fetch(access.url.replace('index.html','%2e%2e%2fmanifest.json'))).status,404);
 await assert.rejects(openPreview(users[3],p.id),/not_found/);await assert.rejects(listPreviews(users[3],taskId),/不存在/);const listing=await listPreviews(users[0],taskId);assert.equal(listing.previews[0].file_count,2);assert.ok(listing.logs.some(l=>l.path==='app.js'&&l.status===200));assert.equal(JSON.stringify(listing).includes(access.url.split('/')[4]),false);
 await admin.query('UPDATE collab.project_memberships SET active=false WHERE project_id=$1 AND user_id=$2',[project,users[1]]);assert.equal((await fetch(access.url)).status,404);await admin.query('UPDATE collab.project_memberships SET active=true WHERE project_id=$1 AND user_id=$2',[project,users[1]]);
 const other=await openPreview(users[2],p.id);await revokePreview(users[0],p.id,{reason:'Review completed, revoke temporary environment'});assert.equal((await fetch(other.url)).status,404);assert.equal(await sweepPreviews(gateway,root),1);await assert.rejects(readFile(path.join(previewDirectory(root,p.id),'manifest.json')),/ENOENT/);assert.equal((await listPreviews(users[0],taskId)).previews[0].status,'revoked');
});
test('expired preview and viewer token deny access and reclaim only copied files, malformed source fails visibly',async()=>{
 const p=await create(),token=await openPreview(users[2],p.id);await admin.query("UPDATE collab_gateway.preview_tokens SET expires_at=now()-interval '1 second' WHERE preview_id=$1",[p.id]);assert.equal((await fetch(token.url)).status,404);const fresh=await openPreview(users[2],p.id);await admin.query("UPDATE collab.checkpoint_previews SET expires_at=now()-interval '1 second' WHERE id=$1",[p.id]);assert.equal((await fetch(fresh.url)).status,404);assert.equal(await sweepPreviews(gateway,root),1);assert.match(await readFile(path.join(checkout,'preview/index.html'),'utf8'),/Later AI edits/);
 await assert.rejects(createPreview(users[2],taskId,{validationId,title:'Missing entry',folder:'preview',entry:'missing.html'}),/静态预览/);assert.equal((await listPreviews(users[0],taskId)).previews[0].status,'failed');
});
test('container validation rejects source mutation and timeout and confirms the disposable container has stopped',{skip:mode!=='docker'},async()=>{
 const snapshot=(await admin.query('SELECT snapshot_id,profile_id FROM collab.validations WHERE id=$1',[validationId])).rows[0],repository=(await admin.query('SELECT repository_id FROM collab.validation_profiles WHERE id=$1',[snapshot.profile_id])).rows[0].repository_id;
 for(const [args,timeoutSeconds] of [[['-e',"require('fs').writeFileSync('preview/index.html','changed by check')"],10],[['-e','setInterval(()=>{},1000)'],1]] as [string[],number][]){
  const profile=await createValidationProfile(users[0],project,{repositoryId:repository,name:'Container failure fixture',config:{version:1,steps:[{tool:'node',args,timeoutSeconds}]},idempotencyKey:randomUUID()});await requestValidation(users[1],snapshot.snapshot_id,{profileId:profile.profileId,idempotencyKey:randomUUID()});const claim=(await store.claimValidation(randomUUID(),'docker'))!;assert.equal(await executeValidation(store,claim,root),'failed');
  const evidence=(await admin.query('SELECT evidence FROM collab.validations WHERE id=$1',[claim.id])).rows[0].evidence;assert.equal(evidence.steps[0].cleanupConfirmed,true);assert.equal(evidence.steps[0].error,timeoutSeconds===1?'validation_timeout':'validation_source_changed');
  const {inspectContainerExit}=await import('../../lib/collab/runtime/container-receipts');assert.equal((await inspectContainerExit(root,claim.id,{runId:claim.id,executorId:claim.executorId,epoch:claim.epoch})).safe,true);
 }
 assert.match(await readFile(path.join(checkout,'preview/index.html'),'utf8'),/Later AI edits/);
});
