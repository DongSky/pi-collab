import { createCipheriv,createDecipheriv,randomBytes,createHash } from "node:crypto";
import { createReadStream,createWriteStream,constants } from "node:fs";
import { chmod,lstat,mkdir,mkdtemp,open,readFile,readdir,rename,rm,writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import * as tar from "tar";
import lockfile from "proper-lockfile";
import { z } from "zod";
import type { Pool } from "pg";
import { verifyRelease } from "./release.mjs";

const exec=promisify(execFile),magic=Buffer.from("PICOLLAB-BACKUP-1\n");
const manifestSchema=z.object({version:z.literal(1),root:z.string(),platform:z.string(),arch:z.string(),node:z.string(),postgres:z.string(),commit:z.string(),dirty:z.boolean(),createdAt:z.string(),migrations:z.array(z.object({name:z.string(),hash:z.string()}))}).strict();
export type BackupManifest=z.infer<typeof manifestSchema>;
export async function operationLock(root:string){
 await mkdir(path.dirname(root),{recursive:true,mode:0o700});
 return lockfile.lock(`${root}.operations`,{realpath:false,stale:30000,update:5000,retries:0});
}
export async function migrationFiles(){
 return Promise.all((await readdir("db/migrations")).filter(name=>name.endsWith(".sql")).sort().map(async name=>({name,hash:createHash("sha256").update(await readFile(path.join("db/migrations",name))).digest("hex")})));
}
export async function checkMigrationPrefix(applied:{name:string;hash:string}[]){
 const current=await migrationFiles();
 if(applied.some((row,i)=>current[i]?.name!==row.name||current[i]?.hash!==row.hash))throw new Error("migration_history_mismatch: restore the matching code before continuing");
 return current;
}
export async function assertPrivateFile(file:string){
 const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const stat=await handle.stat();if(!stat.isFile()||(stat.mode&0o077)||stat.uid!==process.getuid?.())throw new Error("private_file_required");return await handle.readFile();}finally{await handle.close();}
}
export async function backupKey(file:string){const bytes=await assertPrivateFile(file);if(bytes.length!==32)throw new Error("backup_key_must_be_32_bytes");return bytes;}
export async function generateBackupKey(file:string){await writeFile(file,randomBytes(32),{flag:"wx",mode:0o600});}
export async function operationInventory(db:Pool){
 const specifications:Record<string,string>={
  "collab.runs":"status NOT IN ('completed','failed','cancelled')",
  "collab.workspaces":"status NOT IN ('stopped','archived')",
  "collab.snapshots":"status='pending'", "collab.validations":"status IN ('queued','running','unknown')",
  "collab.integrations":"status IN ('queued','integrating','checking','unknown')",
  "collab.promotions":"status NOT IN ('applied','aborted')",
  "collab.github_imports":"status NOT IN ('completed','failed')", "collab.github_syncs":"status NOT IN ('completed','failed')",
  "collab.resource_jobs":"NOT stopped", "collab.resource_requests":"status IN ('waiting','granted','releasing')",
  "collab_git.workspace_operations":"status NOT IN ('applied','aborted')",
  "collab_git.push_previews":"status IN ('queued','running')", "collab_git.push_deliveries":"status IN ('queued','running','unknown')",
  "collab_git.pull_proposals":"status IN ('queued','running')", "collab_git.pull_deliveries":"status IN ('queued','running','unknown')",
  "collab_git.pull_observation_jobs":"status IN ('queued','running')", "collab_git.pull_revision_jobs":"status IN ('queued','running')",
  "collab_git.pull_checks_jobs":"status IN ('queued','running')", "collab_git.pull_releases":"status IN ('queued','running','unknown')",
 };
 if((await db.query("SELECT to_regclass('collab.gitlab_operations') AS relation")).rows[0].relation)specifications["collab.gitlab_operations"]="status IN ('queued','running','uncertain')";
 if((await db.query("SELECT to_regclass('collab_worker.artifact_cleanup') AS relation")).rows[0].relation)specifications["collab_worker.artifact_cleanup"]="status IN ('queued','deleting')";
 if((await db.query("SELECT to_regclass('collab.service_previews') AS relation")).rows[0].relation)specifications["collab.service_previews"]="status IN ('queued','starting','ready','stopping','unknown')";
 const active:{resource:string;count:number}[]=[];
 for(const [table,condition] of Object.entries(specifications)){
  const count=Number((await db.query(`SELECT count(*) AS count FROM ${table} WHERE ${condition}`)).rows[0].count);
  if(count)active.push({resource:table,count});
 }
 return {draining:(await db.query("SELECT draining FROM collab_meta.operations WHERE singleton")).rows[0].draining as boolean,active,ready:active.length===0};
}
export async function makeManifest(root:string,applied:BackupManifest["migrations"]):Promise<BackupManifest>{
 const release=await lstat("release-manifest.json").then(()=>verifyRelease(),error=>{if(error.code==="ENOENT")return null;throw error;});
 return {version:1,root:path.resolve(root),platform:process.platform,arch:process.arch,node:process.version,postgres:(await readFile(path.join(root,"postgres/PG_VERSION"),"utf8")).trim(),commit:release?release.commit:(await exec("git",["rev-parse","HEAD"])).stdout.trim(),dirty:release?false:!!(await exec("git",["status","--porcelain"])).stdout.trim(),createdAt:new Date().toISOString(),migrations:applied};
}
function outside(root:string,target:string){const relative=path.relative(root,path.resolve(target));return relative===".."||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative);}
async function absent(file:string){try{await lstat(file);return false;}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return true;throw e;}}
export async function assertCold(root:string){
 if(!await absent(path.join(root,"postgres/postmaster.pid")))throw new Error("postgres_must_be_stopped");
 for(const kind of ["runtime-receipts","container-receipts"]){const receipts=path.join(root,kind);
 if(!await absent(receipts))for(const name of await readdir(receipts))if(name.endsWith(".json")){
  const receipt=JSON.parse(await readFile(path.join(receipts,name),"utf8"));
  if(receipt.state!=="stopped")throw new Error("unconfirmed_runtime_receipt: reconcile before backup");
 }}
}
/** Cold physical backup: database, repositories, snapshots, local config and master keys in one authenticated envelope. */
export async function writeBackup(root:string,output:string,key:Buffer,manifest:BackupManifest){
 root=path.resolve(root);output=path.resolve(output);
 if(!outside(root,output))throw new Error("backup_must_be_outside_data_root");
 await assertCold(root);
 const header=Buffer.from(JSON.stringify(manifest)),length=Buffer.alloc(4);length.writeUInt32BE(header.length);
 const nonce=randomBytes(12),cipher=createCipheriv("aes-256-gcm",key,nonce),aad=Buffer.concat([magic,length,header,nonce]);cipher.setAAD(aad);
 const handle=await open(output,"wx",0o600);
 let success=false;
 try{
  await handle.write(aad);
  const stream=tar.c({cwd:root,gzip:true,portable:false,noDirRecurse:false,filter:(entry,stat)=>{
   const relative=entry.replace(/^\.\/?/,"");
   if(relative==="socket"||relative.startsWith("socket/"))return false;
   if("isSymbolicLink" in stat && stat.isSymbolicLink())return true; // Archive links as links, never dereference them.
   if("isDirectory" in stat && !stat.isDirectory()&&!stat.isFile())throw new Error("backup_special_file_not_supported");
   return true;
  }},["."]);
  await pipeline(stream,cipher,createWriteStream(output,{fd:handle.fd,autoClose:false,start:aad.length}));
  const size=(await handle.stat()).size;await handle.write(cipher.getAuthTag(),0,16,size);await handle.sync();success=true;
 }finally{await handle.close();if(!success)await rm(output,{force:true});}
}
export async function readBackupManifest(file:string){
 const h=await open(file,"r");try{const fixed=Buffer.alloc(magic.length+4);if((await h.read(fixed,0,fixed.length,0)).bytesRead!==fixed.length||!fixed.subarray(0,magic.length).equals(magic))throw new Error("invalid_backup_header");const length=fixed.readUInt32BE(magic.length);if(length>1024*1024)throw new Error("invalid_backup_header");const data=Buffer.alloc(length);if((await h.read(data,0,length,fixed.length)).bytesRead!==length)throw new Error("invalid_backup_header");return {manifest:manifestSchema.parse(JSON.parse(data.toString())),headerSize:fixed.length+length};}finally{await h.close();}
}
/** Returns a private verified staging tree; caller publishes only after authentication and compatibility checks. */
export async function stageRestore(file:string,key:Buffer,destination:string){
 destination=path.resolve(destination);
 const {manifest,headerSize}=await readBackupManifest(file);
 if(manifest.root!==destination)throw new Error("restore_requires_original_absolute_path");
 if(manifest.platform!==process.platform||manifest.arch!==process.arch)throw new Error("physical_backup_platform_mismatch");
 await checkMigrationPrefix(manifest.migrations);
 const stage=await mkdtemp(path.join(path.dirname(destination),".pi-collab-restore-"));await chmod(stage,0o700);
 try{
  const h=await open(file,"r");let prefix:Buffer,tag:Buffer,size:number;
  try{size=(await h.stat()).size;if(size<headerSize+28)throw new Error("invalid_backup_size");prefix=Buffer.alloc(headerSize+12);tag=Buffer.alloc(16);await h.read(prefix,0,prefix.length,0);await h.read(tag,0,16,size-16);}finally{await h.close();}
  const cipher=createDecipheriv("aes-256-gcm",key,prefix.subarray(headerSize));cipher.setAAD(prefix);cipher.setAuthTag(tag);
  const archive=path.join(stage,"verified.tar.gz"),tree=path.join(stage,"data");
  await pipeline(createReadStream(file,{start:headerSize+12,end:size-17}),cipher,createWriteStream(archive,{flags:"wx",mode:0o600}));
  await mkdir(tree,{mode:0o700});
  // node-tar rejects absolute/.. paths and traversal through earlier symlinks. No special devices accepted.
  await tar.x({file:archive,cwd:tree,strict:true,preserveOwner:false,filter:(_name,entry)=>{
   if("type" in entry && !["Directory","File","OldFile","SymbolicLink","Link"].includes(entry.type))throw new Error("unsupported_backup_entry");
   return true;
  }});
  await rm(archive);await assertCold(tree);
  if((await readFile(path.join(tree,"postgres/PG_VERSION"),"utf8")).trim()!==manifest.postgres)throw new Error("backup_database_version_mismatch");
  return {stage,tree,manifest};
 }catch(e){await rm(stage,{recursive:true,force:true});throw e;}
}
export async function publishRestore(tree:string,destination:string){
 if(!await absent(destination))throw new Error("restore_destination_exists: retain the old data directory first");
 await rename(tree,destination);
}
