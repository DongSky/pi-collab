import { z } from "zod";
import { codeAnchor, discussionInput, type DiscussionDetail } from "./discussion-schema";
import { reviewAnchor, type ReviewAnchor } from "./review-discussion-schema";
const mentions = z.array(z.string().min(1).max(200)).max(20);
export const discussionDraft = z.object({
 version:z.literal(1), title:z.string().max(200), body:z.string().max(8000), mentions,
 anchor:codeAnchor.nullable(), replacement:z.string().max(16000).nullable(), reviewAnchor:reviewAnchor.nullable(),
 selected:z.string().uuid().or(z.literal("")), replies:z.record(z.uuid(),z.object({body:z.string().max(8000),mentions}).strict()), pending:discussionInput.nullable(),
}).strict();
export type DiscussionDraft = z.infer<typeof discussionDraft>;
export function emptyDiscussionDraft():DiscussionDraft {return {version:1,title:"",body:"",mentions:[],anchor:null,replacement:null,reviewAnchor:null,selected:"",replies:{},pending:null};}
export function discussionDraftKey(user:string,task:string,anchor?:ReviewAnchor){
 const scope=anchor?[anchor.kind,anchor.sourceId,anchor.sourceHash,anchor.diffHash,anchor.path,anchor.side,anchor.startLine]:["task"];
 return "pi-collab:discussion-draft:v1:"+JSON.stringify([user,task,...scope]);
}
export function readDiscussionDraft(storage:Storage,key:string){const raw=storage.getItem(key);if(raw===null)return emptyDiscussionDraft();if(raw.length>262144)throw new Error("讨论草稿超出本窗口上限，请先核对已有讨论。");return discussionDraft.parse(JSON.parse(raw));}
export function writeDiscussionDraft(storage:Storage,key:string,value:DiscussionDraft){
 const checked=discussionDraft.safeParse(value);if(!checked.success)throw new Error("草稿字段尚不完整，请核对代码行范围后再发送。");
 const raw=JSON.stringify(checked.data);
 if(raw.length>262144)throw new Error("本任务草稿空间已满，请先发送或清空已有草稿。");
 storage.setItem(key,raw);
}
/** Messages are immutable and IDs are bigint strings. Preserve loaded pages when
 * the five-second metadata poll returns the first page again. */
export function mergeDiscussionDetail(previous:DiscussionDetail|null,next:DiscussionDetail,after="0"):DiscussionDetail{
 if(!previous||previous.thread.id!==next.thread.id)return next;
 const messages=new Map(previous.messages.map(m=>[m.id,m]));for(const m of next.messages)messages.set(m.id,m);
 const last=previous.messages.at(-1)?.id??"0",incoming=next.messages.at(-1)?.id??after;
 const newer=next.thread.version>=previous.thread.version?next:previous;
 return {...newer,messages:[...messages.values()].sort((a,b)=>BigInt(a.id)<BigInt(b.id)?-1:BigInt(a.id)>BigInt(b.id)?1:0),nextAfter:BigInt(incoming)>=BigInt(last)?next.nextAfter:previous.nextAfter};
}
