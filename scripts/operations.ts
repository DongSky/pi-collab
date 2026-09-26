import { DEFAULT_RUNNER_IMAGE } from "../lib/collab/runtime/container-image";
import { masterKey } from "../lib/collab/gateway/credentials";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile,rm,rename,lstat,mkdir } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { parseArgs } from "node:util";
import { applicationEnvironment,connectionString,dataRoot,localConfig } from "./local-config";
import { startNativeDatabase } from "./native-database";
import { migrate } from "./migrate";
import { nativeBootId } from "../lib/collab/runtime/receipts";
import { assertCold,assertPrivateFile,backupKey,checkMigrationPrefix,generateBackupKey,makeManifest,operationInventory,operationLock,publishRestore,stageRestore,writeBackup } from "./operations-core";
const exec=promisify(execFile);
const {positionals,values}=parseArgs({allowPositionals:true,options:{file:{type:"string"},key:{type:"string"},reason:{type:"string"},"retain-current":{type:"boolean"}}});
const command=positionals[0],file=values.file?path.resolve(values.file):undefined,keyFile=values.key?path.resolve(values.key):undefined;
function requireFiles(){if(!file||!keyFile)throw new Error("--file BACKUP --key PRIVATE_KEY are required");if(!path.relative(dataRoot,keyFile).startsWith(`..${path.sep}`))throw new Error("Keep the backup key outside the data root");return {file,keyFile};}
async function main(){
 if(command==="keygen"){if(!keyFile)throw new Error("--key FILE is required");await generateBackupKey(keyFile);console.log("Created a private backup key. Keep a separate offline copy; its bytes are never printed.");return;}
 if(command==="restore"||command==="rollback"){
  const paths=requireFiles(),release=await operationLock(dataRoot),key=await backupKey(paths.keyFile);
  try{
   await mkdir(path.dirname(dataRoot),{recursive:true,mode:0o700});
   const restored=await stageRestore(paths.file,key,dataRoot);
   try{
    let exists=true;try{await lstat(dataRoot);}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")exists=false;else throw e;}
    let retained:string|undefined;
    if(exists){
     if(command!=="rollback"||!values["retain-current"])throw new Error("Destination exists. Rollback requires --retain-current; original data will be preserved.");
     await assertCold(dataRoot);
     retained=`${dataRoot}.retained-${Date.now()}`;await rename(dataRoot,retained);
    }
    try{await publishRestore(restored.tree,dataRoot);}catch(e){if(retained)await rename(retained,dataRoot);throw e;}
    console.log(JSON.stringify({restored:true,backupCode:restored.manifest.commit,backupCodeWasDirty:restored.manifest.dirty,retained:retained??null,next:"Run ops:check and ops:upgrade with the intended code version, then start and ops:resume. Database down-migrations are never run."}));
   }finally{await rm(restored.stage,{recursive:true,force:true});}
  }finally{key.fill(0);await release();}return;
 }
 const config=await localConfig();Object.assign(process.env,applicationEnvironment(config));
 if(["status","drain","resume","stop"].includes(command)){
  const db=new Pool({connectionString:connectionString(config,true),connectionTimeoutMillis:3000});
  try{
   if(command==="drain"||command==="resume"){
    if(!values.reason||values.reason.trim().length<10)throw new Error("--reason must contain at least 10 characters");
    await db.query("UPDATE collab_meta.operations SET draining=$1,reason=$2,updated_at=now() WHERE singleton",[command==="drain",values.reason.trim()]);
   }
   const inventory=await operationInventory(db);console.log(JSON.stringify(inventory));
   if(command==="stop"){
    if(!inventory.draining||!inventory.ready)throw new Error("Drain and resolve outstanding work before stopping");
    const record=JSON.parse(await readFile(path.join(dataRoot,"supervisor.json"),"utf8"));
    if(record.bootId!==await nativeBootId()||record.cwd!==process.cwd()||!Number.isInteger(record.pid)||record.pid<2)throw new Error("supervisor_identity_mismatch");
    const processName=(await exec("ps",["-p",String(record.pid),"-o","command="])).stdout;
    if(!processName.includes("scripts/dev-local.ts")&&!processName.includes("scripts/dev-docker.ts"))throw new Error("supervisor_identity_mismatch");
    await db.end();process.kill(record.pid,"SIGTERM");console.log("Graceful stop requested for the recorded local supervisor. Wait for it to exit before backup.");return;
   }
  }finally{if(!db.ended)await db.end();}return;
 }
 if(!["check","backup","upgrade"].includes(command))throw new Error("Usage: operations.ts keygen|check|status|drain|stop|backup|restore|rollback|upgrade|resume");
 const release=await operationLock(dataRoot);
 try{
  await assertPrivateFile(path.join(dataRoot,"config.json"));
  if(Number(process.versions.node.split(".")[0])<22)throw new Error("Node 22.19+ is required");
  await exec("git",["--version"]);
  const native=await startNativeDatabase(config);
  if(!native.owned)throw new Error("Stop all services including PostgreSQL before this operation");
  const db=new Pool({connectionString:connectionString(config,true),connectionTimeoutMillis:3000});
  let manifest:Awaited<ReturnType<typeof makeManifest>>|undefined;
  try{
   if(command==="upgrade"){
    const bootstrap=new Pool({connectionString:connectionString(config,true,"postgres")});
    let installed=false;
    try{installed=!!(await bootstrap.query("SELECT 1 FROM pg_database WHERE datname='pi_collab'")).rowCount;}finally{await bootstrap.end();}
    if(installed){const exists=(await db.query("SELECT to_regclass('collab_meta.operations') AS present")).rows[0].present;
     if(exists){const state=await operationInventory(db);if(!state.draining||!state.ready)throw new Error("Drain all work before applying migrations");}
    }
    await migrate(config);
    // Explicit cold administration initializes the resource key only before any
    // encrypted resource credentials exist. A lost key is never replaced.
    const credentials=!!(await db.query("SELECT 1 FROM collab_broker.credentials LIMIT 1")).rowCount;
    const resourceKey=await masterKey(process.env.PI_COLLAB_RESOURCE_KEY_FILE??path.join(dataRoot,"resource-master.key"),!credentials);
    resourceKey.fill(0);
   }
   const applied=(await db.query("SELECT name,hash FROM collab_meta.migrations ORDER BY name")).rows;
   const available=await checkMigrationPrefix(applied);
   const inventory=await operationInventory(db);
   const checks={native:true,node:process.version,postgres:(await db.query("SHOW server_version")).rows[0].server_version,migrationsApplied:applied.length,migrationsAvailable:available.length,...inventory};
   if(command==="backup"){
    if(!inventory.draining||!inventory.ready)throw new Error("Drain and resolve all active or uncertain work before backup");
    if((await db.query("SELECT 1 FROM pg_stat_activity WHERE backend_type='client backend' AND pid<>pg_backend_pid()")).rowCount)throw new Error("Other database clients are still connected");
    for(const [variable,name] of [["PI_COLLAB_MODEL_MASTER_KEY_FILE","model-master.key"],["PI_COLLAB_RESOURCE_KEY_FILE","resource-master.key"],["PI_COLLAB_GIT_KEY_FILE","git-master.key"]]){
     if(process.env[variable]&&path.resolve(process.env[variable]!)!==path.join(dataRoot,name))throw new Error("External key configuration requires a separately managed backup procedure");
     try{await lstat(path.join(dataRoot,name));await assertPrivateFile(path.join(dataRoot,name));}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
    }
    manifest=await makeManifest(dataRoot,applied);
   }
   console.log(JSON.stringify(checks));
  }finally{await db.end();await native.stop();}
  if(manifest){const paths=requireFiles(),key=await backupKey(paths.keyFile);try{await writeBackup(dataRoot,paths.file,key,manifest);console.log("Encrypted cold backup complete. Includes database, workspaces, snapshots, config and local master keys.");}finally{key.fill(0);}}
  if(command==="check"&&process.env.PI_COLLAB_RUNTIME==="docker"){
   await exec("docker",["image","inspect",DEFAULT_RUNNER_IMAGE,"--format","{{.Id}}"],{timeout:10000});console.log("Docker image available; runtime parity must be verified separately.");
  }
 }finally{await release();}
}
await main().catch(error=>{const message=error instanceof Error?error.message:"operation_failed";console.error(message.replace(/postgres(?:ql)?:\/\/[^\s]+/g,"[database connection redacted]"));process.exit(1);});
