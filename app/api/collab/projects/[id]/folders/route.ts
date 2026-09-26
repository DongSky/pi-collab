import { endpoint,identity } from "@/lib/collab/http";
import { importFolder } from "@/lib/collab/folder-import";
import { DomainError } from "@/lib/collab/policy";
import { asUser } from "@/lib/collab/database";
import { projectRole } from "@/lib/collab/projects";
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){
 return endpoint(request,async()=>{
  const user=(await identity(request)).user.id,{id}=await params;
  await asUser(user,db=>projectRole(db,id,"task.create"));
  if(!request.headers.get("content-type")?.startsWith("application/json"))throw new DomainError("invalid_content_type","需要 JSON 文件清单",415);
  const reader=request.body?.getReader();if(!reader)throw new DomainError("empty_folder","请选择文件夹");
  const chunks:Uint8Array[]=[];let size=0;const limit=46*1024*1024;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw new DomainError("folder_limit","上传超过 46 MiB 限制",413);}chunks.push(value);}}finally{reader.releaseLock();}
  let raw:unknown;try{raw=JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{throw new DomainError("invalid_json","文件清单无效");}
  return importFolder(user,id,raw);
 });
}
