import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { discussionDraftKey, emptyDiscussionDraft, readDiscussionDraft, writeDiscussionDraft, mergeDiscussionDetail } from "../../lib/collab/discussion-draft";
import type { DiscussionDetail } from "../../lib/collab/discussion-schema";
class StorageFixture implements Storage {
 data=new Map<string,string>();get length(){return this.data.size;}clear(){this.data.clear();}key(i:number){return [...this.data.keys()][i]??null;}getItem(k:string){return this.data.get(k)??null;}setItem(k:string,v:string){this.data.set(k,v);}removeItem(k:string){this.data.delete(k);}
}
test("discussion drafts retain exact pending identity, code anchors and per-thread replies in the same account/task/source scope",()=>{
 const storage=new StorageFixture(),task=randomUUID(),thread=randomUUID(),key=discussionDraftKey("owner",task);
 const anchor={kind:"pull" as const,sourceId:randomUUID(),sourceHash:"a".repeat(64),diffHash:"b".repeat(64),path:"src/a.ts",side:"after" as const,startLine:2,endLine:4};
 const value={...emptyDiscussionDraft(),title:"Unsent discussion",body:"Review exact source",reviewAnchor:anchor,replies:{[thread]:{body:"Only this thread",mentions:["peer"]}},pending:{action:"reply" as const,threadId:thread,body:"Fixed request",mentions:[],idempotencyKey:randomUUID()}};
 writeDiscussionDraft(storage,key,value);assert.deepEqual(readDiscussionDraft(storage,key),value);
 assert.equal(readDiscussionDraft(storage,discussionDraftKey("peer",task)).pending,null);
 assert.equal(readDiscussionDraft(storage,discussionDraftKey("owner",randomUUID())).pending,null);
 assert.notEqual(key,discussionDraftKey("owner",task,anchor));
 assert.notEqual(discussionDraftKey("owner",task,anchor),discussionDraftKey("owner",task,{...anchor,startLine:3}));
 assert.equal(discussionDraftKey("owner",task,anchor),discussionDraftKey("owner",task,{...anchor,endLine:5}));
 storage.setItem(key,"broken");assert.throws(()=>readDiscussionDraft(storage,key));
});
test("discussion refresh preserves expanded history and tail, deduplicates overlap and compares bigint IDs without rounding",()=>{
 const id=randomUUID(),thread={id,task_id:randomUUID(),title:"Discussion",author_id:"author",author_name:"Author",anchor:null,review_anchor:null,replacement:null,resolved:false,version:1,created_at:"2026-09-24"};
 const message=(id:string)=>({id,author_name:"Author",body:id,mentions:[],created_at:"2026-09-24"});
 const page=(ids:string[],nextAfter:string|null):DiscussionDetail=>({thread,messages:ids.map(message),nextAfter,applications:[]});
 const a="9007199254740992",b="9007199254740993",c="9007199254740994";
 const first=page([a],a),more=mergeDiscussionDetail(first,page([b],null),a);
 assert.deepEqual(mergeDiscussionDetail(more,first).messages.map(m=>m.id),[a,b]);assert.equal(mergeDiscussionDetail(more,first).nextAfter,null);
 const tail=mergeDiscussionDetail(more,page([b,c],null),a);assert.deepEqual(tail.messages.map(m=>m.id),[a,b,c]);
 assert.deepEqual(mergeDiscussionDetail(tail,page([],null),c).messages,tail.messages);
 const resolved={...tail,thread:{...thread,version:2,resolved:true}};
 assert.equal(mergeDiscussionDetail(resolved,first).thread.resolved,true);
 const other={...first,thread:{...thread,id:randomUUID()}};assert.deepEqual(mergeDiscussionDetail(tail,other),other);
});
