import {mkdir} from "node:fs/promises";
import path from "node:path";
import type {Pool} from "pg";
import {z} from "zod";
import {GitLabClient,GitLabError,type GitLabEvidence} from "./client";
import {openCredential} from "../gateway/credentials";
import {downloadVerifiedGit,managedGit} from "../git/github-pack";
import {prepareGitLabPlan,readGitLabPlan,preparedGitLabPush} from "./plan";
const claimSchema=z.object({id:z.uuid(),claimId:z.uuid()});
type Job={id:string;kind:'import'|'sync'|'prepare'|'publish'|'observe'|'ready'|'merge';actor_id:string;project_id:string;repository_id:string;source_id:string|null;result:Record<string,unknown>;request:{reason:string;title?:string}};
type Context={job:Job;connection:{id:string;project_id:string;origin:string;remote_id:string;evidence:GitLabEvidence};sealed:unknown;source:Job|null;prepared:Job|null;taskResult:{id:string;task_id:string;snapshot_id:string;manifest_hash:string}|null;task:{id:string;title:string}|null};
export async function processGitLab(pool:Pool,root:string,master:()=>Promise<Buffer>,options:{transport?:typeof fetch;signal?:AbortSignal}={}){
 const db=await pool.connect(),lost=new AbortController(),signal=AbortSignal.any([lost.signal,options.signal??new AbortController().signal,AbortSignal.timeout(240000)]);
 const onError=()=>lost.abort();db.on('error',onError);let claim:z.infer<typeof claimSchema>|undefined,key:Buffer|undefined,mayWrite=false;const details:Record<string,unknown>={};
 try{
  const raw=(await db.query('SELECT collab_git.claim_gitlab() AS result')).rows[0].result;if(!raw)return null;claim=claimSchema.parse(raw);
  const context=async()=>(await db.query('SELECT collab_git.gitlab_context($1,$2) AS result',[claim!.id,claim!.claimId])).rows[0].result as Context;
  const stage=async(name:string,extra:Record<string,unknown>={})=>{await db.query('SELECT collab_git.gitlab_stage($1,$2,$3,$4)',[claim!.id,claim!.claimId,name,extra]);Object.assign(details,extra);};
  const ctx=await context(),{job,connection:c}=ctx;await db.query('SELECT collab_git.lock_gitlab_connection($1,$2)',[claim.id,claim.claimId]);await context();key=await master();const secret=openCredential(key,c.id,c.project_id,ctx.sealed);if(secret.baseUrl!==c.origin)throw new GitLabError('gitlab_credential_scope');
  const client=new GitLabClient(c.origin,c.remote_id,secret.apiKey,options.transport),observed=await client.inspect(signal);client.assertIdentity(c.evidence,observed);
  if(job.kind==='import'){
   await mkdir(path.join(root,'repositories'),{recursive:true,mode:0o700});await downloadVerifiedGit(path.join(root,'repositories',job.repository_id),{defaultBranch:observed.defaultBranch,targetSha:observed.baseSha},client.reader(observed),signal);
   const current=await client.inspect(signal);client.assertIdentity(observed,current);if(current.baseSha!==observed.baseSha)throw new GitLabError('gitlab_baseline_changed');Object.assign(details,observed);
  }else if(job.kind==='sync'){
   // Fetch into a unique verified staging repository. Existing objects and old task bases remain available.
   await mkdir(path.join(root,'gitlab-syncs'),{recursive:true,mode:0o700});
   const staging=path.join(root,'gitlab-syncs',job.id),repo=path.join(root,'repositories',job.repository_id,'git');
   await downloadVerifiedGit(staging,{defaultBranch:observed.defaultBranch,targetSha:observed.baseSha},client.reader(observed),signal);
   const current=await client.inspect(signal);client.assertIdentity(observed,current);if(current.baseSha!==observed.baseSha)throw new GitLabError('gitlab_baseline_changed');
   const ref=`refs/heads/${observed.defaultBranch}`;
   const old=(await managedGit(repo,['rev-parse','--verify',ref],signal)).bytes.toString('utf8').trim();
   const pack=(await managedGit(path.join(staging,'git'),['pack-objects','--stdout','--revs','--no-reuse-delta','--no-reuse-object'],signal,{input:`${observed.baseSha}\n`,limit:256*1024*1024})).bytes;
   await stage('sync_verified');await managedGit(repo,['index-pack','--stdin','--strict'],signal,{input:pack});
   // Ref and database advance under the same connection-level lock; failed DB completion can be retried by a fresh sync.
   await managedGit(repo,['update-ref',ref,observed.baseSha,old],signal);Object.assign(details,observed);
  }else if(job.kind==='prepare'){
   const r=ctx.taskResult!,task=ctx.task!;const {plan,planHash}=await prepareGitLabPlan(root,{id:job.id,repositoryId:job.repository_id,taskId:task.id,snapshotId:r.snapshot_id,manifestHash:r.manifest_hash,title:task.title},signal);
   if(plan.baseSha!==observed.baseSha)throw new GitLabError('gitlab_baseline_changed');Object.assign(details,{planHash,commitSha:plan.commitSha,baseSha:plan.baseSha,branch:plan.branch,files:plan.changes.length,excluded:plan.excluded.length});
  }else{
   const prepared=ctx.prepared!,planHash=z.string().regex(/^[a-f0-9]{64}$/).parse(prepared.result.planHash),plan=await readGitLabPlan(root,prepared.id,planHash);
   Object.assign(details,{planHash,commitSha:plan.commitSha,baseSha:plan.baseSha,branch:plan.branch});
   if(job.kind==='publish'){
    if(plan.baseSha!==observed.baseSha||plan.branch===observed.defaultBranch)throw new GitLabError('gitlab_baseline_changed');
    const push=await preparedGitLabPush(root,prepared.id,planHash,job.id,signal);
    const outcome=await push.execute(client.writer(observed),async attempt=>{const current=await client.inspect(signal);client.assertIdentity(observed,current);if(current.baseSha!==plan.baseSha)return false;await stage('push_sent',{attempt});mayWrite=true;return true;},signal);
    if(outcome.status!=='acknowledged')throw new GitLabError(outcome.status==='unknown'?'gitlab_push_unconfirmed':'gitlab_push_not_applied');
    await stage('push_acknowledged',{push:outcome});
    const current=await client.inspect(signal);client.assertIdentity(observed,current);if(current.baseSha!==plan.baseSha)throw new GitLabError('gitlab_baseline_changed');
    await stage('mr_sent');mayWrite=true;
    const mr=await client.createMergeRequest(plan.branch,ctx.task!.title,`pi-collab fixed result ${ctx.taskResult!.id}\nSource plan ${prepared.id}\n${job.request.reason}`,observed,signal);
    if(mr.sha!==plan.commitSha)throw new GitLabError('gitlab_merge_request_changed');Object.assign(details,{iid:mr.iid,url:mr.web_url,mr});
   }else{
    const iid=z.coerce.string().regex(/^[1-9][0-9]{0,15}$/).parse(ctx.source!.result.iid);let mr=await client.observeMergeRequest(iid,plan.branch,observed,signal);
    if(mr.sha!==plan.commitSha)throw new GitLabError('gitlab_merge_request_changed');
    if(job.kind==='ready'){
     if(mr.state!=='opened'||!mr.draft)throw new GitLabError('gitlab_release_not_ready');await stage('ready_sent');mayWrite=true;mr=await client.markReady(iid,ctx.task!.title,plan.branch,observed,signal);
     if(mr.draft||mr.sha!==plan.commitSha)throw new GitLabError('gitlab_release_unconfirmed');
    }else if(job.kind==='merge'){
     if(mr.state!=='opened'||mr.draft||mr.detailed_merge_status!=='mergeable'||mr.head_pipeline?.sha!==plan.commitSha||mr.head_pipeline.status!=='success')throw new GitLabError('gitlab_release_not_ready');
     await stage('merge_sent',{pipelineId:mr.head_pipeline.id});mayWrite=true;mr=await client.merge(iid,plan.commitSha,plan.branch,observed,signal);
     if(mr.state!=='merged'||!mr.merge_commit_sha)throw new GitLabError('gitlab_release_unconfirmed');
    }
    Object.assign(details,{iid,url:mr.web_url,mr});
   }
  }
  if(signal.aborted)throw new GitLabError('gitlab_cancelled');
  return(await db.query('SELECT collab_git.finish_gitlab($1,$2,$3,$4) AS result',[claim.id,claim.claimId,'completed',details])).rows[0].result;
 }catch(error){
  if(claim&&!lost.signal.aborted){const failure=error instanceof GitLabError?error.code:error instanceof Error&&/^(gitlab_|independent_review_required)/.test(error.message)?error.message:'gitlab_operation_failed';
   const result=await db.query('SELECT collab_git.finish_gitlab($1,$2,$3,$4,$5) AS result',[claim.id,claim.claimId,mayWrite?'uncertain':'failed',details,failure]).catch(()=>null);if(result)return result.rows[0].result;
  }
  if(claim)throw new GitLabError('gitlab_outcome_unknown');throw error;
 }finally{key?.fill(0);lost.abort();db.removeListener('error',onError);db.release(true);}
}
