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
import { database } from "../../lib/collab/database";
import { createProject } from "../../lib/collab/projects";
import { createTask } from "../../lib/collab/tasks";
import { startRun, runDetail } from "../../lib/collab/runs";
import { ExecutionStore } from "../../lib/collab/execution-store";
import { snapshotCode } from "../../lib/collab/discussions";
import { type CodeAnchor, type SnapshotFile } from "../../lib/collab/discussion-schema";
import { requestSnapshot } from "../../lib/collab/snapshots";
import { captureSnapshot, snapshotSummary } from "../../lib/collab/runtime/snapshots";
import { createWorkspace } from "../../lib/collab/runtime/workspace";
import { executeClaim } from "../../lib/collab/executor";
import { measureWorkspace } from "../../lib/collab/runtime/storage-meter";
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
 await writeFile(path.join(repo,"code.txt"),"one\ntwo\nthree\n");await writeFile(path.join(repo,"delete.txt"),"remove me");await exec("git",["add","."],{cwd:repo});await exec("git",["commit","-m","Initial"],{cwd:repo});base=(await exec("git",["rev-parse","HEAD"],{cwd:repo})).stdout.trim();
 await admin.query("INSERT INTO collab.repositories(id,organization_id,project_id,name,provider,base_sha,default_branch) VALUES($1,$2,$3,'Local code','local',$4,'main')",[repository,org,project,base]);
});
after(async()=>{await store.close();await database().end();globalThis.__piCollabPool=undefined;await admin.end();const cleanup=new Pool({connectionString:connectionString(config,true,"postgres")});await cleanup.query(`DROP DATABASE "${name}" WITH (FORCE)`);await cleanup.end();await native.stop();await rm(root,{recursive:true,force:true});});
const task=()=>createTask(users[1],project,{title:"Collaborative work",description:"",acceptance:""});
async function codeFixture(){
 const t=await task(),run=await startRun(users[1],t.id,{repositoryId:repository,baseSha:base,prompt:"Prepare version",expectedVersion:t.version,idempotencyKey:randomUUID()});
 const claim=(await store.claim(executor,"native"))!;assert.equal(claim.run.id,run.runId);
 const workspace=await createWorkspace(root,claim.workspace.id,repo,base);
 await store.running(executor,run.runId,claim.run.epoch);await store.finish(executor,run.runId,claim.run.epoch,"completed",{});
 await store.recordWorkspaceUsage(claim.workspace.id,(await admin.query("SELECT epoch FROM collab.workspaces WHERE id=$1",[claim.workspace.id])).rows[0].epoch,await measureWorkspace(root,claim.workspace.id));
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
import * as Y from "yjs";
import { saveDocumentAs, openEditor, openDocument, syncDocument as rawSyncDocument, editorDetail, editorCommand } from "../../lib/collab/editor";
const state=(d:Y.Doc)=>Buffer.from(Y.encodeStateAsUpdate(d)).toString("base64");
// Simulate version-aware clients; writes carry the server-confirmed text and proof.
const clientBases=new Map<string,import("../../lib/collab/editor-schema").EditorSync>();
const documentBases=new Map<string,import("../../lib/collab/editor-schema").EditorSync>();
async function syncDocument(user:string,session:string,input:import("zod").z.infer<typeof import("../../lib/collab/editor-schema").documentSync>){
 const key=`${user}:${session}:${input.documentId}:${input.clientId}`,docKey=`${session}:${input.documentId}`;
 let payload=input;
 if(input.update&&!input.baseToken){
  const base=clientBases.get(key)??documentBases.get(docKey)??await rawSyncDocument(user,session,{documentId:input.documentId,clientId:input.clientId});
  const d=new Y.Doc();try{Y.applyUpdate(d,Buffer.from(base.document.state,"base64"));const baseText=d.getText("code").toString();Y.applyUpdate(d,Buffer.from(input.update,"base64"));payload={...input,expectedRevision:base.document.revision,baseToken:base.document.baseToken,baseText,localText:d.getText("code").toString()};}finally{d.destroy();}
 }
 const result=await rawSyncDocument(user,session,payload);
 if(!result.conflict){clientBases.set(key,result);documentBases.set(docKey,result);}
 return result;
}

async function draft(){const f=await codeFixture(),t=(await admin.query("SELECT version FROM collab.tasks WHERE id=$1",[f.t.id])).rows[0];const s=await openEditor(users[1],f.t.id,{snapshotId:f.anchor.snapshotId,expectedVersion:t.version});const doc=await openDocument(users[1],s.id,{path:"code.txt"});return{...f,s,doc};}
const checkpoint=async(id:string,action="checkpoint")=>editorCommand(users[1],id,{action,expectedVersion:(await editorDetail(users[1],id)).session.version,note:"Reviewed shared draft"});
test("two independent Yjs clients merge concurrent edits, retry safely, persist cursors and enforce membership",async()=>{
 const f=await draft(),initial=await syncDocument(users[1],f.s.id,{documentId:f.doc.id,clientId:1});const a=new Y.Doc(),b=new Y.Doc();
 try{Y.applyUpdate(a,Buffer.from(initial.document.state,"base64"));Y.applyUpdate(b,Buffer.from(initial.document.state,"base64"));a.getText("code").insert(0,"Alice\n");b.getText("code").insert(b.getText("code").length,"Bob\n");
 await Promise.all([syncDocument(users[1],f.s.id,{documentId:f.doc.id,clientId:a.clientID,update:state(a)}),syncDocument(users[0],f.s.id,{documentId:f.doc.id,clientId:b.clientID,update:state(b)})]);
 const merged=await syncDocument(users[1],f.s.id,{documentId:f.doc.id,clientId:a.clientID});Y.applyUpdate(a,Buffer.from(merged.document.state,"base64"));assert.match(a.getText("code").toString(),/Alice/);assert.match(a.getText("code").toString(),/Bob/);
 const retried=await syncDocument(users[1],f.s.id,{documentId:f.doc.id,clientId:a.clientID,update:state(a)});assert.equal(retried.document.revision,merged.document.revision);
 const point=Y.createRelativePositionFromTypeIndex(a.getText("code"),2);const presence=await syncDocument(users[1],f.s.id,{documentId:f.doc.id,clientId:a.clientID,selection:{anchor:point,head:point}});assert.equal(presence.presence.find(p=>p.clientId===a.clientID)?.userId,users[1]);
 await assert.rejects(syncDocument(users[3],f.s.id,{documentId:f.doc.id,clientId:3,update:state(a)}),/forbidden/);
 await assert.rejects(editorDetail(users[4],f.s.id),/不可访问/);
 await assert.rejects(syncDocument(users[0],f.s.id,{documentId:f.doc.id,clientId:a.clientID}),/editor_client_conflict/);
 const frozen=await checkpoint(f.s.id,"handoff");assert.ok(frozen.versionId);a.getText("code").insert(0,"late");await assert.rejects(syncDocument(users[1],f.s.id,{documentId:f.doc.id,clientId:a.clientID,update:state(a)}),/editor_frozen/);
 assert.equal((await syncDocument(users[3],f.s.id,{documentId:f.doc.id,clientId:3})).canWrite,false);
 }finally{a.destroy();b.destroy();}
});
test("frozen human edits, new files and deletions reach a real Pi fresh workspace; original snapshot stays unchanged",async()=>{
 const f=await draft(),first=await syncDocument(users[1],f.s.id,{documentId:f.doc.id,clientId:2}),d=new Y.Doc();
 Y.applyUpdate(d,Buffer.from(first.document.state,"base64"));d.getText("code").insert(0,"Human reviewed\n");await syncDocument(users[1],f.s.id,{documentId:f.doc.id,clientId:2,update:state(d)});d.destroy();
 const created=await openDocument(users[1],f.s.id,{path:"src/new.txt",create:true}),fresh=new Y.Doc();fresh.getText("code").insert(0,"shared new file\n");await syncDocument(users[0],f.s.id,{documentId:created.id,clientId:4,update:state(fresh)});fresh.destroy();
 const removed=await openDocument(users[1],f.s.id,{path:"delete.txt"});await syncDocument(users[1],f.s.id,{documentId:removed.id,clientId:5,deleted:true,expectedRevision:"1"});
 const t=(await admin.query("SELECT version FROM collab.tasks WHERE id=$1",[f.t.id])).rows[0],input={repositoryId:repository,baseSha:base,prompt:"Validate human draft",expectedVersion:t.version,idempotencyKey:randomUUID(),snapshotId:f.anchor.snapshotId};
 await assert.rejects(startRun(users[1],f.t.id,input),/editor_handoff_required/);
 const frozen=await checkpoint(f.s.id,"handoff");await assert.rejects(startRun(users[2],f.t.id,{...input,editorVersionId:frozen.versionId}),/forbidden/);assert.equal((await editorDetail(users[1],f.s.id)).session.state,"frozen");
 const accepted=await startRun(users[1],f.t.id,{...input,editorVersionId:frozen.versionId});assert.equal((await startRun(users[1],f.t.id,{...input,editorVersionId:frozen.versionId})).runId,accepted.runId);
 await assert.rejects(startRun(users[1],f.t.id,input),/idempotency_conflict/);
 const claim=(await store.claim(executor,"native"))!;assert.equal(claim.run.id,accepted.runId);
 assert.equal(await executeClaim(store,executor,claim,{dataRoot:root,backend:new NativeRuntimeBackend(),driver:async agent=>{
  const checkout=path.join(root,"workspaces",claim.workspace.id,"checkout");assert.equal(await readFile(path.join(checkout,"code.txt"),"utf8"),"Human reviewed\none\ntwo\nthree\n");assert.equal(await readFile(path.join(checkout,"src/new.txt"),"utf8"),"shared new file\n");await assert.rejects(readFile(path.join(checkout,"delete.txt")),/ENOENT/);await agent.peer.command("get_state",{});return{checkedEditor:true};
 }}),"completed");assert.equal(await readFile(path.join(f.workspace.checkout,"code.txt"),"utf8"),"one\ntwo\nthree\n");assert.ok((await admin.query("SELECT applied_hash FROM collab.run_editor_versions WHERE run_id=$1",[accepted.runId])).rows[0].applied_hash);
});
test("checkpoint CAS, reopening, restricted files and non-text Yjs content",async()=>{
 const f=await draft(),version=(await editorDetail(users[1],f.s.id)).session.version;
 await checkpoint(f.s.id);await assert.rejects(editorCommand(users[1],f.s.id,{action:"handoff",expectedVersion:version,note:"stale freeze"}),/stale_revision/);
 assert.throws(()=>openDocument(users[1],f.s.id,{path:".env",create:true}),/受限路径/);
 const d=new Y.Doc();d.getText("code").insertEmbed(0,{unsafe:"object"});try{await assert.rejects(syncDocument(users[1],f.s.id,{documentId:f.doc.id,clientId:6,update:state(d)}),/受限路径/);}finally{d.destroy();}
 await checkpoint(f.s.id,"handoff");await checkpoint(f.s.id,"reopen");assert.equal((await editorDetail(users[1],f.s.id)).session.state,"editing");await checkpoint(f.s.id,"archive");assert.equal((await editorDetail(users[1],f.s.id)).session.state,"archived");
});

test("ten disconnected clients converge after reordered/replayed updates; revocation and old rooms cannot change the new baseline", {timeout:30000}, async()=>{
 const f=await draft(),auth=provisioningAuth(admin);
 const initialRead=await syncDocument(users[1],f.s.id,{documentId:f.doc.id,clientId:100}),seed=new Y.Doc();
 Y.applyUpdate(seed,Buffer.from(initialRead.document.state,"base64"));seed.getText("code").delete(0,seed.getText("code").length);seed.getText("code").insert(0,Array.from({length:10},(_,i)=>`slot${i}\nseparator${i}\n\n`).join("")+"one\ntwo\nthree\n");
 const initial=await syncDocument(users[1],f.s.id,{documentId:f.doc.id,clientId:100,update:state(seed)});seed.destroy();
 const people=[users[1]],clients=Array.from({length:10},()=>new Y.Doc()),updates:Uint8Array[][]=clients.map(()=>[]);
 try{
  for(let i=1;i<10;i++){
   const person=(await auth.api.signUpEmail({body:{name:`Offline editor ${i}`,email:`offline-editor-${i}@test.invalid`,password:randomBytes(20).toString("hex")}})).user.id;people.push(person);
   await admin.query("INSERT INTO collab.memberships(organization_id,user_id,role) VALUES($1,$2,'member')",[org,person]);
   await admin.query("INSERT INTO collab.project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,'developer')",[org,project,person]);
  }
  clients.forEach((doc,i)=>{
   Y.applyUpdate(doc,Buffer.from(initial.document.state,"base64"));
   doc.on("update",(update:Uint8Array)=>updates[i].push(update));
   const offset=doc.getText("code").toString().indexOf(`slot${i}`);
   doc.getText("code").insert(offset,`[A${i}]`);
   doc.getText("code").insert(offset+2,`[B${i}]`); // The second operation depends on the first.
  });
  const sync=(i:number,update?:string)=>syncDocument(people[i],f.s.id,{documentId:f.doc.id,clientId:clients[i].clientID,...(update?{update}:{})});
  await assert.rejects(sync(0,Buffer.from(updates[0][1]).toString("base64")),/前序编辑/);
  assert.equal((await sync(0)).document.state,initial.document.state,"A rejected causal fragment must not persist");
  // Delivery order differs from creation; the last client remains offline.
  const replies=await Promise.all([7,2,8,0,5,1,6,4,3].map(i=>sync(i,state(clients[i]))));assert.ok(replies.every(r=>!r.conflict));
  const beforeLast=await sync(0);Y.applyUpdate(clients[0],Buffer.from(beforeLast.document.state,"base64"));
  const payload=state(clients[9]);await sync(9,payload); // Simulate a committed reply lost in transit.
  const saved=(await sync(0)).document;
  assert.equal((await sync(9,payload)).document.revision,saved.revision,"A replay cannot duplicate accepted text");
  // All volatile client and database connection state can be replaced.
  await database().end();globalThis.__piCollabPool=undefined;
  const merged=await Promise.all(clients.map((_,i)=>sync(i)));
  merged.forEach((reply,i)=>Y.applyUpdate(clients[i],Buffer.from(reply.document.state,"base64")));
  const text=clients[0].getText("code").toString(),vector=Buffer.from(Y.encodeStateVector(clients[0])).toString("hex");
  for(const doc of clients){assert.equal(doc.getText("code").toString(),text);assert.equal(Buffer.from(Y.encodeStateVector(doc)).toString("hex"),vector);assert.equal(doc.store.pendingStructs,null);assert.equal(doc.store.pendingDs,null);}
  for(let i=0;i<10;i++)assert.equal(text.split(`[A[B${i}]${i}]`).length-1,1);
  assert.equal(text.split("one\ntwo\nthree\n").length-1,1);
  const checkpointVersion=await checkpoint(f.s.id);
  const evidence=(await editorDetail(users[1],f.s.id)).versions.find(v=>v.id===checkpointVersion.versionId)!;
  assert.equal(evidence.payload.files.find(file=>file.path==="code.txt")!.text,text);
  await admin.query("UPDATE collab.project_memberships SET active=false,authorization_version=authorization_version+1 WHERE project_id=$1 AND user_id=$2",[project,people[9]]);
  clients[9].getText("code").insert(0,"REVOKED-OFFLINE");await assert.rejects(sync(9,state(clients[9])),/not_found|forbidden|不可访问/);
  await checkpoint(f.s.id,"handoff");clients[0].getText("code").insert(0,"FROZEN-OFFLINE");await assert.rejects(sync(0,state(clients[0])),/editor_frozen/);
  await checkpoint(f.s.id,"archive");
  const current=(await admin.query("SELECT version FROM collab.tasks WHERE id=$1",[f.t.id])).rows[0];
  const next=await openEditor(users[1],f.t.id,{snapshotId:f.anchor.snapshotId,expectedVersion:current.version});assert.notEqual(next.id,f.s.id);
  const nextDocument=await openDocument(users[1],next.id,{path:"code.txt"});
  await assert.rejects(sync(0,state(clients[0])),/editor_frozen/);
  await assert.rejects(syncDocument(users[1],next.id,{documentId:f.doc.id,clientId:clients[0].clientID,update:state(clients[0])}),/不存在|不可访问/);
  const fresh=await syncDocument(users[1],next.id,{documentId:nextDocument.id,clientId:200}),probe=new Y.Doc();
  try{Y.applyUpdate(probe,Buffer.from(fresh.document.state,"base64"));assert.equal(probe.getText("code").toString(),"one\ntwo\nthree\n");}finally{probe.destroy();}
 }finally{clients.forEach(doc=>doc.destroy());}
});

test("failed handoffs copy human drafts without trusting workspaces or reopening old rooms",async()=>{
 const f=await draft(),initial=await syncDocument(users[1],f.s.id,{documentId:f.doc.id,clientId:501}),doc=new Y.Doc();
 try{
  Y.applyUpdate(doc,Buffer.from(initial.document.state,"base64"));doc.getText("code").insert(0,"Preserved human draft\n");
  await syncDocument(users[1],f.s.id,{documentId:f.doc.id,clientId:501,update:state(doc)});
  const frozen=await checkpoint(f.s.id,"handoff"),t=(await admin.query("SELECT version FROM collab.tasks WHERE id=$1",[f.t.id])).rows[0];
  const accepted=await startRun(users[1],f.t.id,{repositoryId:repository,baseSha:base,prompt:"Fail before process launch",expectedVersion:t.version,idempotencyKey:randomUUID(),snapshotId:f.anchor.snapshotId,editorVersionId:frozen.versionId});
  await assert.rejects(checkpoint(f.s.id,"copy"),/task_busy/);
  const claim=(await store.claim(executor,"native"))!;assert.equal(claim.run.id,accepted.runId);
  await store.finish(executor,accepted.runId,claim.run.epoch,"failed",{reason:"before launch"});
  const old=await editorDetail(users[1],f.s.id);
  await assert.rejects(editorCommand(users[2],f.s.id,{action:"copy",expectedVersion:old.session.version,note:"Reviewer cannot recover draft"}),/forbidden/);
  await assert.rejects(editorCommand(users[1],f.s.id,{action:"copy",expectedVersion:"1",note:"Stale copy request"}),/stale_revision/);
  const copied=await checkpoint(f.s.id,"copy"),next=await editorDetail(users[1],copied.sessionId);
  assert.notEqual(next.session.id,f.s.id);assert.equal(next.session.state,"editing");assert.equal(next.session.snapshot_id,f.anchor.snapshotId);
  assert.notEqual(next.documents[0].id,f.doc.id);
  const synced=await syncDocument(users[1],next.session.id,{documentId:next.documents[0].id,clientId:502}),probe=new Y.Doc();
  try{Y.applyUpdate(probe,Buffer.from(synced.document.state,"base64"));assert.equal(probe.getText("code").toString(),doc.getText("code").toString());}finally{probe.destroy();}
  assert.deepEqual((await editorDetail(users[1],f.s.id)).versions,old.versions);
  await assert.rejects(syncDocument(users[1],f.s.id,{documentId:f.doc.id,clientId:501,update:state(doc)}),/editor_frozen/);
  await assert.rejects(checkpoint(f.s.id,"copy"),/editor_exists/);
  const newVersion=await checkpoint(next.session.id,"handoff");assert.notEqual(newVersion.versionId,frozen.versionId);
 }finally{doc.destroy();}
});

test("save as copies acknowledged contents atomically without overwriting existing files",async()=>{
 const f=await draft(),initial=await syncDocument(users[1],f.s.id,{documentId:f.doc.id,clientId:201}),doc=new Y.Doc();
 try{
  Y.applyUpdate(doc,Buffer.from(initial.document.state,"base64"));doc.getText("code").insert(0,"Saved source\n");
  const saved=await syncDocument(users[1],f.s.id,{documentId:f.doc.id,clientId:201,update:state(doc)});
  await assert.rejects(saveDocumentAs(users[1],f.s.id,{documentId:f.doc.id,path:"old.txt",expectedRevision:initial.document.revision}),/协作者修改/);
  const input={documentId:f.doc.id,path:"src/copy.txt",expectedRevision:saved.document.revision};
  const results=await Promise.allSettled([saveDocumentAs(users[1],f.s.id,input),saveDocumentAs(users[0],f.s.id,input)]);
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);assert.equal(results.filter(r=>r.status==="rejected").length,1);
  const copy=results.find(r=>r.status==="fulfilled") as PromiseFulfilledResult<{id:string;path:string}>;
  const synced=await syncDocument(users[1],f.s.id,{documentId:copy.value.id,clientId:202}),copyDoc=new Y.Doc();
  try{Y.applyUpdate(copyDoc,Buffer.from(synced.document.state,"base64"));assert.equal(copyDoc.getText("code").toString(),doc.getText("code").toString());}finally{copyDoc.destroy();}
  assert.equal((await syncDocument(users[1],f.s.id,{documentId:f.doc.id,clientId:201})).document.revision,saved.document.revision);
  for(const path of ["code.txt","delete.txt","src","src/copy.txt/child"])await assert.rejects(saveDocumentAs(users[1],f.s.id,{...input,path}),/目标路径已存在/);
  assert.throws(()=>saveDocumentAs(users[1],f.s.id,{...input,path:"../private"}),/受限路径/);
  await assert.rejects(saveDocumentAs(users[3],f.s.id,{...input,path:"viewer.txt"}),/forbidden/);
  await assert.rejects(saveDocumentAs(users[4],f.s.id,{...input,path:"outsider.txt"}),/not_found/);
  await checkpoint(f.s.id,"handoff");await assert.rejects(saveDocumentAs(users[1],f.s.id,{...input,path:"frozen.txt"}),/editor_frozen/);
 }finally{doc.destroy();}
});

test("checked saves block overlapping edits, retain versions, recheck resolutions and reject bypasses",async()=>{
 const f=await draft(),base=await rawSyncDocument(users[1],f.s.id,{documentId:f.doc.id,clientId:800});
 let lastPayload:import("zod").z.infer<typeof import("../../lib/collab/editor-schema").documentSync>;
 const submit=async(content:string,from=base,resolution=false)=>{const d=new Y.Doc();try{Y.applyUpdate(d,Buffer.from(from.document.state,"base64"));const baseText=d.getText("code").toString();d.getText("code").delete(0,d.getText("code").length);d.getText("code").insert(0,content);lastPayload={documentId:f.doc.id,clientId:800,update:state(d),expectedRevision:from.document.revision,baseText,baseToken:from.document.baseToken,localText:content,resolution};return await rawSyncDocument(users[1],f.s.id,lastPayload);}finally{d.destroy();}};
 const remote=await submit("server\ntwo\nthree\n");assert.equal(remote.conflict,undefined);
 const failed=await submit("local\ntwo\nthree\n");assert.ok(failed.conflict);assert.equal(failed.document.revision,remote.document.revision);assert.equal(failed.document.state,remote.document.state);
 assert.equal(failed.conflict.base,"one\ntwo\nthree\n");assert.equal(failed.conflict.local,"local\ntwo\nthree\n");assert.equal(failed.conflict.remote,"server\ntwo\nthree\n");
 const peer=await submit("server again\ntwo\nthree\n",remote);
 const stale=await submit("resolved\ntwo\nthree\n",remote,true);assert.ok(stale.conflict);assert.equal(stale.document.state,peer.document.state);
 const done=await submit("resolved\ntwo\nthree\n",peer,true);assert.equal(done.conflict,undefined);
 const duplicate=await rawSyncDocument(users[1],f.s.id,lastPayload!);assert.equal(duplicate.document.revision,done.document.revision);
 const emoji=await submit("😀中文\ntwo\nthree\n",done);const unicode=await submit("😇中文\ntwo\nthree\n",emoji);const probe=new Y.Doc();Y.applyUpdate(probe,Buffer.from(unicode.document.state,"base64"));assert.equal(probe.getText("code").toString(),"😇中文\ntwo\nthree\n");probe.destroy();
 const d=new Y.Doc();Y.applyUpdate(d,Buffer.from(done.document.state,"base64"));
 try{
  await assert.rejects(rawSyncDocument(users[1],f.s.id,{documentId:f.doc.id,clientId:800,update:state(d)}),/版本校验/);
  await assert.rejects(rawSyncDocument(users[1],f.s.id,{documentId:f.doc.id,clientId:800,update:state(d),expectedRevision:done.document.revision,baseText:"forged",baseToken:done.document.baseToken,localText:"forged"}),/基线无法验证/);
 }finally{d.destroy();}
});

test("Agent repair runs in an independent task, retries once, and returns a snapshot candidate without saving",async()=>{
 const {startConflictAgent,conflictAgentResult}=await import("../../lib/collab/editor-conflict-agent");
 const f=await draft(),initial=await syncDocument(users[1],f.s.id,{documentId:f.doc.id,clientId:901}),modelId=randomUUID();
 await admin.query("INSERT INTO collab.model_profiles(id,organization_id,project_id,name,model_id,api,context_window,max_output_tokens,run_token_limit,run_request_limit) VALUES($1,$2,$3,'Conflict test','test','openai-responses',128000,8192,1000000,24)",[modelId,org,project]);
 const input={documentId:f.doc.id,requestKey:randomUUID(),modelId,revision:initial.document.revision,baseToken:initial.document.baseToken,base:"original\ntwo\nthree\n",local:"local\ntwo\nthree\n",remote:"one\ntwo\nthree\n"};
 await assert.rejects(startConflictAgent(users[3],f.s.id,input),/forbidden/);
 const job=await startConflictAgent(users[1],f.s.id,input),replay=await startConflictAgent(users[1],f.s.id,input);assert.deepEqual(job,replay);assert.notEqual(job.taskId,f.t.id);
 assert.equal((await syncDocument(users[1],f.s.id,{documentId:f.doc.id,clientId:901})).document.state,initial.document.state);
 await assert.rejects(startConflictAgent(users[1],f.s.id,{...input,local:"changed request"}),/请求内容已变化/);
 await assert.rejects(conflictAgentResult(users[0],f.s.id,{taskId:job.taskId,documentId:f.doc.id}),/不可访问/);
 const claim=await store.claim(executor,"native");assert.ok(claim,JSON.stringify((await admin.query("SELECT r.status,r.summary,collab_worker.authorized(r.id) AS authorized,collab_worker.capacity_available(r.project_id,r.requested_by) AS capacity FROM collab.runs r WHERE r.id=$1",[job.runId])).rows));assert.equal(claim.run.id,job.runId);
 const workspace=await createWorkspace(root,claim.workspace.id,repo,base);await writeFile(path.join(workspace.checkout,"code.txt"),"resolved candidate\ntwo\nthree\n");
 await store.running(executor,job.runId,claim.run.epoch);await store.finish(executor,job.runId,claim.run.epoch,"completed",{});
 assert.equal((await conflictAgentResult(users[1],f.s.id,{taskId:job.taskId,documentId:f.doc.id})).status,"正在保存候选快照");
 const pending=(await store.pendingSnapshots()).find(s=>s.runId===job.runId)!;
 const {id,runId,workspaceId,repositoryId,baseSha,note,context,parentSnapshot,dependencies,contracts,resolution}=pending;
 const saved=await captureSnapshot(root,{id,runId,workspaceId,repositoryId,baseSha,note,context,parentSnapshot,dependencies,contracts,resolution});await store.completeSnapshot(id,saved.manifestHash,snapshotSummary(saved.manifest),null);
 const candidate=await conflictAgentResult(users[1],f.s.id,{taskId:job.taskId,documentId:f.doc.id});assert.equal(candidate.status,"ready");assert.equal(candidate.text,"resolved candidate\ntwo\nthree\n");
 assert.equal((await syncDocument(users[1],f.s.id,{documentId:f.doc.id,clientId:901})).document.state,initial.document.state,"Agent result must still require human confirmation");
});

test("file AI starts while humans edit, authenticates context, and merges or blocks later candidates",async()=>{
 const {startConflictAgent}=await import("../../lib/collab/editor-conflict-agent");
 const f=await draft(),initial=await rawSyncDocument(users[1],f.s.id,{documentId:f.doc.id,clientId:950}),modelId=randomUUID();
 await admin.query("INSERT INTO collab.model_profiles(id,organization_id,project_id,name,model_id,api,context_window,max_output_tokens,run_token_limit,run_request_limit) VALUES($1,$2,$3,'File AI test','test','openai-responses',128000,8192,1000000,24)",[modelId,org,project]);
 const input={documentId:f.doc.id,requestKey:randomUUID(),modelId,revision:initial.document.revision,baseToken:initial.document.baseToken,base:"one\ntwo\nthree\n",local:"one\ntwo\nthree\n",remote:"one\ntwo\nthree\n",instruction:"Change the first line to AI; retain the remaining lines."};
 await assert.rejects(startConflictAgent(users[3],f.s.id,input),/forbidden/);
 await assert.rejects(startConflictAgent(users[4],f.s.id,input),/not_found/);
 await assert.rejects(startConflictAgent(users[1],f.s.id,{...input,baseToken:"a".repeat(64)}),/服务器版本已变化/);
 await assert.rejects(startConflictAgent(users[1],f.s.id,{...input,local:"forged"}),/确认当前文件版本/);
 const [a,b]=await Promise.all([startConflictAgent(users[1],f.s.id,input),startConflictAgent(users[1],f.s.id,input)]);assert.deepEqual(a,b);
 assert.notEqual(a.taskId,f.t.id);assert.equal((await editorDetail(users[1],f.s.id)).session.state,"editing");
 const submit=async(content:string,from=initial)=>{const d=new Y.Doc();try{Y.applyUpdate(d,Buffer.from(from.document.state,"base64"));const baseText=d.getText("code").toString();d.getText("code").delete(0,d.getText("code").length);d.getText("code").insert(0,content);return await rawSyncDocument(users[1],f.s.id,{documentId:f.doc.id,clientId:950,update:state(d),expectedRevision:from.document.revision,baseText,baseToken:from.document.baseToken,localText:content});}finally{d.destroy();}};
 const peer=await submit("one\ntwo\nPEER\n");assert.equal(peer.conflict,undefined);
 assert.deepEqual(await startConflictAgent(users[1],f.s.id,input),a,"Retry remains idempotent after a peer save");
 await assert.rejects(startConflictAgent(users[1],f.s.id,{...input,requestKey:randomUUID()}),/服务器版本已变化/);
 const merged=await submit("AI\ntwo\nthree\n");assert.equal(merged.conflict,undefined);assert.equal(merged.merged,true);
 const d=new Y.Doc();Y.applyUpdate(d,Buffer.from(merged.document.state,"base64"));assert.equal(d.getText("code").toString(),"AI\ntwo\nPEER\n");d.destroy();
 const conflict=await submit("OTHER AI\ntwo\nthree\n");assert.ok(conflict.conflict);assert.equal(conflict.document.revision,merged.document.revision);
 const taskRow=(await admin.query("SELECT description FROM collab.tasks WHERE id=$1",[a.taskId])).rows[0];assert.match(taskRow.description,/Change the first line/);assert.match(taskRow.description,/Only modify this file/);
 const claim=(await store.claim(executor,"native"))!;assert.equal(claim.run.id,a.runId);await store.finish(executor,a.runId,claim.run.epoch,"failed",{reason:"test cleanup"});
 await checkpoint(f.s.id,"handoff");await assert.rejects(startConflictAgent(users[1],f.s.id,{...input,requestKey:randomUUID()}),/editor_frozen/);
});

test("browser folder import opens a shared editor and Git baseline without AI or host path access",async()=>{
 const {importFolder}=await import("../../lib/collab/folder-import");
 const encode=(value:string)=>Buffer.from(value).toString("base64");
 const input={requestKey:randomUUID(),name:"Local folder",files:[{path:"src/main.ts",data:encode('export const answer = 42;\n')},{path:"README.md",data:encode('# Current local contents\n')},{path:".gitignore",data:encode('README.md\n')},{path:".gitattributes",data:encode('*.ts working-tree-encoding=UTF-16\n')}]};
 await assert.rejects(importFolder(users[3],project,input),/permission/);
 await assert.rejects(importFolder(users[4],project,input),/not found/);
 for(const file of ["../outside.txt",".git/config",".env","node_modules/pkg/index.js","A/../../outside"]){await assert.rejects(importFolder(users[1],project,{...input,files:[{path:file,data:encode("bad")}]}),/不允许导入路径/);}
 await assert.rejects(importFolder(users[1],project,{...input,files:[{path:"A.ts",data:encode("a")},{path:"a.ts",data:encode("b")}]}),/重复/);
 await assert.rejects(importFolder(users[1],project,{...input,files:[{path:"a",data:encode("a")},{path:"a/b",data:encode("b")}]}),/路径冲突/);
 const [a,b]=await Promise.all([importFolder(users[1],project,input),importFolder(users[1],project,input)]);assert.deepEqual(a,b);assert.equal(a.firstFile,"src/main.ts");
 assert.equal((await editorDetail(users[1],a.sessionId)).session.state,"editing");
 assert.equal((await admin.query("SELECT count(*)::int AS n FROM collab.repositories WHERE id=$1",[a.repositoryId])).rows[0].n,1);
 const row=(await admin.query("SELECT status,model_profile_id,summary FROM collab.runs WHERE task_id=$1",[a.taskId])).rows[0];assert.equal(row.status,"completed");assert.equal(row.model_profile_id,null);assert.equal(row.summary.reason,"folder_import");
 const {repositoryCode}=await import("../../lib/collab/repository-code");const code=await repositoryCode(users[1],a.repositoryId,{path:"README.md"});assert.equal((code as {text:string}).text,"# Current local contents\n","Selected uncommitted/ignored bytes form the baseline");
 const document=await openDocument(users[1],a.sessionId,{path:"src/main.ts"});const live=await rawSyncDocument(users[1],a.sessionId,{documentId:document.id,clientId:980});assert.equal(live.canWrite,true);
 const candidateWorkspace=await createWorkspace(root,randomUUID(),path.join(root,"repositories",a.repositoryId,"git"));assert.equal(await readFile(path.join(candidateWorkspace.checkout,"src/main.ts"),"utf8"),'export const answer = 42;\n',"Imported working bytes must not be encoded again for AI");
 await assert.rejects(importFolder(users[1],project,{...input,name:"Changed request"}),/已改变/);
 const {startConflictAgent}=await import("../../lib/collab/editor-conflict-agent");const model=(await admin.query("SELECT id FROM collab.model_profiles WHERE project_id=$1 LIMIT 1",[project])).rows[0];
 const text='export const answer = 42;\n',job=await startConflictAgent(users[1],a.sessionId,{documentId:document.id,requestKey:randomUUID(),modelId:model.id,revision:live.document.revision,baseToken:live.document.baseToken,base:text,local:text,remote:text,instruction:"Explain this file"});
 const claim=(await store.claim(executor,"native"))!;assert.equal(claim.run.id,job.runId);await store.finish(executor,job.runId,claim.run.epoch,"failed",{reason:"test cleanup"});
});

test("rename is atomic, version checked, cannot overwrite, and invalidates old clients",async()=>{
 const {renameDocument}=await import('../../lib/collab/editor');
 const f=await draft(),initial=await rawSyncDocument(users[1],f.s.id,{documentId:f.doc.id,clientId:991});
 const input={documentId:f.doc.id,path:'src/renamed.txt',expectedRevision:initial.document.revision};
 await assert.rejects(renameDocument(users[3],f.s.id,input),/forbidden/);
 await assert.rejects(renameDocument(users[1],f.s.id,{...input,path:'delete.txt'}),/目标路径已存在/);
 await assert.rejects(renameDocument(users[1],f.s.id,{...input,expectedRevision:'0'}),/修改/);
 const moved=await renameDocument(users[1],f.s.id,input);
 const detail=await editorDetail(users[1],f.s.id);assert.equal(detail.documents.find(d=>d.id===f.doc.id)?.deleted,true);assert.equal(detail.documents.find(d=>d.id===moved.id)?.path,input.path);
 const old=await rawSyncDocument(users[1],f.s.id,{documentId:f.doc.id,clientId:991});assert.equal(old.canWrite,false);
 const value=await rawSyncDocument(users[1],f.s.id,{documentId:moved.id,clientId:992}),doc=new Y.Doc();Y.applyUpdate(doc,Buffer.from(value.document.state,'base64'));assert.equal(doc.getText('code').toString(),'one\ntwo\nthree\n');doc.destroy();
 await assert.rejects(renameDocument(users[1],f.s.id,input),/已删除/);
});
test("search and ZIP use current draft text, exclude deleted paths, and authorize every request",async()=>{
 const {searchEditorFiles,exportEditorFiles}=await import('../../lib/collab/editor-files');
 const {unzipSync,strFromU8}=await import('fflate');const f=await draft();
 const initial=await syncDocument(users[1],f.s.id,{documentId:f.doc.id,clientId:993}),doc=new Y.Doc();Y.applyUpdate(doc,Buffer.from(initial.document.state,'base64'));doc.getText('code').insert(0,'SEARCH CURRENT\n');await syncDocument(users[1],f.s.id,{documentId:f.doc.id,clientId:doc.clientID,update:state(doc)});doc.destroy();
 const deleted=await openDocument(users[1],f.s.id,{path:'delete.txt'}),before=await syncDocument(users[1],f.s.id,{documentId:deleted.id,clientId:994});await syncDocument(users[1],f.s.id,{documentId:deleted.id,clientId:994,deleted:true,expectedRevision:before.document.revision});
 assert.equal((await searchEditorFiles(users[1],f.s.id,{query:'search current'})).matches[0].line,1);
 assert.equal((await searchEditorFiles(users[1],f.s.id,{query:'search current',caseSensitive:true})).matches.length,0);
 const result=await exportEditorFiles(users[1],f.s.id),zip=unzipSync(result.bytes);assert.equal(zip['delete.txt'],undefined);assert.equal(strFromU8(zip['code.txt']),'SEARCH CURRENT\none\ntwo\nthree\n');
 await assert.rejects(exportEditorFiles(users[4],f.s.id),/not_found/);await assert.rejects(searchEditorFiles(users[4],f.s.id,{query:'one'}),/not_found/);
});

test("multi-file edits preview, apply atomically, undo with a version fence, and enforce roles", async () => {
 const { previewReplace, applyEditorChanges, languageQuery } = await import("../../lib/collab/editor-intelligence");
 const f = await draft();
 const preview = await previewReplace(users[1], f.s.id, { query: "e", replacement: "E", caseSensitive: true });
 assert.equal(preview.changes.length, 2);
 await assert.rejects(applyEditorChanges(users[3], f.s.id, { version: preview.version, changes: preview.changes }), /forbidden/);
 await assert.rejects(previewReplace(users[4], f.s.id, { query: "e", replacement: "E" }), /not_found/);
 // A stale later file must roll back even the earlier successful write.
 await assert.rejects(applyEditorChanges(users[1], f.s.id, { version: preview.version, changes: preview.changes.map((c,i) => i === 1 ? { ...c, before: "wrong base" } : c) }), /基线已变化/);
 assert.equal((await editorDetail(users[1], f.s.id)).session.version, preview.version);
 const applied = await applyEditorChanges(users[1], f.s.id, { version: preview.version, changes: preview.changes });
 const code = await syncDocument(users[1], f.s.id, { documentId: f.doc.id, clientId: 19 });
 const doc = new Y.Doc();Y.applyUpdate(doc, Buffer.from(code.document.state,"base64"));assert.match(doc.getText("code").toString(), /onE/);doc.destroy();
 await assert.rejects(applyEditorChanges(users[1], f.s.id, { version: preview.version, changes: preview.changes }), /未写入任何文件/);
 await applyEditorChanges(users[1], f.s.id, { version: applied.version, changes: preview.changes.map(c=>({ path:c.path,before:c.after,after:c.before })) });
 assert.equal((await previewReplace(users[1], f.s.id, { query: "one", replacement: "$&\\value" })).changes[0].after, "$&\\value\ntwo\nthree\n");
 const current = await previewReplace(users[1], f.s.id, { query: "one", replacement: "first" });
 await assert.rejects(applyEditorChanges(users[1], f.s.id, { version:current.version,changes:[{path:"../escape",before:"",after:"x"}] }), /受限/);
 await assert.rejects(languageQuery(users[4], f.s.id, { action:"diagnostics",path:"code.ts" }), /not_found/);
 await checkpoint(f.s.id,"handoff");
 await assert.rejects(applyEditorChanges(users[1], f.s.id, { version:current.version,changes:current.changes }), /editor_frozen/);
});
