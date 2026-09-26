import { endpoint,identity } from "@/lib/collab/http";
import { editorFolder } from "@/lib/collab/editor";
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){return endpoint(request,async()=>editorFolder((await identity(request)).user.id,(await params).id));}
