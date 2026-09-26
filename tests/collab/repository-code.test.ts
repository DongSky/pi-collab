import test,{before,after} from "node:test";
import assert from "node:assert/strict";
import {randomBytes,randomUUID} from "node:crypto";
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {Pool} from "pg";
import {localConfig,applicationEnvironment,connectionString} from "../../scripts/local-config";
import {startNativeDatabase} from "../../scripts/native-database";
import {migrate} from "../../scripts/migrate";
import {provisioningAuth} from "../../lib/collab/auth";
import {database} from "../../lib/collab/database";
import {createProject} from "../../lib/collab/projects";
import {importLocalRepository} from "../../lib/collab/repository-import";
import {repositoryCode,type RepositoryCodeTree,type RepositoryCodeFile} from "../../lib/collab/repository-code";
const config=await localConfig(),name=`pi_collab_test_${randomBytes(6).toString('hex')}`,native=await startNativeDatabase(config);
const root=await mkdtemp(path.join(tmpdir(),'pi-collab-code-')),source=path.join(root,'source'),exec=promisify(execFile);
Object.assign(process.env,applicationEnvironment(config),{DATABASE_URL:connectionString(config,false,name),PI_COLLAB_DATA_DIR:root});
const admin=new Pool({connectionString:connectionString(config,true,name)}),users:string[]=[],org=randomUUID();
let project:string,repo:{id:string;baseSha:string;defaultBranch:string};
before(async()=>{
 await migrate(config,name);const auth=provisioningAuth(admin);
 for(let i=0;i<3;i++)users.push((await auth.api.signUpEmail({body:{name:`Code ${i}`,email:`code${i}@test.invalid`,password:randomBytes(20).toString('hex')}})).user.id);
 await admin.query("INSERT INTO collab.organizations(id,name,created_by) VALUES($1,'Code test',$2)",[org,users[0]]);
 for(let i=0;i<2;i++)await admin.query("INSERT INTO collab.memberships(organization_id,user_id,role) VALUES($1,$2,$3)",[org,users[i],i?'member':'owner']);
 await admin.query('UPDATE public."user" SET "twoFactorEnabled"=true WHERE id=$1',[users[0]]);
 project=(await createProject(users[0],{organizationId:org,name:'Code browser',description:''})).id;
 await admin.query("INSERT INTO collab.project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,'viewer')",[org,project,users[1]]);
 await mkdir(path.join(source,'src/nested'),{recursive:true});
 for(const args of [['init'],['config','user.name','Code test'],['config','user.email','code@test.invalid']])await exec('git',args,{cwd:source});
 await writeFile(path.join(source,'src/nested/code.ts'),'export const answer = 42;\r\n');await writeFile(path.join(source,'README.md'),'# Hello code\n');
 await writeFile(path.join(source,'.env'),'PRIVATE=do-not-show');await writeFile(path.join(source,'binary.bin'),Buffer.from([0,255,1]));
 await writeFile(path.join(source,'credential.txt'),'Authorization: Bearer '+ 'a'.repeat(48));await writeFile(path.join(source,'large.txt'),'x'.repeat(262145));
 await symlink('README.md',path.join(source,'link.txt'));await exec('git',['add','.'],{cwd:source});await exec('git',['commit','-m','Code fixture'],{cwd:source});
 repo=await importLocalRepository(admin,root,{projectId:project,actorId:users[0],source,name:'Code repository'});
});
after(async()=>{await database().end();globalThis.__piCollabPool=undefined;await admin.end();const cleanup=new Pool({connectionString:connectionString(config,true,'postgres')});await cleanup.query(`DROP DATABASE "${name}" WITH (FORCE)`);await cleanup.end();await native.stop();await rm(root,{recursive:true,force:true});});
test('authorized viewer browses complete baseline before any AI run, preserving exact text and source',async()=>{
 const tree=await repositoryCode(users[1],repo.id,{}) as RepositoryCodeTree;
 assert.equal(tree.revision,repo.baseSha);assert.ok(tree.files.some(f=>f.path==='src/nested/code.ts'));
 assert.ok(!tree.files.some(f=>f.path==='.env'||f.path==='link.txt'));assert.equal(tree.omitted,2);
 const file=await repositoryCode(users[1],repo.id,{path:'src/nested/code.ts',revision:tree.revision}) as RepositoryCodeFile;
 assert.equal(file.text,'export const answer = 42;\r\n');assert.equal(await readFile(path.join(source,'src/nested/code.ts'),'utf8'),file.text);
 assert.equal((await admin.query('SELECT count(*) FROM collab.runs')).rows[0].count,'0');
});
test('guessed repositories, stale revisions, private paths, binary, credentials and oversized contents are denied',async()=>{
 await assert.rejects(repositoryCode(users[2],repo.id,{}),/访问权限/);
 await assert.rejects(repositoryCode(users[1],randomUUID(),{}),/访问权限/);
 await assert.rejects(repositoryCode(users[1],repo.id,{revision:'0'.repeat(40)}),/基线已更新/);
 for(const file of ['../config.json','.env','link.txt','binary.bin','credential.txt','large.txt','README.md:HEAD','missing.txt'])await assert.rejects(repositoryCode(users[1],repo.id,{path:file}),/不可读取/);
});
test('revoked membership clears baseline access and regrant authorizes a fresh request',async()=>{
 await admin.query('UPDATE collab.project_memberships SET active=false WHERE project_id=$1 AND user_id=$2',[project,users[1]]);
 await assert.rejects(repositoryCode(users[1],repo.id,{path:'README.md'}),/访问权限/);
 await admin.query('UPDATE collab.project_memberships SET active=true WHERE project_id=$1 AND user_id=$2',[project,users[1]]);
 assert.equal((await repositoryCode(users[1],repo.id,{path:'README.md'}) as RepositoryCodeFile).text,'# Hello code\n');
});
test('managed repository alternates are refused instead of reading external objects',async()=>{
 const alternate=path.join(root,'repositories',repo.id,'git/objects/info/alternates');await writeFile(alternate,path.join(source,'.git/objects'));
 try{await assert.rejects(repositoryCode(users[1],repo.id,{}),/不可读取/);}finally{await rm(alternate);}
 assert.ok((await repositoryCode(users[1],repo.id,{}) as RepositoryCodeTree).files.length);
});
