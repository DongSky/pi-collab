import type { Pool } from "pg";
import { z } from "zod";
import { githubAppConfig } from "./github-schema";
import { openGitHubKey, GitHubError } from "./github-credentials";
import { releaseTarget, GitHubPullReleaseClient } from "./github-pull-release";
const claimSchema=z.object({jobId:z.uuid(),claimId:z.uuid(),action:z.enum(["ready","merge"]),admission:z.object({organizationId:z.uuid(),connectionId:z.uuid(),binding:releaseTarget.shape.binding,identity:releaseTarget.shape.identity,snapshot:z.object({headSha:z.string(),baseSha:z.string()})}).passthrough()});
export async function processPullRelease(pool:Pool,master:()=>Promise<Buffer>,options:{transport?:typeof fetch;signal?:AbortSignal;beforeGate?:(id:string)=>Promise<void>}={}){
 const db=await pool.connect(),lost=new AbortController();const disconnected=()=>lost.abort();db.on("error",disconnected);
 const signal=AbortSignal.any([lost.signal,options.signal??new AbortController().signal,AbortSignal.timeout(120000)]);
 let claim:z.infer<typeof claimSchema>|undefined;
 try{
  const raw=(await db.query("SELECT collab_git.claim_pull_release() AS result")).rows[0].result;if(!raw||raw.recovered)return raw;
  claim=claimSchema.parse(raw);const c=claim,a=c.admission;
  const connection=(await db.query("SELECT collab_git.begin_pull_release($1,$2,false) AS result",[c.jobId,c.claimId])).rows[0].result;
  const config=githubAppConfig.parse({appId:connection.appId,installationId:connection.installationId,accountId:connection.accountId});
  const bytes=await master();let client:GitHubPullReleaseClient;
  try{client=new GitHubPullReleaseClient(config,openGitHubKey(bytes,{...config,connectionId:a.connectionId,organizationId:a.organizationId},connection.sealed),options.transport);}finally{bytes.fill(0);}
  const result=await client.execute({binding:a.binding,identity:a.identity,headSha:a.snapshot.headSha,baseSha:a.snapshot.baseSha,action:c.action},async()=>{
   await options.beforeGate?.(c.jobId);signal.throwIfAborted();
   await db.query("SELECT collab_git.begin_pull_release($1,$2,true)",[c.jobId,c.claimId]);signal.throwIfAborted();
  },signal);
  return (await db.query("SELECT collab_git.finish_pull_release($1,$2,$3,$4) AS result",[c.jobId,c.claimId,result,result.failure])).rows[0].result;
 }catch(error){
  if(claim&&!lost.signal.aborted){const failure=error instanceof GitHubError?error.code:(error as {code?:string})?.code==="P0001"?String((error as Error).message).slice(0,120):"pull_release_failed";
   const result=await db.query("SELECT collab_git.finish_pull_release($1,$2,NULL,$3) AS result",[claim.jobId,claim.claimId,failure]).catch(()=>null);if(result)return result.rows[0].result;}
  throw new GitHubError("pull_release_outcome_unknown");
 }finally{lost.abort();db.removeListener("error",disconnected);db.release(true);}
}
