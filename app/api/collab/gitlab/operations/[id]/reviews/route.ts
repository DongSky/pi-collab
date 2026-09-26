import {endpoint,identity,jsonBody} from "@/lib/collab/http";
import {reviewGitLab} from "@/lib/collab/gitlab/service";
export async function POST(r:Request,c:{params:Promise<{id:string}>}){return endpoint(r,async()=>reviewGitLab((await identity(r)).user.id,(await c.params).id,await jsonBody(r)));}
