import test,{before,after} from "node:test";
import assert from "node:assert/strict";
import {randomBytes,randomUUID,createHash} from "node:crypto";
import {Pool} from "pg";
import {localConfig,connectionString,applicationEnvironment} from "../../scripts/local-config";
import {startNativeDatabase} from "../../scripts/native-database";
import {migrate} from "../../scripts/migrate";
import {provisioningAuth} from "../../lib/collab/auth";
import {database,asUser} from "../../lib/collab/database";
import {createProject} from "../../lib/collab/projects";
import { archiveBranch, archiveImport, archiveManifest, parseHistoryArchive } from "../../lib/collab/history-archive-format";
import { importHistoryArchive, listHistoryArchives, readHistoryArchive, deleteHistoryArchive } from "../../lib/collab/history-archives";
const config=await localConfig(),name=`pi_collab_test_${randomBytes(6).toString("hex")}`,native=await startNativeDatabase(config);
Object.assign(process.env,applicationEnvironment(config),{DATABASE_URL:connectionString(config,false,name)});
const admin=new Pool({connectionString:connectionString(config,true,name)}),organization=randomUUID(),users:string[]=[],password=randomBytes(20).toString("hex");let project:string;
before(async()=>{await migrate(config,name);const auth=provisioningAuth(admin);for(let i=0;i<3;i++)users.push((await auth.api.signUpEmail({body:{email:`history${i}@test.invalid`,name:`History fixture ${i}`,password}})).user.id);
 await admin.query("INSERT INTO collab.organizations(id,name,created_by) VALUES($1,'History fixture',$2)",[organization,users[0]]);
 for(let i=0;i<2;i++)await admin.query("INSERT INTO collab.memberships(organization_id,user_id,role) VALUES($1,$2,$3)",[organization,users[i],i?"member":"owner"]);
 await admin.query('UPDATE public."user" SET "twoFactorEnabled"=true WHERE id=ANY($1)',[users.slice(0,2)]);
 project=(await createProject(users[0],{organizationId:organization,name:"History project",description:""})).id;
 await admin.query("INSERT INTO collab.project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,'developer')",[organization,project,users[1]]);
});
after(async()=>{await Promise.all([admin.end(),database().end()]);globalThis.__piCollabPool=undefined;const cleanup=new Pool({connectionString:connectionString(config,true,"postgres")});await cleanup.query(`DROP DATABASE "${name}" WITH (FORCE)`);await cleanup.end();await native.stop();});

const files = () => [
 {name:"parent.jsonl",source:"\uFEFF"+[
  {type:"session",version:3,id:"source-parent",timestamp:"2026-09-20T00:00:00Z",cwd:"/historical/path"},
  {type:"message",id:"root",parentId:null,message:{role:"user",content:"原始问题"}},
  {type:"message",id:"left",parentId:"root",message:{role:"assistant",content:[{type:"text",text:"First branch"},{type:"thinking",thinking:"Archived thought"}]}},
  {type:"message",id:"tool",parentId:"left",message:{role:"toolResult",content:"inert tool result"}},
  {type:"message",id:"right",parentId:"root",message:{role:"assistant",content:[{type:"text",text:"Alternative branch"},{type:"image",data:"aGVsbG8="}]}},
  {type:"context_edit",id:"edit",parentId:"right",targetId:"root",customData:{retained:true}},
 ].map(v=>JSON.stringify(v)).join("\r\n")+"\r\n"},
 {name:"fork.jsonl",source:[{type:"session",version:3,id:"source-fork",parentSession:"/old/machine/parent.jsonl"},{type:"message",id:"fork-root",parentId:null,message:{role:"system",content:"Historical system only"}},{type:"message",id:"fork-leaf",parentId:"fork-root",message:{role:"user",content:"Fork question"}}].map(v=>JSON.stringify(v)).join("\n")}
];
const input = (shared=false) => ({title:"原始来源与分支",shared,reviewed:true,files:files()});
test("inert archive indexing preserves branch paths, fork links and legacy source without rewriting bytes",()=>{
 const f=files(),tree=parseHistoryArchive(f[0].source);assert.deepEqual(tree.leaves,["tool","edit"]);
 assert.deepEqual(archiveBranch(tree,"edit").map(n=>n.id),["root","right","edit"]);assert.equal(archiveBranch(tree,"tool")[2].text,"inert tool result");
 assert.equal(archiveManifest(f)[1].parentFile,"parent.jsonl");assert.equal(archiveManifest([f[1]])[0].missingParent,true);
 const legacy=JSON.stringify({type:"session",id:"v1"})+"\n"+JSON.stringify({type:"message",message:{role:"user",content:"Legacy"}});
 assert.equal(parseHistoryArchive(legacy).legacy,true);assert.equal(parseHistoryArchive(legacy).nodes[0].id,"line-2");
 for(const source of [f[0].source.replace('"parentId":"root"','"parentId":"absent"'),f[0].source.replace('"id":"left"','"id":"root"'),f[0].source.replace('"version":3','"version":99'),"{bad}"]){assert.throws(()=>parseHistoryArchive(source));}
 assert.equal(archiveImport.safeParse({...input(),files:[...f,f[0]]}).success,false);
 assert.equal(archiveImport.safeParse({...input(),files:[{name:"../escape.jsonl",source:legacy}]}).success,false);
});
test("private and shared multi-file archives round-trip exact UTF-8 bytes, deduplicate parallel imports and never create runs",async()=>{
 const privateInput=input(), accepted=await Promise.all(Array.from({length:8},()=>importHistoryArchive(users[0],project,privateInput)));
 assert.equal(new Set(accepted.map(v=>v.id)).size,1);assert.equal((await listHistoryArchives(users[1],project)).archives.length,0);
 await assert.rejects(readHistoryArchive(users[1],project,accepted[0].id),/不可访问/);
 const shared=await importHistoryArchive(users[0],project,input(true));
 const info=await readHistoryArchive(users[1],project,shared.id);assert.ok(info.files);assert.equal(info.files[0].name,"fork.jsonl");assert.equal(info.files[0].parentFile,"parent.jsonl");
 for(const f of files()){const index=info.files.findIndex(v=>v.name===f.name),download=await readHistoryArchive(users[1],project,shared.id,index);assert.ok("source" in download);assert.equal(download.source,f.source);assert.equal(download.sha256,createHash("sha256").update(f.source).digest("hex"));}
 await assert.rejects(readHistoryArchive(users[2],project,shared.id),/不可访问/);await assert.rejects(deleteHistoryArchive(users[1],project,shared.id),/不可删除/);
 await asUser(users[1],async db=>assert.equal((await db.query("SELECT 1 FROM collab.history_archives WHERE id=$1",[accepted[0].id])).rowCount,0));
 assert.equal((await admin.query("SELECT count(*)::int AS n FROM collab.runs WHERE project_id=$1",[project])).rows[0].n,0);
 const logs=JSON.stringify((await admin.query("SELECT detail FROM collab.audit_events WHERE project_id=$1 AND action LIKE 'history_archive.%'",[project])).rows);assert.equal(logs.includes("historical/path"),false);assert.equal(logs.includes("Archived thought"),false);
 await admin.query("UPDATE collab.project_memberships SET active=false WHERE project_id=$1 AND user_id=$2",[project,users[1]]);await assert.rejects(readHistoryArchive(users[1],project,shared.id,0),/不可访问/);
 await admin.query("UPDATE collab.project_memberships SET active=true WHERE project_id=$1 AND user_id=$2",[project,users[1]]);
 await deleteHistoryArchive(users[0],project,shared.id);await assert.rejects(readHistoryArchive(users[0],project,shared.id),/不可访问/);await deleteHistoryArchive(users[0],project,accepted[0].id);
});
test("archives enforce MFA, review acknowledgement, admission drain and bounded retained storage",async()=>{
 await admin.query('UPDATE public."user" SET "twoFactorEnabled"=false WHERE id=$1',[users[1]]);
 await assert.rejects(importHistoryArchive(users[1],project,input()),/多因素/);
 await admin.query('UPDATE public."user" SET "twoFactorEnabled"=true WHERE id=$1',[users[1]]);
 assert.throws(()=>importHistoryArchive(users[0],project,{...input(),reviewed:false}));
 await admin.query("UPDATE collab_meta.operations SET draining=true");await assert.rejects(importHistoryArchive(users[0],project,input()),/installation_draining/);await admin.query("UPDATE collab_meta.operations SET draining=false");
 assert.throws(()=>importHistoryArchive(users[0],project,{...input(),files:[...files(),{name:"duplicate.jsonl",source:files()[0].source}]}),/重复 session ID/);
 const small=(i:number)=>({title:"Bounded archive",shared:false,reviewed:true,files:[{name:"history.jsonl",source:JSON.stringify({type:"session",version:3,id:`quota-${i}`})}]});
 for(let i=0;i<50;i++)await importHistoryArchive(users[1],project,small(i));
 await assert.rejects(importHistoryArchive(users[1],project,small(51)),/history_archive_quota/);assert.equal((await importHistoryArchive(users[1],project,small(0))).replayed,true);
 const listing=await listHistoryArchives(users[1],project);assert.equal(listing.archives.length,50);await deleteHistoryArchive(users[1],project,listing.archives[0].id);assert.equal((await importHistoryArchive(users[1],project,small(51))).replayed,false);
 await assert.rejects(database().query("UPDATE collab.history_archives SET shared=true"),/permission/);
});
