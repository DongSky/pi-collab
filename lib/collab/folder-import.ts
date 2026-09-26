import path from "node:path";
import { createHash,randomUUID } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { mkdir,writeFile,rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { asUser } from "./database";
import { projectRole,uuid } from "./projects";
import { DomainError } from "./policy";
import { folderInput,folderExclusion,FOLDER_TOTAL_LIMIT,FOLDER_FILE_LIMIT,type FolderImportResult } from "./folder-import-schema";
import { captureSnapshot,snapshotSummary,snapshotHasSecret } from "./runtime/snapshots";
import { createWorkspace,runnerEnvironment } from "./runtime/workspace";
import { measureWorkspace } from "./runtime/storage-meter";
const exec=promisify(execFile);
export async function importFolder(userId:string,projectId:string,raw:unknown):Promise<FolderImportResult>{
 uuid.parse(projectId);
 // Authorize before decoding file contents or touching the server filesystem.
 await asUser(userId,db=>projectRole(db,projectId,"task.create"));
 const input=folderInput.parse(raw),seen=new Set<string>(),excluded:{path:string;reason:string}[]=[],files:{path:string;bytes:Buffer}[]=[];
 let total=0;
 for(const f of input.files){
  const key=f.path.normalize("NFC").toLowerCase();
  if(seen.has(key))throw new DomainError("folder_path_collision","文件夹中存在重复或仅大小写不同的路径。",400);seen.add(key);
  const reason=folderExclusion(f.path);if(reason)throw new DomainError("folder_path_invalid",`不允许导入路径：${f.path}（${reason}）`,400);
  const bytes=Buffer.from(f.data,"base64");total+=bytes.length;
  if(bytes.length>FOLDER_FILE_LIMIT||total>FOLDER_TOTAL_LIMIT)throw new DomainError("folder_limit","文件夹超过限制：单文件 2 MiB，总计 32 MiB。",413);
  if(snapshotHasSecret(bytes)){excluded.push({path:f.path,reason:"疑似包含凭据"});continue;}
  files.push({path:f.path,bytes});
 }
 if(!files.length)throw new DomainError("folder_empty","没有可导入的文件。",400);
 for(const f of files){let parent=path.posix.dirname(f.path);while(parent!=="."){if(seen.has(parent.normalize("NFC").toLowerCase()))throw new DomainError("folder_path_collision","文件与目录路径冲突。",400);parent=path.posix.dirname(parent);}}
 const fingerprint=createHash("sha256").update(JSON.stringify(input)).digest("hex"),root=path.resolve(process.env.PI_COLLAB_DATA_DIR??".local");
 const firstFile=files.find(f=>f.bytes.length<=262144&&isUtf8(f.bytes)&&!f.bytes.includes(0))?.path??null;
 return asUser(userId,async db=>{
  await projectRole(db,projectId,"task.create");
  // Serialize imports for this project, including disk work, to bound storage and retries.
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,814))",[projectId]);
  const old=(await db.query("SELECT fingerprint,result FROM collab.folder_imports WHERE project_id=$1 AND actor_id=$2 AND request_key=$3",[projectId,userId,input.requestKey])).rows[0];
  if(old){if(old.fingerprint!==fingerprint)throw new DomainError("idempotency_conflict","同一请求编号的文件已改变，请重新选择文件夹。",409);return {...old.result,firstFile,excluded};}
  const ids={repositoryId:randomUUID(),taskId:randomUUID(),workspaceId:randomUUID(),runId:randomUUID(),snapshotId:randomUUID()};
  const staging=path.join(root,"folder-intake",ids.repositoryId),repo=path.join(root,"repositories",ids.repositoryId),work=path.join(root,"workspaces",ids.workspaceId),snapshot=path.join(root,"snapshots",ids.snapshotId);
  let registered=false;
  try{
   await mkdir(staging,{recursive:true,mode:0o700});
   const env=runnerEnvironment(path.join(staging,".unused-home"),path.join(staging,".unused-agent"));
   const git=(args:string[])=>exec("git",["-c","core.hooksPath=/dev/null","-c","core.fsmonitor=false",...args],{env,timeout:30000,maxBuffer:1024*1024});
   await git(["init","--initial-branch=main",staging]);
   await writeFile(path.join(staging,".git","info","attributes"),"* -text -eol -filter -ident -working-tree-encoding\n",{mode:0o600});
   for(const f of files){const target=path.join(staging,f.path);await mkdir(path.dirname(target),{recursive:true,mode:0o700});await writeFile(target,f.bytes,{flag:"wx",mode:0o600});}
   await git(["-C",staging,"add","--force","--all"]);
   await git(["-C",staging,"-c","user.name=pi-collab import","-c","user.email=import@pi-collab.local","commit","-m","Import selected folder"]);
   const base=(await git(["-C",staging,"rev-parse","HEAD"])).stdout.trim();
   await mkdir(repo,{recursive:true,mode:0o700});await git(["clone","--bare","--no-local","--",staging,path.join(repo,"git")]);await git(["-C",path.join(repo,"git"),"remote","remove","origin"]);
   await writeFile(path.join(repo,"git","pi-collab-folder-import"),"1\n",{flag:"wx",mode:0o600});
   await createWorkspace(root,ids.workspaceId,path.join(repo,"git"),base,true);
   const saved=await captureSnapshot(root,{id:ids.snapshotId,runId:ids.runId,workspaceId:ids.workspaceId,repositoryId:ids.repositoryId,baseSha:base,note:`导入工作文件夹：${input.name}`,context:{title:`编辑文件夹：${input.name}`,description:"浏览器选择的工作文件夹副本",acceptance:"检查修改并保存",prompt:"导入文件夹，未调用 AI",status:"completed"}});
   const usage=await measureWorkspace(root,ids.workspaceId);if(usage.error||usage.bytes===null)throw new Error("无法确认工作目录用量");
   const result=(await db.query("SELECT collab.register_folder($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS result",[projectId,input.requestKey,fingerprint,input.name,ids,base,saved.manifestHash,snapshotSummary(saved.manifest),total,usage.bytes])).rows[0].result;
   registered=true;return {...result,firstFile,excluded};
  }finally{
   await rm(staging,{recursive:true,force:true});
   // Once registered, retain artifacts even if COMMIT acknowledgement is lost.
   if(!registered)await Promise.all([repo,work,snapshot].map(p=>rm(p,{recursive:true,force:true})));
  }
 });
}
