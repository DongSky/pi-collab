import { endpoint,identity,jsonBody } from "@/lib/collab/http";
type Context={params:Promise<{id:string}>};
import { editorDetail,editorCommand } from "@/lib/collab/editor";
export async function GET(request:Request,{params}:Context){return endpoint(request,async()=>editorDetail((await identity(request)).user.id,(await params).id));}
export async function POST(request:Request,{params}:Context){return endpoint(request,async()=>editorCommand((await identity(request)).user.id,(await params).id,await jsonBody(request)));}
