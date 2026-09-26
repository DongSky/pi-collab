import test from "node:test";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {mkdtemp,mkdir,writeFile,readFile,rm,rename,symlink,readlink,stat} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {writeBackup,stageRestore,publishRestore,operationLock,assertCold,type BackupManifest} from "../../scripts/operations-core";
test("encrypted cold backup restores exact data and rejects wrong keys, corruption, live writers and overwrites",async()=>{
 const temp=await mkdtemp(path.join(os.tmpdir(),"collab-backup-")),root=path.join(temp,"data"),file=path.join(temp,"backup.pcb"),key=randomBytes(32);
 try{
  await mkdir(path.join(root,"postgres"),{recursive:true});await writeFile(path.join(root,"postgres/PG_VERSION"),"18\n");await writeFile(path.join(root,"model-master.key"),randomBytes(32),{mode:0o600});await writeFile(path.join(root,"config.json"),"fixture-sensitive-content",{mode:0o600});await symlink("config.json",path.join(root,"config-link"));
  const manifest:BackupManifest={version:1,root,platform:process.platform,arch:process.arch,node:process.version,postgres:"18",commit:"fixture",dirty:true,createdAt:new Date().toISOString(),migrations:[]};
  const release=await operationLock(root);await assert.rejects(operationLock(root),/already being held/);await release();
  await writeFile(path.join(root,"postgres/postmaster.pid"),"123");await assert.rejects(writeBackup(root,file,key,manifest),/must_be_stopped/);await rm(path.join(root,"postgres/postmaster.pid"));
  await writeBackup(root,file,key,manifest);const encrypted=await readFile(file);assert.equal(encrypted.includes(Buffer.from("fixture-sensitive-content")),false);
  await assert.rejects(stageRestore(file,randomBytes(32),root));await assert.rejects(stageRestore(file,key,path.join(temp,"other")),/absolute_path/);
  const restored=await stageRestore(file,key,root);try{await assert.rejects(publishRestore(restored.tree,root),/destination_exists/);await rename(root,`${root}.previous`);await publishRestore(restored.tree,root);}finally{await rm(restored.stage,{recursive:true,force:true});}
  assert.equal(await readFile(path.join(root,"config.json"),"utf8"),"fixture-sensitive-content");assert.equal(await readlink(path.join(root,"config-link")),"config.json");assert.equal((await stat(path.join(root,"model-master.key"))).mode&0o077,0);assert.deepEqual(await readFile(path.join(root,"model-master.key")),await readFile(path.join(`${root}.previous`,"model-master.key")));
  encrypted[encrypted.length-1]^=1;const corrupt=path.join(temp,"corrupt.pcb");await writeFile(corrupt,encrypted);await assert.rejects(stageRestore(corrupt,key,root));
  await mkdir(path.join(root,"runtime-receipts"));await writeFile(path.join(root,"runtime-receipts/run.json"),JSON.stringify({state:"started"}));await assert.rejects(assertCold(root),/unconfirmed_runtime/);
 }finally{key.fill(0);await rm(temp,{recursive:true,force:true});}
});
test("CLI performs a real PostgreSQL cold backup and restores a separately retained installation",{timeout:120000},async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),"pco-")),root=path.join(directory,"data"),key=path.join(directory,"backup.key"),file=path.join(directory,"backup.pcb"),exec=promisify(execFile);
 const run=(script:string,args:string[])=>exec(process.execPath,["--import","tsx",script,...args],{env:{...process.env,PI_COLLAB_DATA_DIR:root},timeout:60000,maxBuffer:2*1024*1024});
 try{
  await run("scripts/e2e-operations-worker.ts",["configure"]);await run("scripts/operations.ts",["upgrade"]);await run("scripts/e2e-operations-worker.ts",["initialize"]);await run("scripts/operations.ts",["keygen","--key",key]);
  const backup=await run("scripts/operations.ts",["backup","--file",file,"--key",key]);assert.match(backup.stdout,/Encrypted cold backup complete/);
  await assert.rejects(run("scripts/operations.ts",["restore","--file",file,"--key",key]),/Destination exists/);
  await run("scripts/operations.ts",["rollback","--file",file,"--key",key,"--retain-current"]);
  const result=await run("scripts/e2e-operations-worker.ts",["verify"]);assert.match(result.stdout,/PASS: restored PostgreSQL/);
  await run("scripts/operations.ts",["upgrade"]);await run("scripts/operations.ts",["check"]);
 }finally{await rm(directory,{recursive:true,force:true});}
});
