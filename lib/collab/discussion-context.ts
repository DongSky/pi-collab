import { z } from "zod";
import { asUser } from "./database";
import { discussionContextSelection,discussionContextInstruction,type DiscussionContextPreview } from "./discussion-context-schema";
export function previewDiscussionContext(userId:string,runId:string,raw:unknown):Promise<DiscussionContextPreview>{
 z.uuid().parse(runId);const input=discussionContextSelection.parse(raw);
 return asUser(userId,async db=>(await db.query("SELECT collab.discussion_instruction_context($1,$2,$3) AS result",[runId,input.threadId,input.messageIds])).rows[0].result);
}
export function submitDiscussionContext(userId:string,runId:string,raw:unknown){
 z.uuid().parse(runId);const {idempotencyKey,...input}=discussionContextInstruction.parse(raw);
 return asUser(userId,async db=>(await db.query("SELECT collab.submit_discussion_instruction($1,$2,$3) AS result",[runId,idempotencyKey,input])).rows[0].result);
}
