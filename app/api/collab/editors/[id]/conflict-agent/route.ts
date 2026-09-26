import { endpoint,identity,jsonBody } from "@/lib/collab/http";
import { startConflictAgent,conflictAgentResult } from "@/lib/collab/editor-conflict-agent";
type Context={params:Promise<{id:string}>};
export async function POST(request:Request,{params}:Context){return endpoint(request,async()=>startConflictAgent((await identity(request)).user.id,(await params).id,await jsonBody(request,1500000)));}
export async function PUT(request:Request,{params}:Context){return endpoint(request,async()=>conflictAgentResult((await identity(request)).user.id,(await params).id,await jsonBody(request)));}
