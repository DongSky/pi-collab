import {endpoint,identity,jsonBody} from "@/lib/collab/http";
import {recordDisposition} from "@/lib/collab/administration";
export async function POST(request:Request,context:{params:Promise<{id:string}>}){return endpoint(request,async()=>recordDisposition((await identity(request)).user.id,(await context.params).id,await jsonBody(request)));}
