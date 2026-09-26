import {z} from "zod";
import {validateEndpoint} from "../gateway/credentials";
import {githubBranch} from "../git/github-schema";
import type {GitHubGitRead} from "../git/github-client";
import type {TaskPushTransport} from "../git/task-push-protocol";
const sha=z.string().regex(/^[a-f0-9]{40}$/),id=z.coerce.string().regex(/^[1-9][0-9]{0,15}$/);
const namespace=z.string().max(500).refine(v=>v.split('/').length>=2&&v.split('/').every(p=>/^[a-zA-Z0-9_.-]+$/.test(p)&&p!=='.'&&p!=='..'));
export class GitLabError extends Error {constructor(readonly code:string,readonly status?:number){super(code);}}
export const gitlabConnectionInput=z.object({projectId:z.uuid(),actorId:z.string().min(1),origin:z.string().url(),remoteId:id,name:z.string().trim().min(1).max(120),reason:z.string().trim().min(10).max(2000)}).strict();
export type GitLabEvidence={remoteId:string;path:string;defaultBranch:string;baseSha:string;visibility:string;webUrl:string;tokenUserId:string;observedAt:string};
const projectSchema=z.object({id,path_with_namespace:namespace,default_branch:githubBranch,archived:z.literal(false),visibility:z.enum(['private','internal','public']),http_url_to_repo:z.string().url(),web_url:z.string().url(),permissions:z.object({project_access:z.object({access_level:z.number()}).nullable().optional(),group_access:z.object({access_level:z.number()}).nullable().optional()})});
export class GitLabClient{
 readonly origin:string;readonly remoteId:string;
 constructor(origin:string,remoteId:string,private readonly token:string,private readonly transport:typeof fetch=fetch){
  this.origin=validateEndpoint(origin);if(new URL(this.origin).pathname!=='/')throw new GitLabError('gitlab_origin_required');this.remoteId=id.parse(remoteId);
  if(!token||token.length>16000||/[\x00-\x20\x7f]/.test(token))throw new GitLabError('gitlab_invalid_credential');
 }
 private async request(method:string,suffix:string,body:unknown,signal:AbortSignal,root=false){
  const url=`${this.origin}/api/v4${root?suffix:`/projects/${this.remoteId}${suffix}`}`;
  let response:Response|undefined;
  try{
   response=await this.transport(url,{method,redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(20000)]),headers:{'PRIVATE-TOKEN':this.token,Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
   if(!response.ok)throw new GitLabError('gitlab_request_rejected',response.status);
   if(!response.body)throw new GitLabError('gitlab_invalid_response');let length=0;const chunks:Uint8Array[]=[];
   const reader=response.body.getReader();try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>2*1024*1024)throw new GitLabError('gitlab_response_limit');chunks.push(value);}}finally{await reader.cancel();}
   return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  }catch(e){if(e instanceof GitLabError)throw e;throw new GitLabError('gitlab_transport_unconfirmed');}
  finally{await response?.body?.cancel().catch(()=>{});}
 }
 async inspect(signal:AbortSignal):Promise<GitLabEvidence>{
  const user=z.object({id,bot:z.literal(true)}).parse(await this.request('GET','/user',undefined,signal,true));
  const self=z.object({id,user_id:id}).parse(await this.request('GET','/personal_access_tokens/self',undefined,signal,true));
  const scoped=z.object({id,user_id:id,active:z.literal(true),revoked:z.literal(false),access_level:z.number().min(40),scopes:z.array(z.string())}).parse(await this.request('GET',`/access_tokens/${self.id}`,undefined,signal));
  if(self.user_id!==user.id||scoped.id!==self.id||scoped.user_id!==user.id||!['api','write_repository'].every(s=>scoped.scopes.includes(s)))throw new GitLabError('gitlab_project_token_required');
  const p=projectSchema.parse(await this.request('GET','',undefined,signal));
  if(p.id!==this.remoteId||Math.max(p.permissions.project_access?.access_level??0,p.permissions.group_access?.access_level??0)<40)throw new GitLabError('gitlab_maintainer_token_required');
  const expected=`${this.origin}/${p.path_with_namespace}`;
  if(p.http_url_to_repo!==`${expected}.git`||p.web_url!==expected)throw new GitLabError('gitlab_repository_identity_changed');
  const branch=z.object({name:githubBranch,commit:z.object({id:sha})}).parse(await this.request('GET',`/repository/branches/${encodeURIComponent(p.default_branch)}`,undefined,signal));
  if(branch.name!==p.default_branch)throw new GitLabError('gitlab_repository_identity_changed');
  return{remoteId:p.id,path:p.path_with_namespace,defaultBranch:p.default_branch,baseSha:branch.commit.id,visibility:p.visibility,webUrl:p.web_url,tokenUserId:user.id,observedAt:new Date().toISOString()};
 }
 assertIdentity(expected:GitLabEvidence,current:GitLabEvidence){for(const field of ['remoteId','path','defaultBranch','visibility','webUrl','tokenUserId'] as const)if(expected[field]!==current[field])throw new GitLabError('gitlab_repository_identity_changed');}
 private async git(evidence:GitLabEvidence,service:'upload'|'receive',kind:'advertise'|'body',signal:AbortSignal,body?:Uint8Array,gzip=false){
  if(evidence.remoteId!==this.remoteId||evidence.webUrl!==`${this.origin}/${namespace.parse(evidence.path)}`)throw new GitLabError('gitlab_repository_identity_changed');
  const name=`git-${service}-pack`,url=`${evidence.webUrl}.git/${kind==='advertise'?`info/refs?service=${name}`:name}`;
  let response:Response;try{response=await this.transport(url,{method:kind==='advertise'?'GET':'POST',redirect:'error',signal,headers:{...(service==='upload'?{'Git-Protocol':'version=2'}:{}),Authorization:`Basic ${Buffer.from(`oauth2:${this.token}`).toString('base64')}`,...(kind==='body'?{'Content-Type':`application/x-${name}-request`}:{}),...(gzip?{'Content-Encoding':'gzip'}:{})},...(body?{body:new Uint8Array(body)}:{})});}catch{throw new GitLabError('gitlab_transport_unconfirmed');}
  if(response.status!==200||response.headers.get('content-type')?.split(';')[0]!==`application/x-${name}-${kind==='advertise'?'advertisement':'result'}`){await response.body?.cancel();throw new GitLabError('gitlab_git_rejected',response.status);}
  return response;
 }
 reader(evidence:GitLabEvidence):GitHubGitRead{return(kind,body,gzip,signal)=>this.git(evidence,'upload',kind==='advertise'?'advertise':'body',signal??AbortSignal.timeout(180000),body,gzip);}
 writer(evidence:GitLabEvidence):TaskPushTransport{return(kind,signal,body)=>this.git(evidence,'receive',kind==='advertise'?'advertise':'body',signal,body);}
 async createMergeRequest(branch:string,title:string,description:string,evidence:GitLabEvidence,signal:AbortSignal){
  githubBranch.parse(branch);if(branch===evidence.defaultBranch)throw new GitLabError('gitlab_protected_destination');
  return this.parseMr(await this.request('POST','/merge_requests',{source_branch:branch,target_branch:evidence.defaultBranch,title:`Draft: ${title}`,description,remove_source_branch:false,squash:false},signal),branch,evidence);
 }
 private parseMr(raw:unknown,branch:string,evidence:GitLabEvidence){
  const mr=z.object({iid:id,project_id:id,source_project_id:id,target_project_id:id,source_branch:githubBranch,target_branch:githubBranch,sha,state:z.enum(['opened','closed','merged']),draft:z.boolean(),web_url:z.string().url(),merge_commit_sha:sha.nullable().optional(),detailed_merge_status:z.string().optional(),head_pipeline:z.object({id,sha,status:z.string(),web_url:z.string().url().optional()}).nullable().optional()}).parse(raw);
  if([mr.project_id,mr.source_project_id,mr.target_project_id].some(v=>v!==this.remoteId)||mr.source_branch!==branch||mr.target_branch!==evidence.defaultBranch||mr.web_url!==`${evidence.webUrl}/-/merge_requests/${mr.iid}`)throw new GitLabError('gitlab_merge_request_changed');return mr;
 }
 async observeMergeRequest(iid:string,branch:string,evidence:GitLabEvidence,signal:AbortSignal){return this.parseMr(await this.request('GET',`/merge_requests/${id.parse(iid)}`,undefined,signal),branch,evidence);}
 async markReady(iid:string,title:string,branch:string,evidence:GitLabEvidence,signal:AbortSignal){return this.parseMr(await this.request('PUT',`/merge_requests/${id.parse(iid)}`,{title:title.replace(/^(?:draft:|wip:)\s*/i,'')},signal),branch,evidence);}
 async merge(iid:string,expectedSha:string,branch:string,evidence:GitLabEvidence,signal:AbortSignal){return this.parseMr(await this.request('PUT',`/merge_requests/${id.parse(iid)}/merge`,{sha:sha.parse(expectedSha),squash:false,should_remove_source_branch:false},signal),branch,evidence);}
}
