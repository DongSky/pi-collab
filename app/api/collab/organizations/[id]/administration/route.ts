import {endpoint,identity} from "@/lib/collab/http";
import {administration} from "@/lib/collab/administration";
export async function GET(request:Request,context:{params:Promise<{id:string}>}){const q=new URL(request.url).searchParams;return endpoint(request,async()=>administration((await identity(request)).user.id,(await context.params).id,q.get("q")??"",q.get("before")));}
