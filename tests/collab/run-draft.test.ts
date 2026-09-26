import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { readRunDraft, runDraftKeys, runComposerDraft, saveRunRequest } from "../../lib/collab/run-draft";
function storage() { const values = new Map<string,string>(); return { getItem:(key:string)=>values.get(key)??null, setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);} }; }
test("run composer and unconfirmed command survive reopening with exact identity and independent scopes",()=>{
 const s=storage(), user=randomUUID(), project=randomUUID(), task=randomUUID(), keys=runDraftKeys(user,project,task);
 const pending={repositoryId:randomUUID(),baseSha:"a".repeat(40),prompt:"Run the original fixed task",expectedVersion:7,idempotencyKey:randomUUID(),executionKind:"terminal" as const,snapshotId:randomUUID()};
 saveRunRequest(s,keys.pending,pending);
 s.setItem(keys.composer,JSON.stringify(runComposerDraft.parse({version:1,prompt:"New unsent text must not replace the pending body",executionKind:"ai",repositoryId:"",modelId:"",snapshotId:"",suggestionId:"",editorVersionId:""})));
 assert.deepEqual(readRunDraft(s,runDraftKeys(user,project,task)).pending,pending);
 for(const other of [runDraftKeys(randomUUID(),project,task),runDraftKeys(user,randomUUID(),task),runDraftKeys(user,project,randomUUID())])assert.deepEqual(readRunDraft(s,other),{composer:null,pending:null});
 saveRunRequest(s,keys.pending,null);assert.equal(readRunDraft(s,keys).pending,null);assert.match(readRunDraft(s,keys).composer!.prompt,/New unsent/);
});
test("invalid, oversized or unavailable run storage never silently creates a replacement request",()=>{
 const s=storage(),keys=runDraftKeys("u","p","t");
 s.setItem(keys.pending,'{"idempotencyKey":"broken"}');assert.throws(()=>readRunDraft(s,keys));
 s.setItem(keys.pending," ".repeat(131073));assert.throws(()=>readRunDraft(s,keys),/上限/);
 assert.throws(()=>saveRunRequest({setItem(){throw Error("quota");},removeItem(){}},keys.pending,{repositoryId:randomUUID(),baseSha:"b".repeat(40),prompt:"original",expectedVersion:1,idempotencyKey:randomUUID()}),/quota/);
 assert.throws(()=>readRunDraft({getItem(){throw Error("blocked");}},keys),/blocked/);
});
