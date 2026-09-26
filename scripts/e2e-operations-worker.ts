import { createServer } from "node:net";
import { randomBytes,randomUUID } from "node:crypto";
import { writeFile,readFile,mkdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { dataRoot,localConfig,connectionString,applicationEnvironment } from "./local-config";
import { startNativeDatabase } from "./native-database";
import { migrate } from "./migrate";
import { provisioningAuth } from "../lib/collab/auth";
import { registerModelProfile } from "../lib/collab/gateway/profiles";
import { openCredential } from "../lib/collab/gateway/credentials";
if(!dataRoot.includes("pco-"))throw new Error("Only disposable operations fixture directories are allowed");
const mode=process.argv[2],config=await localConfig();
if(mode==="initialize"||mode==="configure"){
 const port=async()=>{const server=createServer();await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const result=(server.address() as {port:number}).port;await new Promise<void>(r=>server.close(()=>r()));return result;};
 config.databasePort=await port();config.port=await port();config.gatewayPort=await port();await writeFile(path.join(dataRoot,"config.json"),JSON.stringify(config),{mode:0o600});
}
if(mode==="configure"){console.log("Configured disposable ports.");process.exit(0);}
Object.assign(process.env,applicationEnvironment(config));
const native=await startNativeDatabase(config),pool=new Pool({connectionString:connectionString(config,true)});
try{
 if(mode==="initialize"){
  await migrate(config);const password=randomBytes(20).toString("hex"),user=(await provisioningAuth(pool).api.signUpEmail({body:{email:"backup@test.invalid",name:"Backup fixture",password}})).user.id,organization=randomUUID(),project=randomUUID(),key=randomBytes(32);
  await pool.query("INSERT INTO collab.organizations(id,name,created_by) VALUES($1,'Backup fixture',$2)",[organization,user]);await pool.query("INSERT INTO collab.memberships(organization_id,user_id,role) VALUES($1,$2,'owner')",[organization,user]);await pool.query('UPDATE public."user" SET "twoFactorEnabled"=true WHERE id=$1',[user]);await pool.query("INSERT INTO collab.projects(id,organization_id,name,created_by) VALUES($1,$2,'Restored project',$3)",[project,organization,user]);await pool.query("INSERT INTO collab.project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,'maintainer')",[organization,project,user]);
  const profile=await registerModelProfile(pool,key,{projectId:project,actorId:user,name:"Encrypted fixture",modelId:"fixture"},{apiKey:"backup-fixture-provider-key",baseUrl:"http://127.0.0.1:9/v1"});
  await writeFile(path.join(dataRoot,"model-master.key"),key,{mode:0o600});await writeFile(path.join(dataRoot,"fixture-state.json"),JSON.stringify({user,project,profile:profile.id,password}),{mode:0o600});
  await mkdir(path.join(dataRoot,"snapshot-fixture"));await writeFile(path.join(dataRoot,"snapshot-fixture/code.ts"),"export const restored = 42;\n");
  await pool.query("UPDATE collab_meta.operations SET draining=true,reason='Disposable disaster recovery fixture'");console.log("Initialized disposable recovery fixture.");
 }else if(mode==="verify"){
  const state=JSON.parse(await readFile(path.join(dataRoot,"fixture-state.json"),"utf8"));assert.equal((await pool.query("SELECT name FROM collab.projects WHERE id=$1",[state.project])).rows[0].name,"Restored project");
  const sealed=(await pool.query("SELECT sealed FROM collab_gateway.credentials WHERE profile_id=$1",[state.profile])).rows[0].sealed;
  assert.equal(openCredential(await readFile(path.join(dataRoot,"model-master.key")),state.profile,state.project,sealed).apiKey,"backup-fixture-provider-key");
  assert.equal(await readFile(path.join(dataRoot,"snapshot-fixture/code.ts"),"utf8"),"export const restored = 42;\n");assert.equal((await pool.query("SELECT draining FROM collab_meta.operations")).rows[0].draining,true);console.log("PASS: restored PostgreSQL project, encrypted provider credential, code bytes and drain state.");
 }else throw new Error("Unsupported fixture mode");
}finally{await pool.end();await native.stop();}
