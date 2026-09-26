import type { KeyObject } from "node:crypto";
import { z } from "zod";
import { GitHubHttp } from "./github-http";
import { GitHubReadClient, githubAppJwt } from "./github-client";
import { GitHubError } from "./github-credentials";
import { githubAppConfig, repositoryResponse, repositoriesResponse, tokenResponse, branchResponse, type GitHubAppConfig } from "./github-schema";
import { githubPushBinding, type GitHubPushBinding } from "./github-task-target";
import { observedPullIdentity } from "./github-pull-observation";
import { readTaskPullSnapshot, type TaskPullIdentity } from "./github-task-pull";
import type { ReleaseReceipt } from "./pull-release-schema";
const sha=z.string().regex(/^[a-f0-9]{40}$/).refine(s=>s!=="0".repeat(40));
const fail=(code:string):never=>{throw new GitHubError(code);};
export const releaseTarget=z.object({binding:githubPushBinding,identity:observedPullIdentity,headSha:sha,baseSha:sha,action:z.enum(["ready","merge"])}).strict();
/** Internal broker only. Does not post reviews on behalf of human members. */
export class GitHubPullReleaseClient {
 private http:GitHubHttp; private reader:GitHubReadClient; readonly config:GitHubAppConfig;
 constructor(config:GitHubAppConfig,private key:KeyObject,transport:typeof fetch=fetch){this.config=githubAppConfig.parse(config);this.http=new GitHubHttp(transport);this.reader=new GitHubReadClient(this.config,key,transport);}
 private repository(raw:unknown,b:GitHubPushBinding){const r=repositoryResponse.parse(raw);if(r.id!==b.githubRepositoryId||r.node_id!==b.nodeId||r.owner.id!==b.ownerId||r.owner.login!==b.ownerLogin||r.name!==b.name||r.default_branch!==b.defaultBranch||r.visibility!==b.visibility||r.private!==b.private||r.archived||r.disabled)fail("github_release_repository_changed");}
 private async read(binding:GitHubPushBinding,identity:TaskPullIdentity,bearer:string,signal:AbortSignal){
  const raw=await this.http.request("GET",`/repos/${binding.ownerLogin}/${binding.name}/pulls/${identity.number}`,bearer,signal);
  return {snapshot:readTaskPullSnapshot(raw,binding,identity),raw};
 }
 async execute(raw:z.input<typeof releaseTarget>,gate:()=>Promise<void>,external?:AbortSignal):Promise<ReleaseReceipt>{
  const target=releaseTarget.parse(raw),b=target.binding,route=`/repos/${b.ownerLogin}/${b.name}`;
  if(b.ownerId!==this.config.accountId||target.identity.url!==`https://github.com/${b.ownerLogin}/${b.name}/pull/${target.identity.number}`)fail("github_pull_identity_mismatch");
  const signal=AbortSignal.any([external??new AbortController().signal,AbortSignal.timeout(90000)]);
  let token:string|undefined,started=false;
  let result:ReleaseReceipt={status:"not_sent",sha:null,failure:null,tokenRevoked:false};
  try{
   const installation=await this.reader.inspectInstallation(signal);
   if(installation.permissions.pull_requests!=="write"||(target.action==="merge"&&(installation.permissions.contents!=="write"||!["read","write"].includes(installation.permissions.administration??""))))fail("github_release_permission_required");
   const permissions:Record<string,string>={contents:target.action==="merge"?"write":"read",pull_requests:"write",...(target.action==="merge"?{administration:"read"}:{})};
   const rawToken=await this.http.request("POST",`/app/installations/${this.config.installationId}/access_tokens`,githubAppJwt(this.config,this.key),signal,{repository_ids:[Number(b.githubRepositoryId)],permissions});
   const safe=tokenResponse.shape.token.safeParse((rawToken as {token?:unknown})?.token);if(safe.success)token=safe.data;
   const issued=tokenResponse.parse(rawToken),lifetime=Date.parse(issued.expires_at)-Date.now();
   if(lifetime<60000||lifetime>3720000||Object.entries(permissions).some(([p,v])=>issued.permissions[p]!==v)||Object.entries(issued.permissions).some(([p,v])=>p==="metadata"?v!=="read":permissions[p]!==v))fail("github_token_scope_mismatch");
   const list=repositoriesResponse.parse(await this.http.request("GET","/installation/repositories?per_page=2&page=1",token!,signal));this.repository(list.repositories[0],b);this.repository(await this.http.request("GET",`/repositories/${b.githubRepositoryId}`,token!,signal),b);
   const check=async()=>{
    const {snapshot,raw:pull}=await this.read(b,target.identity,token!,signal);
    if(snapshot.state!=="open"||snapshot.merged||snapshot.headSha!==target.headSha||snapshot.baseSha!==target.baseSha||snapshot.baseRef!==b.defaultBranch||snapshot.draft!==(target.action==="ready"))fail("github_release_revision_changed");
    return pull;
   };
   await check();
   if(target.action==="merge"){
    const branch=branchResponse.parse(await this.http.request("GET",`${route}/branches/${encodeURIComponent(b.defaultBranch)}`,token!,signal));
    if(!branch.protected||branch.name!==b.defaultBranch||branch.commit.sha!==target.baseSha)fail("github_release_protection_required");
    // Baseline supports classic branch protection. Ruleset bypass semantics need their own adapter.
    const rules=z.array(z.unknown()).max(100).parse(await this.http.request("GET",`${route}/rules/branches/${encodeURIComponent(b.defaultBranch)}?per_page=100&page=1`,token!,signal));
    if(rules.length)fail("github_release_ruleset_unsupported");
    const protection=z.object({enforce_admins:z.object({enabled:z.literal(true)}),required_status_checks:z.object({strict:z.literal(true),contexts:z.array(z.string()).optional(),checks:z.array(z.unknown()).optional()}).refine(v=>(v.contexts?.length??0)+(v.checks?.length??0)>0),
     required_pull_request_reviews:z.object({dismiss_stale_reviews:z.literal(true),required_approving_review_count:z.number().int().min(1),require_last_push_approval:z.literal(true),bypass_pull_request_allowances:z.object({users:z.array(z.unknown()).length(0),teams:z.array(z.unknown()).length(0),apps:z.array(z.unknown()).length(0)}).optional()})});
    if(!protection.safeParse(await this.http.request("GET",`${route}/branches/${encodeURIComponent(b.defaultBranch)}/protection`,token!,signal)).success)fail("github_release_protection_required");
    const pull=await check();if(!z.object({mergeable:z.literal(true),mergeable_state:z.literal("clean")}).safeParse(pull).success)fail("github_release_remote_not_ready");
   }else await check();
   if(signal.aborted||Date.parse(issued.expires_at)<Date.now()+15000)fail("github_request_cancelled");
   await gate();signal.throwIfAborted();started=true;
   if(target.action==="ready"){
    const rawReady=await this.http.request("POST","/graphql",token!,signal,{query:"mutation Ready($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { id isDraft headRefOid baseRefOid } } }",variables:{id:target.identity.nodeId}},false,200);
    const ready=z.object({data:z.object({markPullRequestReadyForReview:z.object({pullRequest:z.object({id:z.literal(target.identity.nodeId),isDraft:z.literal(false),headRefOid:z.literal(target.headSha),baseRefOid:z.literal(target.baseSha)})})})}).parse(rawReady);
    if((rawReady as {errors?:unknown}).errors||!ready.data)fail("github_release_result_unconfirmed");result={...result,status:"ready"};
   }else{
    const merged=z.object({merged:z.literal(true),sha}).parse(await this.http.request("PUT",`${route}/pulls/${target.identity.number}/merge`,token!,signal,{sha:target.headSha,merge_method:"merge"}));
    result={...result,status:"merged",sha:merged.sha};
   }
  }catch(error){
   const e=error instanceof GitHubError?error:new GitHubError("github_release_result_unconfirmed");
   result={...result,status:!started?"not_sent":e.status&&[403,405,409,422].includes(e.status)?"rejected":"unknown",failure:e.code};
  }finally{
   if(token){try{await this.http.request("DELETE","/installation/token",token,AbortSignal.timeout(5000));result.tokenRevoked=true;}catch{result.failure??="github_token_revocation_unconfirmed";}token=undefined;}
  }
  return result;
 }
}
