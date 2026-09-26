import {createServer} from "node:http";
import {randomBytes} from "node:crypto";
import path from "node:path";
import {managedGit} from "../../../lib/collab/git/github-pack";
import {taskPushFixture} from "./task-push";
import {gitSource} from "./git-source";
export async function gitlabFixture(root:string){
 await gitSource(root);const git=await taskPushFixture(root),token=randomBytes(30).toString('hex'),mrs=new Map<string,Record<string,unknown>>();
 const calls:{method:string;route:string}[]=[],state={permission:40,visibility:'private',pipeline:'success',wrongIdentity:false};let origin='';
 const command=async(args:string[],input?:string)=>(await managedGit(path.join(root,'source.git'),args,AbortSignal.timeout(10000),{input,environment:{GIT_AUTHOR_NAME:'Fixture merge',GIT_AUTHOR_EMAIL:'fixture@test.invalid',GIT_COMMITTER_NAME:'Fixture merge',GIT_COMMITTER_EMAIL:'fixture@test.invalid'}})).bytes.toString().trim();
 const head=(branch='main')=>command(['rev-parse',`refs/heads/${branch}`]);
 const server=createServer((req,res)=>{void(async()=>{
  const route=req.url!,url=new URL(route,origin);calls.push({method:req.method!,route});
  const send=(status:number,body:unknown)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
  if(url.pathname.startsWith('/team/source.git/')){
   if(req.headers.authorization!==`Basic ${Buffer.from(`oauth2:${token}`).toString('base64')}`)return send(401,{});
   const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks),read=url.search.includes('upload-pack')||url.pathname.endsWith('git-upload-pack'),advertise=req.method==='GET';
   const response=read?await git.readTransport(advertise?'advertise':'upload',body.length?body:undefined,req.headers['content-encoding']==='gzip',AbortSignal.timeout(30000)):await git.transport(advertise?'advertise':'receive',AbortSignal.timeout(30000),body.length?body:undefined);
   res.writeHead(response.status,{'Content-Type':response.headers.get('content-type')!});res.end(Buffer.from(await response.arrayBuffer()));return;
  }
  if(req.headers['private-token']!==token)return send(401,{});
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};
  if(route==='/api/v4/personal_access_tokens/self')return send(200,{id:88,user_id:77});
  if(route==='/api/v4/projects/101/access_tokens/88')return send(200,{id:88,user_id:77,active:true,revoked:false,access_level:40,scopes:['api','write_repository']});
  if(route==='/api/v4/user')return send(200,{id:77,bot:true});
  if(route==='/api/v4/projects/101')return send(200,{id:state.wrongIdentity?102:101,path_with_namespace:'team/source',default_branch:'main',archived:false,visibility:state.visibility,http_url_to_repo:`${origin}/team/source.git`,web_url:`${origin}/team/source`,permissions:{project_access:{access_level:state.permission},group_access:null}});
  if(route==='/api/v4/projects/101/repository/branches/main')return send(200,{name:'main',commit:{id:await head()}});
  if(route==='/api/v4/projects/101/merge_requests'&&req.method==='POST'){
   const iid=String(mrs.size+1),sha=await head(body.source_branch);mrs.set(iid,{iid,project_id:101,source_project_id:101,target_project_id:101,source_branch:body.source_branch,target_branch:body.target_branch,sha,state:'opened',draft:true,title:body.title,web_url:`${origin}/team/source/-/merge_requests/${iid}`,detailed_merge_status:'draft_status',merge_commit_sha:null});return send(201,mrs.get(iid));
  }
  const match=/^\/api\/v4\/projects\/101\/merge_requests\/([0-9]+)(\/merge)?$/.exec(route);
  if(match){const mr=mrs.get(match[1]);if(!mr)return send(404,{});mr.sha=await head(String(mr.source_branch));mr.head_pipeline={id:1001,sha:mr.sha,status:state.pipeline};
   if(req.method==='PUT'&&match[2]){
    if(body.sha!==mr.sha||mr.draft||mr.state!=='opened'||state.pipeline!=='success')return send(405,{});
    const prior=await head(),tree=await command(['rev-parse',`${mr.sha}^{tree}`]),merged=await command(['commit-tree',tree,'-p',prior,'-p',String(mr.sha)],'Merge fixture MR\n');await command(['update-ref','refs/heads/main',merged,prior]);mr.merge_commit_sha=merged;mr.state='merged';
   }else if(req.method==='PUT'){mr.draft=false;mr.title=body.title;mr.detailed_merge_status='mergeable';}
   return send(200,mr);
  }
  send(404,{});
 })().catch(()=>{if(!res.headersSent)res.writeHead(500);res.end();});});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 return{origin,token,git,calls,state,head,command,async close(){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await git.close();}};
}
