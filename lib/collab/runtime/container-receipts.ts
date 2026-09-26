import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash,randomUUID } from "node:crypto";
import { mkdir,open,readFile,rename,rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { WorkspaceLocation } from "./workspace";
import type { LaunchIdentity,ExitEvidence } from "./receipts";
export const dockerExec=promisify(execFile);
const schema=z.object({version:z.literal(1),workspaceId:z.uuid(),identity:z.object({runId:z.uuid(),executorId:z.uuid(),epoch:z.string()} ).nullable(),daemonId:z.string().min(1),image:z.string().regex(/^sha256:[a-f0-9]{64}$/),containerId:z.string().regex(/^[a-f0-9]{64}$/).nullable(),state:z.enum(["launching","started","stopped"])}).strict();
const receiptPath=(root:string,id:string)=>{z.uuid().parse(id);return path.join(root,"container-receipts",`${id}.json`);};
export async function daemonId(){return (await dockerExec("docker",["info","--format","{{.ID}}"],{timeout:10000})).stdout.trim();}
export async function beginContainerReceipt(workspace:WorkspaceLocation,image:string,identity?:LaunchIdentity){
 const file=receiptPath(path.dirname(path.dirname(workspace.root)),workspace.id),receipt=schema.parse({version:1,workspaceId:workspace.id,identity:identity??null,daemonId:await daemonId(),image,containerId:null,state:"launching"});
 await mkdir(path.dirname(file),{recursive:true,mode:0o700});const initial=await open(file,"wx",0o600);try{await initial.writeFile(JSON.stringify(receipt));await initial.sync();}finally{await initial.close();}
 const save=async()=>{const temporary=`${file}.${randomUUID()}.tmp`;try{const h=await open(temporary,"wx",0o600);try{await h.writeFile(JSON.stringify(receipt));await h.sync();}finally{await h.close();}await rename(temporary,file);}finally{await rm(temporary,{force:true});}};
 return {async started(id:string){receipt.containerId=z.string().regex(/^[a-f0-9]{64}$/).parse(id);receipt.state="started";await save();},async stopped(){receipt.state="stopped";await save();}};
}
export async function inspectContainerExit(root:string,workspaceId:string,identity:LaunchIdentity):Promise<ExitEvidence>{
 let raw:string;
 try{raw=await readFile(receiptPath(root,workspaceId),"utf8");}catch(e){return {safe:false,code:(e as NodeJS.ErrnoException).code==="ENOENT"?"receipt_missing":"inspection_unavailable"};}
 let receipt:z.infer<typeof schema>;
 try{if(raw.length>4096)throw new Error();receipt=schema.parse(JSON.parse(raw));if(receipt.workspaceId!==workspaceId||!receipt.identity||Object.entries(identity).some(([key,value])=>receipt.identity![key as keyof LaunchIdentity]!==value))throw new Error();}catch{return {safe:false,code:"receipt_invalid"};}
 const receiptHash=createHash("sha256").update(raw).digest("hex");
 if(receipt.state==="stopped")return {safe:true,code:"stop_confirmed",receiptHash};
 if(!receipt.containerId)return {safe:false,code:"launch_uncertain",receiptHash};
 try{
  if(receipt.daemonId!==await daemonId())return {safe:false,code:"boot_changed",receiptHash};
  const info=JSON.parse((await dockerExec("docker",["inspect",receipt.containerId],{timeout:10000})).stdout)[0];
  if(info.Id!==receipt.containerId||info.Image!==receipt.image||info.Config.Labels?.["pi-collab.workspace"]!==workspaceId) return {safe:false,code:"receipt_invalid",receiptHash};
  return {safe:info.State.Running===false,code:info.State.Running===false?"stop_confirmed":"writer_present",receiptHash};
 }catch{return {safe:false,code:"inspection_unavailable",receiptHash};}
}
