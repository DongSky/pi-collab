import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { z } from "zod";
import type { CoordinationAccess } from "../coordination-server";
const request=z.object({type:z.literal("collab_bridge_request"),id:z.uuid(),target:z.enum(["model","coordination","registry"]),path:z.string().max(4096),authorization:z.string().max(1000),body:z.string().max(24*1024*1024)}).strict();
export const containerRuntime=z.object({node:z.string(),nodeHash:z.string().regex(/^[a-f0-9]{64}$/),npmHash:z.string().regex(/^[a-f0-9]{64}$/),piHash:z.string().regex(/^[a-f0-9]{64}$/),platform:z.literal("linux"),arch:z.string(),kernel:z.string(),backend:z.literal("docker")}).strict();
export type ContainerRuntime=z.infer<typeof containerRuntime>;
export function containerBridge(child:ChildProcessWithoutNullStreams,model:{url:string;token:string}|undefined,coordination:CoordinationAccess|undefined){
 const active=new Map<string,AbortController>();let closed=false;
 const write=async(event:Record<string,unknown>)=>{if(closed||child.stdin.destroyed)return;if(!child.stdin.write(JSON.stringify({type:"collab_bridge_response",...event})+"\n"))await once(child.stdin,"drain");};
 const handle=async(raw:Record<string,unknown>)=>{
  const parsed=request.safeParse(raw);if(!parsed.success)return;
  const r=parsed.data;if(closed||active.has(r.id))return;
  if(active.size>=4){await write({id:r.id,status:429,end:true});return;}
  let url:string,authorization:string|undefined,method="POST";
  if(r.target==="model"&&r.path==="/v1/responses"&&model&&r.authorization===`Bearer ${model.token}`){url=`${model.url}/responses`;authorization=r.authorization;}
  else if(r.target==="coordination"&&r.path==="/v1/coordinate"&&coordination&&r.authorization===`Bearer ${coordination.token}`){url=coordination.url;authorization=r.authorization;}
  else if(r.target==="registry"&&r.path.startsWith("/registry/")&&!r.authorization&&!r.body){
   const target=new URL(`https://registry.npmjs.org/${r.path.slice(10)}`);
   if(target.hostname!=="registry.npmjs.org"||target.username||target.password){await write({id:r.id,status:403,end:true});return;}
   url=target.toString();method="GET";
  }else{await write({id:r.id,status:403,end:true});return;}
  const controller=new AbortController();active.set(r.id,controller);
  try{
   const response=await fetch(url,{method,headers:method==="POST"?{"Content-Type":"application/json",Authorization:authorization!}:{},body:method==="POST"?new Uint8Array(Buffer.from(r.body,"base64")):undefined,redirect:"error",signal:AbortSignal.any([controller.signal,AbortSignal.timeout(120000)])});
   await write({id:r.id,status:response.status,contentType:response.headers.get("content-type")});let bytes=0;
   if(response.body){const reader=response.body.getReader();try{for(;;){const {done,value:chunk}=await reader.read();if(done)break;bytes+=chunk.length;if(bytes>128*1024*1024)throw new Error("bridge_limit");await write({id:r.id,chunk:Buffer.from(chunk).toString("base64")});}}finally{await reader.cancel().catch(()=>{});}}
   await write({id:r.id,end:true});
  }catch{await write({id:r.id,error:true});}finally{active.delete(r.id);}
 };
 return {
  accept(event:Record<string,unknown>){
   if(event.type==="collab_bridge_cancel"){if(typeof event.id==="string")active.get(event.id)?.abort();return true;}
   if(event.type!=="collab_bridge_request")return false;
   void handle(event).catch(()=>{if(typeof event.id==="string")active.get(event.id)?.abort();});return true;
  },
  close(){closed=true;for(const controller of active.values())controller.abort();active.clear();},
 };
}
