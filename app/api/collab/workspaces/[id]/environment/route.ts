import {endpoint,identity,jsonBody} from "@/lib/collab/http";
import {manageEnvironment} from "@/lib/collab/environments";
export async function POST(request:Request,context:{params:Promise<{id:string}>}){return endpoint(request,async()=>manageEnvironment((await identity(request)).user.id,(await context.params).id,await jsonBody(request)));}
