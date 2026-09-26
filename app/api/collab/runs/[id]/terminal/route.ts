import { endpoint,identity,jsonBody } from "@/lib/collab/http";
import { terminalInput } from "@/lib/collab/terminal-schema";
import { asUser } from "@/lib/collab/database";
import { z } from "zod";
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){
 return endpoint(request,async()=>{
  const user=(await identity(request)).user,id=z.uuid().parse((await params).id),input=terminalInput.parse(await jsonBody(request));
  return asUser(user.id,async db=>(await db.query("SELECT collab.submit_terminal_input($1,$2,$3,$4) AS result",[id,input.expectedVersion,input.idempotencyKey,input.command])).rows[0].result);
 });
}
