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
import {createServicePreview,openServicePreview,stopServicePreview,listServicePreviews} from '../../lib/collab/service-previews';
import {executeServicePreview,reconcileServicePreviews} from '../../lib/collab/service-preview-worker';
import {serviceSource,buildProof,emptyPackage,emptyLock} from './fixtures/service-source';
import {previewHandler} from '../../lib/collab/preview-server';
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
 assert.equal(await executeClaim(store,executor,claim,{dataRoot:root,backend:runtimeBackend(mode),driver:async(agent,_claim,ws)=>{checkout=ws.checkout;await writeFile(path.join(checkout,'server.cjs'),serviceSource);await writeFile(path.join(checkout,'package.json'),emptyPackage);await writeFile(path.join(checkout,'package-lock.json'),emptyLock);await mkdir(path.join(checkout,'preview'));await writeFile(path.join(checkout,'preview/index.html'),'<h1>Fixed checkpoint</h1><script src="app.js"></script>');await writeFile(path.join(checkout,'preview/app.js'),'document.body.dataset.ready="true";');await writeFile(path.join(checkout,'preview/.env'),'PRIVATE_TEST_VALUE=not-for-browser');await writeFile(path.join(checkout,'check.cjs'),"require('node:assert/strict').match(require('node:fs').readFileSync('preview/index.html','utf8'),/Fixed checkpoint/)");await agent.peer.command('bash',{command:'node check.cjs'});return{modelInference:false};}}),'completed');
 const run=(await runDetail(users[1],claim.run.id)).run,snapshot=await requestSnapshot(users[1],run.id,{expectedRevision:run.revision,note:'Static review checkpoint',idempotencyKey:randomUUID()});await processSnapshots(store,root);const profile=await createValidationProfile(users[0],project,{repositoryId:repository.id,name:'Static page fixture',config:{version:1,steps:[{tool:'node',args:['check.cjs'],timeoutSeconds:10}]},idempotencyKey:randomUUID()}),v=await requestValidation(users[1],snapshot.snapshotId,{profileId:profile.profileId,idempotencyKey:randomUUID()});validationId=v.validationId;assert.equal(await executeValidation(store,(await store.claimValidation(executor))!,root),'passed');const recorded=(await admin.query('SELECT evidence FROM collab.validations WHERE id=$1',[validationId])).rows[0].evidence;assert.equal(recorded.environment.policy,mode==='docker'?'container-fixed-validation-v1':'native-trusted-v1');if(mode==='docker')assert.match(recorded.environment.image,/^sha256:/);
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));process.env.PI_COLLAB_PREVIEW_ORIGIN=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
});
after(async()=>{for(const a of shutdowns)a.abort();await Promise.allSettled(pending);server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await store.close();await gateway.end();await database().end();globalThis.__piCollabPool=undefined;await admin.end();const cleanup=new Pool({connectionString:connectionString(config,true,'postgres')});await cleanup.query(`DROP DATABASE "${name}" WITH (FORCE)`);await cleanup.end();await native.stop();await rm(root,{recursive:true,force:true});});

const configuration={install:"none" as const,build:buildProof,start:{tool:"node" as const,args:["server.cjs"]},healthPath:"/",seconds:120};
const pending:Promise<unknown>[]=[];const shutdowns:AbortController[]=[];
const create=(extra={})=>createServicePreview(users[1],taskId,{validationId,title:"Dynamic checkpoint",config:configuration,idempotencyKey:randomUUID(),acknowledge:true,...extra});
async function waitReady(id:string){const end=Date.now()+20000;for(;;){const p=(await listServicePreviews(users[1],taskId)).previews.find(p=>p.id===id);if(p?.status==='ready')return;if(['failed','unknown','stopped'].includes(p?.status))throw new Error(`Preview startup ${p.status}: ${p.failure}`);if(Date.now()>end)throw new Error('Preview startup deadline');await new Promise(r=>setTimeout(r,100));}}
async function launch(extra={}){const p=await create(extra),claim=await store.claimService(randomUUID(),mode);assert.ok(claim);assert.equal(claim.id,p.id);const abort=new AbortController();shutdowns.push(abort);const work=executeServicePreview(store,claim,root,abort.signal);pending.push(work);await waitReady(p.id);return {id:p.id,claim,work,abort};}
test('real dynamic service builds an isolated snapshot and proxies HTTP through native/container IPC; stop confirms exit and reclaims copies',{timeout:60000},async()=>{
 const s=await launch({config:{...configuration,install:'npm-ci'}}),access=await openServicePreview(users[2],s.id);
 await writeFile(path.join(checkout,'server.cjs'),'source edited after preview started');
 const response=await fetch(access.url);assert.equal(response.status,200);assert.match(await response.text(),/固定快照动态服务/);assert.equal(response.headers.get('set-cookie'),null);assert.match(response.headers.get('content-security-policy')!,/sandbox allow-scripts/);
 assert.equal((await fetch(access.url+'api',{method:'OPTIONS',headers:{Origin:'null','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type'}})).status,204);
 assert.deepEqual(await(await fetch(access.url+'api',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).json(),{count:1});
 assert.deepEqual(await(await fetch(access.url+'headers',{headers:{Cookie:'control=secret',Authorization:'Bearer private'}})).json(),{cookie:null,authorization:null});
 assert.equal(await(await fetch(access.url+'redaction')).text(),'logged');
 const logDeadline=Date.now()+5000;let output='';
 while(Date.now()<logDeadline){output=(await listServicePreviews(users[0],taskId)).previews.find(p=>p.id===s.id).output_tail;if(output.includes('redaction complete'))break;await new Promise(r=>setTimeout(r,100));}
 assert.match(output,/\[REDACTED\]/);assert.match(output,/redaction complete/);assert.equal(output.includes('private-fixture'),false);
 const redirect=await fetch(access.url+'redirect',{redirect:'manual'});assert.equal(redirect.headers.get('location'),new URL(access.url).pathname);
 const artifact=await store.artifactLimit('service',s.id);assert.ok(artifact);assert.ok(Number(artifact.limit_bytes)>0);
 await assert.rejects(openServicePreview(users[3],s.id),/not_found/);await assert.rejects(stopServicePreview(users[2],s.id,'Viewer cannot stop a colleague preview'),/forbidden/);
 await stopServicePreview(users[0],s.id,'Maintainer ends preview after review');assert.equal((await fetch(access.url)).status,404);assert.equal(await s.work,'stopped');
 await assert.rejects(readFile(path.join(root,'workspaces',s.id,'checkout/server.cjs')),/ENOENT/);assert.equal(await readFile(path.join(checkout,'server.cjs'),'utf8'),'source edited after preview started');
 const state=(await listServicePreviews(users[0],taskId));assert.ok(state.previews.find(p=>p.id===s.id).cleaned_at);assert.ok(state.logs.some(l=>l.preview_id===s.id&&l.method==='POST'&&l.path==='/api'));assert.equal((await admin.query("SELECT state FROM collab_worker.artifacts WHERE kind='service' AND id=$1",[s.id])).rows[0].state,'deleted');
});
test('source admission is idempotent and role scoped; revoked viewers lose access, creator revocation stops the writer',{timeout:45000},async()=>{
 const input={validationId,title:'Duplicate service',config:configuration,idempotencyKey:randomUUID(),acknowledge:true};
 await assert.rejects(createServicePreview(users[2],taskId,input),/forbidden/);const first=await createServicePreview(users[1],taskId,input);assert.equal((await createServicePreview(users[1],taskId,input)).id,first.id);await assert.rejects(createServicePreview(users[1],taskId,{...input,title:'changed'}),/idempotency_conflict/);
 const claim=(await store.claimService(randomUUID(),mode))!;assert.equal(claim.id,first.id);const abort=new AbortController();shutdowns.push(abort);const work=executeServicePreview(store,claim,root,abort.signal);pending.push(work);await waitReady(first.id);const token=await openServicePreview(users[2],first.id);
 await admin.query('UPDATE collab.project_memberships SET active=false WHERE project_id=$1 AND user_id=$2',[project,users[2]]);assert.equal((await fetch(token.url)).status,404);await admin.query('UPDATE collab.project_memberships SET active=true WHERE project_id=$1 AND user_id=$2',[project,users[2]]);
 await admin.query('UPDATE collab.project_memberships SET active=false WHERE project_id=$1 AND user_id=$2',[project,users[1]]);assert.equal(await work,'stopped');await admin.query('UPDATE collab.project_memberships SET active=true WHERE project_id=$1 AND user_id=$2',[project,users[1]]);
});
test('failed startup and expiry are visible and reclaim only exited copies; uncertain leases cannot restart',{timeout:45000},async()=>{
 const p=await create({config:{...configuration,start:{tool:'node',args:['-e','process.exit(2)']}}}),claim=(await store.claimService(randomUUID(),mode))!;
 assert.equal(await executeServicePreview(store,claim,root),'failed');assert.ok((await listServicePreviews(users[1],taskId)).previews.find(row=>row.id===p.id).cleaned_at);
 const s=await launch();await admin.query("UPDATE collab.service_previews SET expires_at=now()-interval '1 second' WHERE id=$1",[s.id]);assert.equal(await s.work,'stopped');
 const uncertain=await create(),lost=(await store.claimService(randomUUID(),mode))!;await admin.query("UPDATE collab.service_previews SET lease_until=now()-interval '1 second' WHERE id=$1",[uncertain.id]);await reconcileServicePreviews(store,root,mode);assert.equal((await listServicePreviews(users[1],taskId)).previews.find(row=>row.id===uncertain.id).status,'unknown');assert.equal(await store.claimService(randomUUID(),mode),null);
 // This test owns the never-launched claim and can certify that no backend ran.
 await store.finishService(lost,'failed',true,'test_never_launched');await store.serviceCleaned(lost.id);
});
