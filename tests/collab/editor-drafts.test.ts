import test from "node:test";
import assert from "node:assert/strict";
import { draftKey, readDrafts, saveDraft, removeDraft, type EditorDraft } from "../../lib/collab/editor-drafts";
class MemoryStorage implements Storage {
  data = new Map<string, string>();
  get length() { return this.data.size; }
  clear() { this.data.clear(); }
  getItem(key: string) { return this.data.get(key) ?? null; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  removeItem(key: string) { this.data.delete(key); }
  setItem(key: string, value: string) { this.data.set(key, value); }
}
const scope = { userId: "member", sessionId: "room", documentId: "file", snapshotId: "snapshot", manifestHash: "hash" };
function draft(slot: string): EditorDraft { return { ...scope, key: draftKey(scope, slot), state: "AA==", text: "unsent", savedAt: 1 }; }
test("drafts survive reopening with exact account/room/file/baseline scope; tab acknowledgements preserve other and newer drafts", () => {
  const storage = new MemoryStorage(), a = draft("tab-a"), b = draft("tab-b");
  saveDraft(storage, a); saveDraft(storage, b);
  assert.equal(readDrafts(storage, scope).length, 2);
  for (const field of Object.keys(scope)) assert.deepEqual(readDrafts(storage, { ...scope, [field]: "other" }), []);
  const newer = { ...a, state: "AQ==", text: "new edit", savedAt: 2 }; saveDraft(storage, newer);
  removeDraft(storage, a); assert.equal(readDrafts(storage, scope).length, 2);
  removeDraft(storage, b); assert.deepEqual(readDrafts(storage, scope), [newer]);
  removeDraft(storage, newer); assert.equal(storage.length, 0);
});
test("cache limits and unavailable storage fail without evicting pending edits", () => {
  const storage = new MemoryStorage(), original = draft("original"); saveDraft(storage, original);
  assert.throws(() => saveDraft(storage, { ...draft("large"), text: "x".repeat(262145) }), /上限/);
  for (let i = 0; i < 3; i++) saveDraft(storage, { ...draft(String(i)), state: "x".repeat(500000) });
  assert.throws(() => saveDraft(storage, { ...draft("full"), state: "x".repeat(1400000) }), /空间已满/);
  assert.ok(readDrafts(storage, scope).some(d => d.key === original.key));
  storage.setItem = () => { throw new Error("QuotaExceededError"); };
  assert.throws(() => saveDraft(storage, draft("blocked")), /QuotaExceededError/);
  assert.ok(readDrafts(storage, scope).some(d => d.key === original.key));
});
test("conflict bases and manual candidates survive recovery; corrupt metadata is safely discarded",()=>{
 const storage=new MemoryStorage(),entry={...draft("conflict"),base:{text:"base",revision:"1",token:"a".repeat(64)},conflict:{base:"base",local:"mine",remote:"theirs",merged:"conflict markers",revision:"2",baseToken:"b".repeat(64)},resolutionText:"manual candidate"};
 saveDraft(storage,entry);const loaded=readDrafts(storage,scope)[0];assert.deepEqual(loaded,entry);assert.equal(loaded.resolutionText,"manual candidate");
 saveDraft(storage,{...entry,resolutionText:"newer candidate"});removeDraft(storage,loaded);assert.equal(readDrafts(storage,scope)[0].resolutionText,"newer candidate");
 storage.setItem(entry.key,JSON.stringify({...entry,base:{wrong:true},conflict:{bad:true}}));const safe=readDrafts(storage,scope)[0];assert.equal(safe.base,undefined);assert.equal(safe.conflict,undefined);assert.equal(safe.text,"unsent");removeDraft(storage,safe);assert.equal(storage.length,0);
});
