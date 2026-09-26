import {endpoint,identity} from "@/lib/collab/http";
import {environmentHandoff} from "@/lib/collab/environments";
export async function GET(request:Request,context:{params:Promise<{id:string}>}){return endpoint(request,async()=>environmentHandoff((await identity(request)).user.id,(await context.params).id));}
