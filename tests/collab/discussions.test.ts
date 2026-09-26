import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { localConfig, applicationEnvironment, connectionString, executorConnectionString } from "../../scripts/local-config";
import { startNativeDatabase } from "../../scripts/native-database";
import { migrate } from "../../scripts/migrate";
import { provisioningAuth } from "../../lib/collab/auth";
import { database, asUser } from "../../lib/collab/database";
import { createProject } from "../../lib/collab/projects";
import { createTask } from "../../lib/collab/tasks";
import { startRun, runDetail } from "../../lib/collab/runs";
import { ExecutionStore } from "../../lib/collab/execution-store";
import { discussionCommand, discussions, discussionDetail, inbox, markInbox, snapshotCode } from "../../lib/collab/discussions";
import { type CodeAnchor, type SnapshotFile, replaceSourceLines } from "../../lib/collab/discussion-schema";
import { requestSnapshot } from "../../lib/collab/snapshots";
import { captureSnapshot, snapshotSummary, restoreSnapshot } from "../../lib/collab/runtime/snapshots";
import { createWorkspace } from "../../lib/collab/runtime/workspace";
import { applyRunSuggestion } from "../../lib/collab/runtime/suggestion";
import { executeClaim } from "../../lib/collab/executor";
import { NativeRuntimeBackend } from "../../lib/collab/runtime/backends";

const config = await localConfig(), name = `pi_collab_test_${randomBytes(6).toString("hex")}`, native = await startNativeDatabase(config);
const root = await mkdtemp(path.join(tmpdir(),"pi-collab-discussions-"));
Object.assign(process.env, applicationEnvironment(config), { DATABASE_URL: connectionString(config, false, name), PI_COLLAB_DATA_DIR:root });
const admin = new Pool({ connectionString: connectionString(config, true, name) });
const store = new ExecutionStore(executorConnectionString(config, name));
const org = randomUUID(), repository = randomUUID(), executor = randomUUID(), users: string[] = [], exec=promisify(execFile);
const repo=path.join(root,"repositories",repository,"git");
let project: string, base: string;
before(async () => {
 await migrate(config, name); const auth = provisioningAuth(admin);
 for(let i=0;i<5;i++)users.push((await auth.api.signUpEmail({body:{name:`Discussion ${i}`,email:`discussion${i}@test.invalid`,password:randomBytes(20).toString("hex")}})).user.id);
 await admin.query("INSERT INTO collab.organizations(id,name,created_by) VALUES($1,'Discussion team',$2)",[org,users[0]]);
 for(let i=0;i<4;i++)await admin.query("INSERT INTO collab.memberships(organization_id,user_id,role) VALUES($1,$2,$3)",[org,users[i],i===0?"owner":"member"]);
 await admin.query('UPDATE public."user" SET "twoFactorEnabled"=true WHERE id=$1',[users[0]]);
 project=(await createProject(users[0],{organizationId:org,name:"Discussion flow",description:""})).id;
 for(let i=1;i<4;i++)await admin.query("INSERT INTO collab.project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,$4)",[org,project,users[i],i===1?"developer":i===2?"reviewer":"viewer"]);
 await mkdir(repo,{recursive:true});for(const args of [["init"],["config","user.name","Discussion test"],["config","user.email","discussions@test.invalid"]])await exec("git",args,{cwd:repo});
 await writeFile(path.join(repo,"code.txt"),"one\ntwo\nthree\n");await exec("git",["add","."],{cwd:repo});await exec("git",["commit","-m","Initial"],{cwd:repo});base=(await exec("git",["rev-parse","HEAD"],{cwd:repo})).stdout.trim();
 await admin.query("INSERT INTO collab.repositories(id,organization_id,project_id,name,provider,base_sha,default_branch) VALUES($1,$2,$3,'Local code','local',$4,'main')",[repository,org,project,base]);
});
after(async()=>{await store.close();await database().end();globalThis.__piCollabPool=undefined;await admin.end();const cleanup=new Pool({connectionString:connectionString(config,true,"postgres")});await cleanup.query(`DROP DATABASE "${name}" WITH (FORCE)`);await cleanup.end();await native.stop();await rm(root,{recursive:true,force:true});});
const create=(title="Review this behavior")=>({action:"create" as const,title,body:"Please review this proposed behavior",mentions:[users[1]],anchor:null,replacement:null,idempotencyKey:randomUUID()});
const task=()=>createTask(users[1],project,{title:"Discuss work",description:"",acceptance:""});

test("threads, explicit mentions, subscriptions, replies and resolution are persisted without feeding AI",async()=>{
 const t=await task();const request=create(),posted=await discussionCommand(users[2],t.id,request);
 assert.equal((await discussionCommand(users[2],t.id,request)).threadId,posted.threadId);
 await assert.rejects(discussionCommand(users[2],t.id,{...request,body:"Changed"}),/idempotency_conflict/);
 assert.equal((await inbox(users[1])).items.filter(i=>i.thread_id===posted.threadId).length,1);
 assert.equal((await inbox(users[2])).items.length,0);
 const note=(await inbox(users[1])).items.find(i=>i.thread_id===posted.threadId)!;
 await markInbox(users[2],{ids:[note.id],read:true});assert.equal((await inbox(users[1])).items.find(i=>i.id===note.id)?.read_at,null);
 await markInbox(users[1],{ids:[note.id],read:true});assert.ok((await inbox(users[1])).items.find(i=>i.id===note.id)?.read_at);
 await discussionCommand(users[3],t.id,{action:"subscribe",enabled:true,idempotencyKey:randomUUID()});
 await discussionCommand(users[1],t.id,{action:"reply",threadId:posted.threadId,body:"The change is intentional",mentions:[],idempotencyKey:randomUUID()});
 assert.equal((await discussionDetail(users[3],posted.threadId)).messages.length,2);
 assert.ok((await inbox(users[3])).items.some(i=>i.thread_id===posted.threadId));
 await discussionCommand(users[1],t.id,{action:"resolve",threadId:posted.threadId,resolved:true,expectedVersion:1,idempotencyKey:randomUUID()});
 await assert.rejects(discussionCommand(users[2],t.id,{action:"reply",threadId:posted.threadId,body:"Reply after close",mentions:[],idempotencyKey:randomUUID()}),/discussion_resolved/);
 await assert.rejects(discussionCommand(users[2],t.id,{action:"resolve",threadId:posted.threadId,resolved:false,expectedVersion:1,idempotencyKey:randomUUID()}),/stale_revision/);
 await discussionCommand(users[2],t.id,{action:"resolve",threadId:posted.threadId,resolved:false,expectedVersion:2,idempotencyKey:randomUUID()});
 assert.equal((await discussions(users[3],t.id)).threads[0].resolved,false);
 assert.equal(Number((await admin.query("SELECT count(*) AS n FROM collab.coordination_notes WHERE source_task_id=$1",[t.id])).rows[0].n),0);
});

test("viewer/outsider restrictions and revoked membership protect discussion and personal inbox",async()=>{
 const t=await task();await assert.rejects(discussionCommand(users[3],t.id,create()),/forbidden/);
 await assert.rejects(discussions(users[4],t.id),/不可访问/);
 await assert.rejects(discussionCommand(users[1],t.id,{...create(),mentions:[users[4]]}),/invalid_mention/);
 const posted=await discussionCommand(users[2],t.id,create());
 await assert.rejects(asUser(users[1],db=>db.query("UPDATE collab.discussion_threads SET replacement='injected' WHERE id=$1",[posted.threadId])),/permission/);
 await admin.query("UPDATE collab.project_memberships SET active=false WHERE project_id=$1 AND user_id=$2",[project,users[1]]);
 try{await assert.rejects(discussionDetail(users[1],posted.threadId),/不可访问/);assert.equal((await inbox(users[1])).items.length,0);}
 finally{await admin.query("UPDATE collab.project_memberships SET active=true WHERE project_id=$1 AND user_id=$2",[project,users[1]]);}
});
async function codeFixture(){
 const t=await task(),run=await startRun(users[1],t.id,{repositoryId:repository,baseSha:base,prompt:"Prepare version",expectedVersion:t.version,idempotencyKey:randomUUID()});
 const claim=(await store.claim(executor,"native"))!;assert.equal(claim.run.id,run.runId);
 const workspace=await createWorkspace(root,claim.workspace.id,repo,base);
 await store.running(executor,run.runId,claim.run.epoch);await store.finish(executor,run.runId,claim.run.epoch,"completed",{});
 const detail=await runDetail(users[1],run.runId);
 const requested=await requestSnapshot(users[1],run.runId,{expectedRevision:detail.run.revision,note:"Code review snapshot",idempotencyKey:randomUUID()});
 const pending=(await store.pendingSnapshots()).find(s=>s.id===requested.snapshotId)!;
 const { id, runId, workspaceId, repositoryId, baseSha, note, context, parentSnapshot, dependencies, contracts, resolution } = pending;
 const source = { id, runId, workspaceId, repositoryId, baseSha, note, context, parentSnapshot, dependencies, contracts, resolution };
 const saved=await captureSnapshot(root,source);await store.completeSnapshot(pending.id,saved.manifestHash,snapshotSummary(saved.manifest),null);
 const file=await snapshotCode(users[2],pending.id,{path:"code.txt"}) as SnapshotFile;
 const anchor:CodeAnchor={snapshotId:pending.id,manifestHash:file.manifestHash,path:file.path,fileHash:file.fileHash,startLine:2,endLine:2};
 return {t,workspace,anchor};
}
test("fixed code suggestions apply before Pi starts in a fresh restored workspace, retaining original bytes and run provenance",async()=>{
 const f=await codeFixture(),posted=await discussionCommand(users[2],f.t.id,{...create(),anchor:f.anchor,replacement:"replacement\n"});
 const t=(await admin.query("SELECT version FROM collab.tasks WHERE id=$1",[f.t.id])).rows[0];
 const input={repositoryId:repository,baseSha:base,prompt:"Validate the applied suggestion",expectedVersion:t.version,idempotencyKey:randomUUID(),snapshotId:f.anchor.snapshotId,suggestionId:posted.threadId};
 await assert.rejects(startRun(users[2],f.t.id,input),/forbidden/);
 const accepted=await startRun(users[1],f.t.id,input);assert.equal((await startRun(users[1],f.t.id,input)).runId,accepted.runId);
 await assert.rejects(startRun(users[1],f.t.id,{...input,suggestionId:undefined}),/idempotency_conflict/);
 const claim=(await store.claim(executor,"native"))!;assert.equal(claim.run.id,accepted.runId);
 assert.equal(await executeClaim(store,executor,claim,{dataRoot:root,backend:new NativeRuntimeBackend(),driver:async agent=>{
  assert.equal(await readFile(path.join(root,"workspaces",claim.workspace.id,"checkout","code.txt"),"utf8"),"one\nreplacement\nthree\n");
  await agent.peer.command("get_state",{});return {checkedSuggestion:true};
 }}),"completed");
 assert.equal(await readFile(path.join(f.workspace.checkout,"code.txt"),"utf8"),"one\ntwo\nthree\n");
 const detail=await discussionDetail(users[2],posted.threadId);assert.ok(detail.applications[0].applied_hash);assert.equal(detail.applications[0].status,"completed");
 assert.ok((await inbox(users[1])).items.some(i=>i.kind==="run.completed"&&i.task_id===f.t.id));
});

test("mismatched hashes, ranges and changed destination bytes cannot silently apply a suggestion",async()=>{
 const f=await codeFixture();
 await assert.rejects(discussionCommand(users[2],f.t.id,{...create(),anchor:{...f.anchor,fileHash:"a".repeat(64)},replacement:"bad"}),/代码版本/);
 await assert.rejects(discussionCommand(users[2],f.t.id,{...create(),anchor:{...f.anchor,endLine:80},replacement:"bad"}),/代码版本/);
 const w=await restoreSnapshot(root,randomUUID(),f.anchor.snapshotId,f.anchor.manifestHash);
 await writeFile(path.join(w.checkout,"code.txt"),"newer bytes\n");
 await assert.rejects(applyRunSuggestion(root,w.checkout,{threadId:randomUUID(),anchor:f.anchor,replacement:"bad"},{id:f.anchor.snapshotId,manifestHash:f.anchor.manifestHash}),/source_changed/);
 assert.equal(await readFile(path.join(w.checkout,"code.txt"),"utf8"),"newer bytes\n");
 assert.equal(replaceSourceLines("a\r\nb\r\nc",{startLine:2,endLine:2},"B\r\n"),"a\r\nB\r\nc");
});
