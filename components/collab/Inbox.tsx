"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { collabApi } from "./api";
import type { InboxPage } from "@/lib/collab/discussion-schema";
import { notificationLabels as labels } from "@/lib/collab/notification-schema";
export function Inbox({ onOpen }: { onOpen: (projectId:string,taskId:string,threadId:string|null)=>void }) {
 const [page,setPage]=useState<InboxPage|null>(null),[before,setBefore]=useState<string|undefined>(),[open,setOpen]=useState(false),[error,setError]=useState("");
 const [hours,setHours]=useState("1"),[saving,setSaving]=useState(false);
 const generation=useRef(0);
 const invalidate=useCallback(()=>{generation.current+=1;},[]);
 const refresh=useCallback(async()=>{
  const current=++generation.current;
  try{const result=await collabApi<InboxPage>(`inbox${before ? `?before=${before}` : ""}`);if(current===generation.current){setPage(result);setError("");}}
  catch(e){if(current===generation.current){setPage(null);setError(e instanceof Error?e.message:"读取收件箱失败");}}
 },[before]);
 useEffect(()=>{void refresh();const timer=setInterval(()=>{if(!document.hidden)void refresh();},10000);return()=>{invalidate();clearInterval(timer);};},[refresh,invalidate]);
 async function mark(ids:string[],read:boolean){try{await collabApi("inbox",{ids,read});await refresh();}catch(e){setError(e instanceof Error?e.message:"更新通知失败");}}
 async function quiet(enabled:boolean){
  if(!page||saving)return;setSaving(true);setError("");
  try{
   await collabApi("inbox/preferences",{expectedVersion:page.preferences.version,quietUntil:enabled?new Date(Date.now()+Number(hours)*3600000).toISOString():null},"PUT");
   await refresh();
  }catch(e){await refresh();setError(e instanceof Error?e.message:"设置结果未确认，请刷新核对当前静默状态。");}
  finally{setSaving(false);}
 }
 return <section aria-label="站内收件箱" className="collab-inbox">
 <button className="collab-text-button" aria-expanded={open} onClick={()=>{setOpen(!open);if(!open)void refresh();}}>收件箱{page?.preferences.quiet ? " · 已静默" : page?.unread ? ` · ${page.unread} 条未读` : ""}</button>
 {open && <div className="collab-snapshot-card"><h2>站内收件箱</h2>{error && <p role="alert" className="collab-error">{error}</p>}
 {page && <div className="collab-form compact" aria-label="通知静默设置">
  <p>静默期间隐藏未读提示，通知仍保留在收件箱，不会自动标为已读。</p>
  {page.preferences.quiet && <p role="status">已静默至 {new Date(page.preferences.quietUntil!).toLocaleString()}；仍有 {page.unread} 条未读通知。</p>}
  <label>静默时长<select aria-label="通知静默时长" value={hours} disabled={saving} onChange={e=>setHours(e.target.value)}><option value="1">1 小时</option><option value="8">8 小时</option><option value="24">24 小时</option></select></label>
  <button className="collab-text-button" disabled={saving} onClick={()=>void quiet(true)}>{page.preferences.quiet?"重新设置静默时间":"开始静默"}</button>
  {page.preferences.quiet && <button className="collab-text-button" disabled={saving} onClick={()=>void quiet(false)}>恢复未读提示</button>}
 </div>}
 {page?.items.length===0 && <p>暂无通知。任务订阅接收讨论、运行和交付结果；控制申请会通知当前控制者。</p>}
 {!!page?.items.some(n=>!n.read_at) && <button className="collab-text-button" onClick={()=>void mark(page.items.filter(n=>!n.read_at).map(n=>n.id),true)}>本页全部标为已读</button>}
 {page?.items.map(n=><article key={n.id} className="collab-form compact"><button className="collab-text-button" onClick={()=>{onOpen(n.project_id,n.task_id,n.thread_id);void mark([n.id],true);setOpen(false);}}>{!n.read_at && "● "}{n.actor_name ? n.actor_name+" · " : ""}{labels[n.kind]??n.kind}<br/>{n.project_name} / {n.task_title}</button><small>{new Date(n.created_at).toLocaleString()}</small><button className="collab-text-button" onClick={()=>void mark([n.id],!!n.read_at)}>{n.read_at ? "标为未读" : "标为已读"}</button></article>)}
 {before && <button onClick={()=>setBefore(undefined)}>返回最新通知</button>}{page?.nextBefore && <button onClick={()=>setBefore(page.nextBefore!)}>更早通知</button>}
 </div>}
 </section>;
}
