import {z} from "zod";
import {endpoint,identity,jsonBody} from "@/lib/collab/http";
import {gitlabProject,requestGitLab} from "@/lib/collab/gitlab/service";
type Context={params:Promise<{id:string}>};
export async function GET(r:Request,c:Context){return endpoint(r,async()=>gitlabProject((await identity(r)).user.id,(await c.params).id));}
export async function POST(r:Request,c:Context){return endpoint(r,async()=>{const b=z.object({connectionId:z.uuid(),command:z.unknown()}).strict().parse(await jsonBody(r));return requestGitLab((await identity(r)).user.id,(await c.params).id,b.connectionId,b.command);},202);}
