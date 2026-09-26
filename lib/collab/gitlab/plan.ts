import {createHash} from "node:crypto";
import {constants} from "node:fs";
import {mkdir,open,lstat} from "node:fs/promises";
import path from "node:path";
import {isUtf8} from "node:buffer";
import {z} from "zod";
import {loadSnapshot,snapshotBaselineChanges,snapshotHasSecret} from "../runtime/snapshots";
import {ReviewGit} from "../runtime/review-git";
import {managedGit} from "../git/github-pack";
import {PreparedTaskPush,taskPushRef} from "../git/task-push-protocol";
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const source=z.object({id:z.uuid(),taskId:z.uuid(),snapshotId:z.uuid(),manifestHash:z.string().regex(/^[a-f0-9]{64}$/),repositoryId:z.uuid(),title:z.string().min(1).max(200)}).strict();
export type GitLabPlanSource=z.infer<typeof source>;
export type GitLabPlan={source:GitLabPlanSource;baseSha:string;commitSha:string;branch:string;changes:{path:string;kind:string;before:string|null;after:string|null}[];excluded:{path:string;reason:string}[]};
const directory=(root:string,id:string)=>path.join(root,'gitlab-operations',z.uuid().parse(id));
const metadata={GIT_AUTHOR_NAME:'pi-collab',GIT_AUTHOR_EMAIL:'gitlab@pi-collab.local',GIT_COMMITTER_NAME:'pi-collab',GIT_COMMITTER_EMAIL:'gitlab@pi-collab.local',GIT_AUTHOR_DATE:'2000-01-01T00:00:00Z',GIT_COMMITTER_DATE:'2000-01-01T00:00:00Z'};
async function save(file:string,bytes:Buffer|string){const f=await open(file,'wx',0o600);try{await f.writeFile(bytes);await f.sync();}finally{await f.close();}}
export async function prepareGitLabPlan(root:string,raw:GitLabPlanSource,signal:AbortSignal){
 const input=source.parse(raw),loaded=await loadSnapshot(root,input.snapshotId,input.manifestHash),diff=await snapshotBaselineChanges(root,input.snapshotId,input.manifestHash),manifest=loaded.manifest;
 if(manifest.repositoryId!==input.repositoryId||!diff.changes.length||diff.changes.length>100)throw new Error('gitlab_plan_limit');
 const repo=path.join(root,'repositories',input.repositoryId,'git'),reader=await ReviewGit.open(root,['repositories',input.repositoryId,'git'],signal),dir=directory(root,input.id),git=path.join(dir,'git');
 await mkdir(path.dirname(dir),{recursive:true,mode:0o700});await mkdir(dir,{mode:0o700});await managedGit(dir,['init','--bare','--template=','git'],signal);
 const pack=(await managedGit(repo,['pack-objects','--stdout','--revs','--no-reuse-delta','--no-reuse-object'],signal,{input:`${manifest.baseSha}\n`,limit:64*1024*1024})).bytes;
 await managedGit(git,['index-pack','--stdin','--strict'],signal,{input:pack});
 const run=(args:string[],bytes?:Buffer|string)=>managedGit(git,args,signal,{input:bytes,environment:{...metadata,GIT_INDEX_FILE:path.join(dir,'index')}});
 await run(['read-tree',manifest.baseSha]);let total=0;const changes:GitLabPlan['changes']=[];
 for(const change of diff.changes){
  const entry=manifest.worktree.find(e=>e.path===change.path),bytes=entry?loaded.blobs.get(entry.hash)!:null;
  // Complete text review is required for this adapter's first delivery path.
  let previous:Buffer|null=null;
  if(change.kind!=='added'){
   const row=(await managedGit(repo,['--literal-pathspecs','ls-tree','-z',manifest.baseSha,'--',change.path],signal)).bytes.toString('utf8'),oid=/^[0-9]+ blob ([a-f0-9]{40})\t/.exec(row)?.[1];
   if(!oid)throw new Error('gitlab_plan_source_changed');previous=(await reader.objects([oid],'blob')).get(oid)!;
  }
  for(const value of [bytes,previous])if(value){total+=value.length;if(total>2*1024*1024||!isUtf8(value)||value.includes(0)||snapshotHasSecret(value))throw new Error('gitlab_plan_text_required');}
  changes.push({...change,before:previous?.toString('utf8')??null,after:bytes?.toString('utf8')??null});
  if(entry&&bytes){const oid=(await run(['hash-object','-w','--stdin'],bytes)).bytes.toString('utf8').trim();await run(['update-index','--add','--cacheinfo',entry.mode,oid,entry.path]);}
  else await run(['update-index','--force-remove','--',change.path]);
 }
 const tree=(await run(['write-tree'])).bytes.toString('utf8').trim();
 const commitSha=(await run(['commit-tree',tree,'-p',manifest.baseSha],`pi-collab: ${input.title}\n\nFixed result export ${input.id}\n`)).bytes.toString('utf8').trim();
 const branch=taskPushRef({taskId:input.taskId,workspaceId:input.id}).slice(11),plan:GitLabPlan={source:input,baseSha:manifest.baseSha,commitSha,branch,changes,excluded:diff.excluded};
 const json=JSON.stringify(plan),planHash=hash(json);await save(path.join(dir,'plan.json'),json);return{plan,planHash};
}
export async function readGitLabPlan(root:string,id:string,expectedHash:string){
 const dir=directory(root,id);if((await lstat(dir)).isSymbolicLink())throw new Error('gitlab_plan_invalid');const file=await open(path.join(dir,'plan.json'),constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const stat=await file.stat();if(!stat.isFile()||stat.nlink!==1||stat.size>8*1024*1024)throw new Error('gitlab_plan_invalid');const bytes=await file.readFile();if(hash(bytes)!==expectedHash)throw new Error('gitlab_plan_invalid');const plan=JSON.parse(bytes.toString()) as GitLabPlan;source.parse(plan.source);if(plan.source.id!==id)throw new Error('gitlab_plan_invalid');return plan;}finally{await file.close();}
}
export async function preparedGitLabPush(root:string,id:string,planHash:string,operationId:string,signal:AbortSignal){
 const plan=await readGitLabPlan(root,id,planHash);return PreparedTaskPush.prepare(path.join(directory(root,id),'git'),{operationId,taskId:plan.source.taskId,workspaceId:id,repositoryId:plan.source.repositoryId,expectedOld:null,newSha:plan.commitSha},signal);
}
