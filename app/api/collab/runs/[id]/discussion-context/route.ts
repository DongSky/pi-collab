import { endpoint,identity,jsonBody } from "@/lib/collab/http";
import { previewDiscussionContext } from "@/lib/collab/discussion-context";
export function POST(request:Request,{params}:{params:Promise<{id:string}>}){return endpoint(request,async()=>previewDiscussionContext((await identity(request)).user.id,(await params).id,await jsonBody(request)));}
