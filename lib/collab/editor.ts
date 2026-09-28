import { editorBaseToken, validEditorBase, mergeEditorText } from "./editor-merge";
import path from "node:path";
import { isUtf8 } from "node:buffer";
import * as Y from "yjs";
import { z } from "zod";
import type { PoolClient } from "pg";
import { asUser } from "./database";
import { DomainError } from "./policy";
import { loadSnapshot, safeSnapshotPath, snapshotExcludedPath, snapshotHasSecret } from "./runtime/snapshots";
import { documentSaveAs, documentInput, documentSync, editorAction, editorOpen, type EditorDetail, type EditorSession, type EditorSync, type EditorWriteback } from "./editor-schema";
import { runDocumentWriteback } from "./local-writeback";
const root = () => process.env.PI_COLLAB_DATA_DIR ?? path.resolve(".local");
const invalid = () => new DomainError("editor_content_unavailable", "此文件包含受限路径、非文本内容或超出共编限制。", 400);
export function validateEditorPath(file: string) { if (!safeSnapshotPath(file) || snapshotExcludedPath(file)) throw invalid(); }
export function validateEditorText(text: string) { const b = Buffer.from(text); if (b.length > 262144 || b.includes(0) || !isUtf8(b) || snapshotHasSecret(b)) throw invalid(); }
async function session(db: PoolClient, id: string) {
 const row = (await db.query(`SELECT s.*, t.owner_id,collab.project_role(s.project_id) AS role FROM collab.editor_sessions s JOIN collab.tasks t ON t.id=s.task_id WHERE s.id=$1`, [id])).rows[0];
 if (!row) throw new DomainError("not_found", "共编草稿不存在或不可访问。", 404); return row;
}
const writable = (s: { role: string; state: string }) => ["maintainer", "developer"].includes(s.role) && s.state === "editing";
export function listEditors(userId: string, taskId: string): Promise<{ sessions: EditorSession[] }> {
 z.uuid().parse(taskId); return asUser(userId, async db => ({ sessions: (await db.query("SELECT * FROM collab.editor_sessions WHERE task_id=$1 ORDER BY created_at DESC LIMIT 30", [taskId])).rows }));
}
export function openEditor(userId: string, taskId: string, raw: unknown) {
 z.uuid().parse(taskId); const input = editorOpen.parse(raw); return asUser(userId, async db => ({ id: (await db.query("SELECT collab.open_editor($1,$2,$3) AS id", [taskId,input.snapshotId,input.expectedVersion])).rows[0].id as string }));
}
export function editorDetail(userId: string, id: string): Promise<EditorDetail> {
 z.uuid().parse(id); return asUser(userId, async db => {
  const s = await session(db,id), saved = await loadSnapshot(root(),s.snapshot_id,s.manifest_hash);
  return { session:s, canWrite:writable(s), canManage:s.role === "maintainer" || s.role === "developer" && s.owner_id === userId,
   files:saved.manifest.worktree.map(f=>f.path), documents:(await db.query("SELECT id,path,deleted,revision FROM collab.editor_documents WHERE session_id=$1 ORDER BY path",[id])).rows,
   versions:(await db.query("SELECT id,version,note,created_at,payload FROM collab.editor_versions WHERE session_id=$1 ORDER BY version DESC LIMIT 30",[id])).rows };
 });
}
export function editorCommand(userId: string, id: string, raw: unknown) {
 z.uuid().parse(id); const input=editorAction.parse(raw); return asUser(userId,async db=>(await (input.action==="copy" ? db.query("SELECT collab.copy_editor($1,$2,$3) AS result",[id,input.expectedVersion,input.note]) : db.query("SELECT collab.editor_checkpoint($1,$2,$3,$4) AS result",[id,input.action,input.expectedVersion,input.note]))).rows[0].result);
}
export function openDocument(userId: string,id: string,raw: unknown): Promise<{ id: string }> {
 z.uuid().parse(id); const input=documentInput.parse(raw); validateEditorPath(input.path);
 return asUser(userId,async db=>{
  await db.query("SELECT collab.editor_lock($1,false,false)",[id]); const s=await session(db,id);
  const found=(await db.query("SELECT id FROM collab.editor_documents WHERE session_id=$1 AND path=$2",[id,input.path])).rows[0]; if(found) return found;
  const saved=await loadSnapshot(root(),s.snapshot_id,s.manifest_hash),entry=saved.manifest.worktree.find(f=>f.path===input.path);
  if(input.create){const paths=[...saved.manifest.worktree.map(f=>f.path),...(await db.query("SELECT path FROM collab.editor_documents WHERE session_id=$1",[id])).rows.map(r=>r.path as string)];if(paths.some(p=>p.startsWith(`${input.path}/`)||input.path.startsWith(`${p}/`)))throw new DomainError("editor_target_exists","目标与现有文件或目录冲突。",409);}
  if (!entry && !input.create) throw invalid(); if (entry && input.create) throw new DomainError("editor_exists","文件已存在，请直接打开。",409);
  const bytes=entry?saved.blobs.get(entry.hash)!:Buffer.alloc(0); if(!isUtf8(bytes))throw invalid();const initial=bytes.toString("utf8");validateEditorText(initial);
  const doc=new Y.Doc();try{doc.getText("code").insert(0,initial);return{id:(await db.query("SELECT collab.save_editor_document($1,$2,$3,$4,$4,$5,0,false) AS id",[id,input.path,entry?.hash??null,initial,Buffer.from(Y.encodeStateAsUpdate(doc))])).rows[0].id};}finally{doc.destroy();}
 });
}
export function syncDocument(userId: string,id: string,raw: unknown): Promise<EditorSync> {
 z.uuid().parse(id);const input=documentSync.parse(raw);
 return asUser(userId,async db=>{
  const changing=input.update!==undefined||input.deleted!==undefined;
  await db.query("SELECT collab.editor_lock($1,$2,false)",[id,changing]);
  const s=await session(db,id); let d=(await db.query("SELECT * FROM collab.editor_documents WHERE id=$1 AND session_id=$2",[input.documentId,id])).rows[0];
  if(!d)throw new DomainError("not_found","文件不存在或不可访问。",404);
  let conflict:EditorSync["conflict"],merged=false,writeback:EditorWriteback|undefined;
  const doc=new Y.Doc();try{
   Y.applyUpdate(doc,d.y_state);const text=doc.getText("code");
   if(changing){
    if(input.deleted!==undefined && input.expectedRevision!==d.revision)throw new DomainError("stale_revision","文件已改变，请刷新后重试。",409);
    if(d.deleted && input.update)throw new DomainError("editor_frozen","文件已删除；本地未同步内容可导出。",409);
    let checkedText:string|undefined;
    if(input.update){
     if(!input.expectedRevision||input.baseText===undefined||!input.baseToken||input.localText===undefined)throw new DomainError("editor_upgrade_required","保存需要版本校验，请刷新编辑器后恢复本机草稿。",409);
     if(!validEditorBase(d.id,input.expectedRevision,input.baseText,input.baseToken))throw new DomainError("editor_invalid_base","保存基线无法验证，请重新打开文件并恢复本机草稿。",409);
     validateEditorText(input.baseText);validateEditorText(input.localText);
     if(input.resolution&&/^(<{7}|={7}|>{7}|\|{7})(?: |$)/m.test(input.localText))throw new DomainError("editor_unresolved_markers","请先处理全部冲突标记。",409);
     const result=await mergeEditorText(input.baseText,input.localText,d.content);
     if(result.conflicted||(input.resolution&&input.expectedRevision!==d.revision&&input.localText!==d.content))conflict={base:input.baseText,local:input.localText,remote:d.content,merged:result.text,revision:d.revision,baseToken:editorBaseToken(d.id,d.revision,d.content)};
     else {checkedText=result.text;merged=input.expectedRevision!==d.revision;}
    }
    if(!conflict){
    try{if(input.update)Y.applyUpdate(doc,Buffer.from(input.update,"base64"));}catch{throw invalid();}
    if(doc.share.size!==1||[...doc.share.keys()][0]!=="code"||text.toDelta().some((p: { insert: unknown; attributes?: unknown })=>typeof p.insert!=="string"||p.attributes))throw invalid();
    if(checkedText!==undefined&&checkedText!==text.toString()){
     // Keep Yjs identities where possible; Git's three-way result decides text semantics.
     const before=text.toString();let start=0,end=0;while(start<before.length&&start<checkedText.length&&before[start]===checkedText[start])start++;
     while(end<before.length-start&&end<checkedText.length-start&&before[before.length-1-end]===checkedText[checkedText.length-1-end])end++;
     // Y.Text normalizes surrogate splits; keep replacement boundaries on whole code points.
     const splits=(value:string,index:number)=>index>0&&index<value.length&&/[\uD800-\uDBFF]/.test(value[index-1])&&/[\uDC00-\uDFFF]/.test(value[index]);
     if(splits(before,start)||splits(checkedText,start))start--;
     if(splits(before,before.length-end)||splits(checkedText,checkedText.length-end))end--;
     doc.transact(()=>{text.delete(start,before.length-start-end);text.insert(start,checkedText.slice(start,checkedText.length-end));});
    }
    validateEditorText(text.toString());const state=Buffer.from(Y.encodeStateAsUpdate(doc));if(state.length>1048576)throw invalid();
    // Reject unresolved causal updates: a successful acknowledgement must persist every submitted edit.
    if(doc.store.pendingStructs||doc.store.pendingDs)throw new DomainError("editor_incomplete_update","缺少前序编辑，请重新同步完整草稿。",409);
    const markedDeleted=input.deleted===true;
    await db.query("SELECT collab.save_editor_document($1,$2,$3,$4,$5,$6,$7,$8)",[id,d.path,d.base_hash,d.original_text,text.toString(),state,d.revision,input.deleted??d.deleted]);
    d=(await db.query("SELECT * FROM collab.editor_documents WHERE id=$1",[d.id])).rows[0];
    // Direct-link mode: mirror the saved content into the bound local directory
    // with the same three-way merge semantics. Write-back never fails the save.
    writeback=await runDocumentWriteback(db,s.project_id,{id:d.id,path:d.path,content:d.content,original_text:d.original_text},{deleted:markedDeleted}).catch(error=>({status:"error",message:error instanceof Error?error.message:"本地回写失败"} as EditorWriteback));
    }
   }
   let selection:unknown=null;
   if(input.selection!=null){
    try{const cursor=z.object({anchor:z.any(),head:z.any()}).strict().parse(input.selection);for(const point of [cursor.anchor,cursor.head]){const position=Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(point),doc);if(!position||position.type!==text)throw invalid();}selection=cursor;}catch{selection=null;}
   }
   await db.query("SELECT collab.touch_editor_presence($1,$2,$3)",[d.id,input.clientId,selection===null?null:JSON.stringify(selection)]);
   const presence=(await db.query(`SELECT p.client_id::float8 AS "clientId",p.user_id AS "userId",u.name,p.selection FROM collab.editor_presence p JOIN public."user" u ON u.id=p.user_id JOIN collab.project_memberships pm ON pm.user_id=p.user_id AND pm.project_id=$2 AND pm.active JOIN collab.memberships m ON m.user_id=p.user_id AND m.organization_id=pm.organization_id AND m.active WHERE p.document_id=$1 AND p.seen_at>now()-interval '30 seconds' ORDER BY p.client_id`,[d.id,s.project_id])).rows;
   const updated=await session(db,id);return {conflict,merged,writeback,document:{id:d.id,path:d.path,deleted:d.deleted,revision:d.revision,state:d.y_state.toString("base64"),baseToken:editorBaseToken(d.id,d.revision,d.content)},session:updated,canWrite:writable(updated)&&!d.deleted,presence};
  }finally{doc.destroy();}
 });
}

/** Atomic copy of an acknowledged shared file; never overwrite a peer's destination. */
export function saveDocumentAs(userId:string,id:string,raw:unknown):Promise<{id:string;path:string}> { return copyOrMoveDocument(userId,id,raw,false); }
export function renameDocument(userId:string,id:string,raw:unknown):Promise<{id:string;path:string}> { return copyOrMoveDocument(userId,id,raw,true); }
function copyOrMoveDocument(userId:string,id:string,raw:unknown,move:boolean):Promise<{id:string;path:string}> {
 z.uuid().parse(id);const input=documentSaveAs.parse(raw);validateEditorPath(input.path);
 return asUser(userId,async db=>{
  await db.query("SELECT collab.editor_lock($1,true,false)",[id]);const s=await session(db,id);
  const source=(await db.query("SELECT * FROM collab.editor_documents WHERE id=$1 AND session_id=$2",[input.documentId,id])).rows[0];
  if(!source)throw new DomainError("not_found","来源文件不存在或不可访问。",404);
  if(source.deleted)throw new DomainError("editor_frozen","来源文件已删除，不能另存为。",409);
  if(source.revision!==input.expectedRevision)throw new DomainError("stale_revision","来源文件已被协作者修改，请同步后重试另存为。",409);
  const saved=await loadSnapshot(root(),s.snapshot_id,s.manifest_hash);
  const paths=[...saved.manifest.worktree.map(f=>f.path),...(await db.query("SELECT path FROM collab.editor_documents WHERE session_id=$1",[id])).rows.map(r=>r.path as string)];
  if(paths.some(p=>p===input.path||p.startsWith(`${input.path}/`)||input.path.startsWith(`${p}/`)))throw new DomainError("editor_target_exists","目标路径已存在或与文件目录冲突，请使用新文件名。",409);
  validateEditorText(source.content);const doc=new Y.Doc();
  try{doc.getText("code").insert(0,source.content);const result=await db.query("SELECT collab.save_editor_document($1,$2,NULL,'',$3,$4,0,false) AS id",[id,input.path,source.content,Buffer.from(Y.encodeStateAsUpdate(doc))]);if(move)await db.query("SELECT collab.save_editor_document($1,$2,$3,$4,$5,$6,$7,true)",[id,source.path,source.base_hash,source.original_text,source.content,source.y_state,source.revision]);return {id:result.rows[0].id,path:input.path};}finally{doc.destroy();}
 });
}

export function editorFolder(userId:string,id:string){
 z.uuid().parse(id);return asUser(userId,async db=>{
  await session(db,id);
  const row=(await db.query("SELECT r.id,r.name,r.base_sha FROM collab.editor_sessions e JOIN collab.snapshots s ON s.id=e.snapshot_id JOIN collab.workspaces w ON w.id=s.workspace_id JOIN collab.repositories r ON r.id=w.repository_id WHERE e.id=$1",[id])).rows[0];
  if(!row)throw new DomainError("not_found","工作文件夹不存在或不可访问。",404);
  return {repositoryId:row.id,name:row.name,baseSha:row.base_sha};
 });
}
