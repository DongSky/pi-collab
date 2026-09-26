import { endpoint,identity,jsonBody } from "@/lib/collab/http";
type Context={params:Promise<{id:string}>};
import { listEditors,openEditor } from "@/lib/collab/editor";
export async function GET(request:Request,{params}:Context){return endpoint(request,async()=>listEditors((await identity(request)).user.id,(await params).id));}
export async function POST(request:Request,{params}:Context){return endpoint(request,async()=>openEditor((await identity(request)).user.id,(await params).id,await jsonBody(request)));}
