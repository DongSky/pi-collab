"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { previewPiHistory, type HistoryMessage } from "@/lib/collab/history-format";
import { HistoryArchives } from "./HistoryArchives";
import { collabApi } from "./api";
type Row = {id:string;title:string;owner_id:string;owner_name:string;shared:boolean;message_count:number};
export function HistoryImport({projectId,userId,canWrite}:{projectId:string;userId:string;canWrite:boolean}) {
 const [rows,setRows]=useState<Row[]>([]),[preview,setPreview]=useState<(HistoryMessage & {selected:boolean})[]>([]),[title,setTitle]=useState("");
 const [shared,setShared]=useState(false),[reviewed,setReviewed]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState(""),[busy,setBusy]=useState(false);
 const [opened,setOpened]=useState<{id:string;title:string;messages:HistoryMessage[]}|null>(null);
 const errorView=useRef<HTMLParagraphElement>(null);
 useEffect(()=>{if(error)errorView.current?.scrollIntoView({block:"nearest"});},[error]);
 const base=`projects/${projectId}/history`;
 const load=useCallback(async()=>setRows((await collabApi<{histories:Row[]}>(base)).histories),[base]);
 useEffect(()=>{void load().catch(e=>setError(e.message));},[load]);
 const act=async(work:()=>Promise<void>)=>{setBusy(true);setError("");setNotice("");try{await work();}catch(e){setError(e instanceof Error?e.message:"操作失败");}finally{setBusy(false);}};
 return <section className="collab-editor-panel" aria-label="个人历史导入"><h2>个人历史</h2>
 <p className="collab-muted">文字摘录导入：选择自己的 Pi JSONL 文件，勾选并编辑要保留的文字。此方式只上传所选文字，工具输出、系统指令、思考、图片和本机路径元数据不上传。</p>
 <p className="collab-small">导入和删除历史需要启用多因素验证。<Link href="/account">前往账户安全</Link>；未启用时仍可在本页预览所选文字。</p>
 {error&&<p ref={errorView} className="collab-error" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
 {canWrite&&<div className="collab-form"><label>选择 Pi 会话文件<input type="file" accept=".jsonl" disabled={busy} onChange={event=>{const file=event.target.files?.[0];setPreview([]);setReviewed(false);setOpened(null);if(file)void act(async()=>{if(file.size>5*1024*1024)throw new Error("文件超过 5 MiB。");setPreview(previewPiHistory(await file.text()).map(message=>({...message,selected:false})));setTitle("导入的个人会话");});}}/></label>
 {preview.length>0&&<><label>记录名称<input value={title} maxLength={200} onChange={e=>setTitle(e.target.value)}/></label><p>共 {preview.length} 条候选消息；按文件顺序展示，可能包含不同历史分支。请选择需要的内容。</p>
 {preview.map((message,index)=><details key={index}><summary>{index+1}. {message.role==="user"?"历史用户（身份未核验）":"历史助手"} · {message.selected?"已选择":"未选择"}</summary><label><input type="checkbox" checked={message.selected} onChange={e=>{setReviewed(false);setPreview(current=>current.map((m,i)=>i===index?{...m,selected:e.target.checked}:m));}}/>导入此条</label><textarea aria-label={`历史消息 ${index+1}`} rows={4} value={message.text} onChange={e=>{setReviewed(false);setPreview(current=>current.map((m,i)=>i===index?{...m,text:e.target.value}:m));}}/></details>)}
 <label><input type="checkbox" checked={shared} onChange={e=>{setShared(e.target.checked);setReviewed(false);}}/>向此项目当前及未来有权限的成员共享（默认仅自己）</label>
 <label><input type="checkbox" checked={reviewed} onChange={e=>setReviewed(e.target.checked)}/>我已核对所选文字、删除密钥及不应导入的内容，并确认上述可见范围</label>
 <button className="collab-button primary" disabled={busy||!reviewed||!preview.some(m=>m.selected)} onClick={()=>void act(async()=>{const result=await collabApi<{id:string;replayed:boolean}>(base,{title,shared,reviewed,messages:preview.filter(m=>m.selected).map(({role,text})=>({role,text}))});setPreview([]);setReviewed(false);await load();setNotice(result.replayed?"相同记录已经导入，已保留原记录。":"已导入；历史只用于查阅，不会自动成为 AI 指令。");})}>导入所选文字</button></>}
 </div>}
 <h3>已导入文字摘录</h3><p className="collab-muted">最近 100 条。导入者不代表历史操作者；这些记录不恢复运行、分支或工作区。</p>
 {rows.map(row=><div className="collab-dependency" key={row.id}><button className="collab-text-button" disabled={busy} onClick={()=>void act(async()=>setOpened(await collabApi(`${base}/${row.id}`)))}>{row.title}</button><small>{row.message_count} 条 · {row.shared?"项目共享":"仅自己"} · {row.owner_name} 导入</small>{row.owner_id===userId&&<button className="collab-text-button" disabled={busy} onClick={()=>void act(async()=>{await collabApi(`${base}/${row.id}`,{},"DELETE");if(opened?.id===row.id)setOpened(null);await load();setNotice("记录已删除；审计保留操作信息。");})}>删除导入记录</button>}</div>)}
 {!rows.length&&<p>还没有可见的导入记录。</p>}
 {opened&&<article><h3>{opened.title}</h3>{opened.messages.map((message,index)=><div key={index}><strong>{message.role==="user"?"历史用户（身份未核验）":"历史助手"}</strong><p className="collab-prewrap">{message.text}</p></div>)}</article>}
 <HistoryArchives projectId={projectId} userId={userId} canWrite={canWrite}/>
 </section>;
}
