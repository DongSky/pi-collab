// Browser-only, synchronous persistence: an edit is durable before page teardown.
// Each mounted editor owns a separate slot, so another tab's acknowledgement
// cannot erase it. Never evict an unsent draft to make room for a new one.
export type DraftScope = { userId: string; sessionId: string; documentId: string; snapshotId: string; manifestHash: string };
export type EditorDraft = DraftScope & { key: string; state: string; text: string; savedAt: number; base?: { text:string;revision:string;token:string }; conflict?: {base:string;local:string;remote:string;merged:string;revision:string;baseToken:string}; resolutionText?:string; storedValue?:string };
const prefix = "pi-collab:editor-draft:v1:";
const maxBytes = 4 * 1024 * 1024;
export function draftKey(scope: DraftScope, slot: string) {
  return prefix + [scope.userId, scope.sessionId, scope.documentId, scope.snapshotId, scope.manifestHash, slot].map(encodeURIComponent).join(":");
}
export function readDrafts(storage: Storage, scope: DraftScope): EditorDraft[] {
  const start = draftKey(scope, "");
  const drafts: EditorDraft[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith(start)) continue;
    try {
      const raw=storage.getItem(key);
      const d = JSON.parse(raw ?? "null");
      if (d && Object.entries(scope).every(([k, v]) => d[k] === v) && typeof d.state === "string" && d.state.length <= 1400000 && typeof d.text === "string" && d.text.length <= 262144 && Number.isFinite(d.savedAt)) {
       const base=d.base&&typeof d.base.text==="string"&&d.base.text.length<=262144&&typeof d.base.revision==="string"&&/^\d{1,18}$/.test(d.base.revision)&&typeof d.base.token==="string"&&/^[a-f0-9]{64}$/.test(d.base.token)?d.base:undefined;
       const conflict=d.conflict&&["base","local","remote","merged"].every(k=>typeof d.conflict[k]==="string"&&d.conflict[k].length<=1048576)&&typeof d.conflict.revision==="string"&&/^\d{1,18}$/.test(d.conflict.revision)&&typeof d.conflict.baseToken==="string"&&/^[a-f0-9]{64}$/.test(d.conflict.baseToken)?d.conflict:undefined;
       const draft={ ...d, key,base,conflict,resolutionText:typeof d.resolutionText==="string"&&d.resolutionText.length<=1048576?d.resolutionText:undefined };
       for(const field of ["base","conflict","resolutionText"])if(draft[field]===undefined)delete draft[field];
       Object.defineProperty(draft,"storedValue",{value:raw,enumerable:false});drafts.push(draft);
      }
    } catch { /* An invalid record is never applied or silently removed. */ }
  }
  return drafts.sort((a, b) => b.savedAt - a.savedAt);
}
export function saveDraft(storage: Storage, draft: EditorDraft) {
  if (draft.state.length > 1400000 || draft.text.length > 262144) throw new Error("草稿超过本机保存上限，请导出文本后再关闭。");
  const value = JSON.stringify(draft);
  let bytes = (draft.key.length + value.length) * 2;
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(prefix) && key !== draft.key) bytes += (key.length + (storage.getItem(key)?.length ?? 0)) * 2;
  }
  if (bytes > maxBytes) throw new Error("本机草稿空间已满，请导出或处理旧草稿后再关闭。");
  storage.setItem(draft.key, value);
}
export function removeDraft(storage: Storage, draft: EditorDraft) {
  // A newer write from the original tab wins over this recovery UI.
  if (storage.getItem(draft.key) === (draft.storedValue??JSON.stringify(draft))) storage.removeItem(draft.key);
}
