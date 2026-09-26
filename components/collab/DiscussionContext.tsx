"use client";
import { useEffect,useRef,useState } from "react";
import { collabApi,CollabApiError } from "./api";
import { discussionContextInstruction,type DiscussionContextInstruction,type DiscussionContextPreview } from "@/lib/collab/discussion-context-schema";
import type { DiscussionDetail } from "@/lib/collab/discussion-schema";
export function DiscussionContext({runId,userId,detail,onSent}:{runId:string;userId:string;detail:DiscussionDetail;onSent:()=>void}){
 const [selected,setSelected]=useState<string[]>([]),[note,setNote]=useState("请结合所选讨论继续当前任务，并说明采纳或未采纳的理由。"),[kind,setKind]=useState<"steer"|"follow_up">("follow_up");
 const [preview,setPreview]=useState<DiscussionContextPreview|null>(null),[pending,setPending]=useState<DiscussionContextInstruction|null>(null),[ready,setReady]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
 const writing=useRef(false),key=`pi-collab:discussion-context:v1:${userId}:${runId}:${detail.thread.id}`;
 useEffect(()=>{
  try{const raw=sessionStorage.getItem(key);if(raw){const saved=discussionContextInstruction.parse(JSON.parse(raw));if(saved.threadId!==detail.thread.id)throw new Error("scope");setPending(saved);setSelected(saved.messageIds);setNote(saved.note);setKind(saved.kind);}setReady(true);}
  catch{setError("无法恢复原讨论交接请求，请先核对成员指令记录；尚未发送任何内容。");}
 },[key,detail.thread.id]);
 async function prepare(){
  if(busy||pending)return;setBusy(true);setError("");setNotice("");
  try{setPreview(await collabApi<DiscussionContextPreview>(`runs/${runId}/discussion-context`,{threadId:detail.thread.id,messageIds:selected}));}
  catch(e){setError(e instanceof Error?e.message:"读取交接内容失败");}finally{setBusy(false);}
 }
 async function send(){
  if(writing.current||!ready||(!preview&&!pending))return;writing.current=true;setBusy(true);setError("");
  try{
   const request=pending??discussionContextInstruction.parse({threadId:detail.thread.id,messageIds:preview!.source.messages.map(m=>m.id),sourceHash:preview!.sourceHash,expectedVersion:preview!.controlVersion,kind,note,idempotencyKey:crypto.randomUUID()});
   // Persist before sending, including the source hash and control version.
   sessionStorage.setItem(key,JSON.stringify(request));setPending(request);
   const result=await collabApi<{instructionId:string;status:string}>(`runs/${runId}/discussion-instructions`,request);
   try{sessionStorage.removeItem(key);}catch{setError("服务端已接纳，但无法清理本窗口记录。可重试同一编号核对，不会重复投递。");onSent();return;}setPending(null);setPreview(null);setSelected([]);setNotice(`所选讨论已保存到指令记录。运行接收状态请查看上方“成员指令记录”。编号 ${result.instructionId}`);onSent();
  }catch(e){
   if(e instanceof CollabApiError&&[400,409,413,422].includes(e.status)){
    try{sessionStorage.removeItem(key);setPending(null);setPreview(null);}catch{/* Keep original identity if storage is unavailable. */}
   }
   setError(e instanceof DOMException?"无法保存原请求编号，请允许会话存储后再发送。":e instanceof Error?e.message:"交接结果未确认，请重试同一请求。");
  }finally{writing.current=false;setBusy(false);}
 }
 const locked=busy||!!pending||!ready;
 return <details className="collab-form compact" aria-label="选取讨论交给 AI"><summary>选取讨论交给当前 AI</summary>
  <p>只有当前控制者可发送。先选择已加载的评论，再核对预览并确认；后续新回复不会自动加入。此操作不采纳代码补丁。</p>
  {error&&<p role="alert" className="collab-error">{error}</p>}{notice&&<p role="status">{notice}</p>}
  <fieldset disabled={locked}><legend>选择评论（最多 20 条）</legend>{detail.messages.map(m=><label className="collab-checkbox collab-prewrap" key={m.id}><input type="checkbox" aria-label={`选取评论 ${m.id}`} checked={selected.includes(m.id)} disabled={!selected.includes(m.id)&&selected.length>=20} onChange={e=>{setSelected(old=>e.target.checked?[...old,m.id]:old.filter(id=>id!==m.id));setPreview(null);}}/>{m.author_name} · {m.body}</label>)}</fieldset>
  <label>处理方式<select aria-label="讨论交接方式" value={kind} disabled={locked} onChange={e=>setKind(e.target.value as typeof kind)}><option value="follow_up">当前工作后继续</option><option value="steer">调整当前方向</option></select></label>
  <label>给 AI 的交接说明<textarea aria-label="讨论交接说明" maxLength={2000} value={note} disabled={locked} onChange={e=>setNote(e.target.value)}/></label>
  <button type="button" className="collab-text-button" disabled={locked||!selected.length} onClick={()=>void prepare()}>预览所选讨论</button>
  {preview&&!pending&&<div className="collab-snapshot-card" aria-label="讨论交接预览"><strong>{preview.source.title}</strong><p>{preview.source.resolved?"原讨论已解决":"原讨论待讨论"} · 共 {preview.source.messages.length} 条评论</p>
   {preview.source.anchor&&<p className="collab-git-identity">固定快照 {preview.source.anchor.snapshotId} · {preview.source.anchor.path} · 第 {preview.source.anchor.startLine}–{preview.source.anchor.endLine} 行</p>}
   {preview.source.reviewAnchor&&<p className="collab-git-identity">固定差异 {preview.source.reviewAnchor.path} · {preview.source.reviewAnchor.side==="before"?"旧侧":"新侧"}第 {preview.source.reviewAnchor.startLine}–{preview.source.reviewAnchor.endLine} 行</p>}
   {preview.source.messages.map(m=><div key={m.id}><strong>{m.authorName}</strong><p className="collab-prewrap">{m.body}</p></div>)}
   <button type="button" className="collab-button" disabled={busy||!note.trim()} onClick={()=>void send()}>确认发送给当前 AI</button>
  </div>}
  {pending&&<div className="collab-form compact"><p>原请求编号已保留；请重试核对是否已接纳，不会换编号重复发送。所选评论：{pending.messageIds.join("、")}</p><button type="button" className="collab-button" disabled={busy} onClick={()=>void send()}>重试同一讨论交接</button></div>}
 </details>;
}
