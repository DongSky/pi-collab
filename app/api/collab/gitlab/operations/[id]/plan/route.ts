import {endpoint,identity} from "@/lib/collab/http";
import {gitlabPlan} from "@/lib/collab/gitlab/service";
export async function GET(r:Request,c:{params:Promise<{id:string}>}){return endpoint(r,async()=>gitlabPlan((await identity(r)).user.id,(await c.params).id));}
