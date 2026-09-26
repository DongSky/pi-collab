"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { DiscussionContext } from "./DiscussionContext";
import { collabApi, CollabApiError } from "./api";
import { useDiscussionDraft } from "@/hooks/useDiscussionDraft";
import { discussionDraftKey, mergeDiscussionDetail } from "@/lib/collab/discussion-draft";
import { discussionInput, sourceLines, type CodeAnchor, type DiscussionInput, type DiscussionListing, type DiscussionDetail, type SnapshotCode, type SnapshotFile } from "@/lib/collab/discussion-schema";
import type { ReviewAnchor } from "@/lib/collab/review-discussion-schema";
import type { Snapshot } from "./TaskSnapshots";
type Member = { user_id: string; name: string };
function Mentions({ members, value, onChange, disabled }: { members: Member[]; value: string[]; onChange: (v: string[]) => void; disabled: boolean }) {
 return <label>提及成员<select aria-label="提及成员" multiple value={value} disabled={disabled} onChange={e => onChange([...e.target.selectedOptions].map(o => o.value))}>{members.map(m => <option key={m.user_id} value={m.user_id}>{m.name}</option>)}</select><small>可多选；提及会发送站内通知。</small></label>;
}
function CodePicker({ snapshots, value, setValue, replacement, setReplacement }: { snapshots: Snapshot[]; value: CodeAnchor | null; setValue: (v: CodeAnchor | null) => void; replacement: string | null; setReplacement: (v: string | null) => void }) {
 const [snapshot, setSnapshot] = useState(value?.snapshotId??""), [page, setPage] = useState<SnapshotCode | null>(null), [file, setFile] = useState<SnapshotFile | null>(null), [error, setError] = useState("");
 const [busy, setBusy] = useState(false);
 const restored=useRef(value);
 useEffect(()=>{const a=restored.current;if(!a)return;let alive=true;setBusy(true);
  void Promise.all([collabApi<SnapshotCode>(`snapshots/${a.snapshotId}/code`),collabApi<SnapshotFile>(`snapshots/${a.snapshotId}/code?${new URLSearchParams({path:a.path})}`)]).then(([list,data])=>{
   if(!alive)return;if(data.manifestHash!==a.manifestHash||data.fileHash!==a.fileHash)throw new Error("草稿引用的代码已变化，请重新选择固定代码。");
   setPage(list.files.some(f=>f.path===a.path)?list:{...list,files:[{path:a.path,hash:a.fileHash,size:0},...list.files]});setFile(data);
  }).catch(e=>{if(alive)setError(e.message);}).finally(()=>{if(alive)setBusy(false);});return()=>{alive=false;};
 },[]);
 async function load(id: string, name?: string, offset = 0) {
  setBusy(true); setError(""); setValue(null); setReplacement(null); setFile(null);
  try {
   if (name !== undefined) {
    const data = await collabApi<SnapshotFile>(`snapshots/${id}/code?` + new URLSearchParams({ path: name })); setFile(data);
    if (data.lineCount) setValue({ snapshotId: id, manifestHash: data.manifestHash, path: data.path, fileHash: data.fileHash, startLine: 1, endLine: 1 });
   } else {
    const data = await collabApi<SnapshotCode>(`snapshots/${id}/code?offset=${offset}`); setPage(old => offset && old ? { ...data, files: [...old.files,...data.files] } : data);
   }
  } catch (e) { setPage(null); setError(e instanceof Error ? e.message : "读取代码失败"); }
  finally { setBusy(false); }
 }
 return <details className="collab-form compact"><summary>引用固定代码或提出修改建议</summary>
  <label>讨论代码版本<select aria-label="讨论代码版本" value={snapshot} disabled={busy} onChange={e => { setSnapshot(e.target.value); setPage(null); setFile(null); setValue(null); setReplacement(null); if (e.target.value) void load(e.target.value); }}><option value="">普通任务讨论</option>{snapshots.filter(s => s.status === "ready").map(s => <option value={s.id} key={s.id}>{s.note} · {s.id.slice(0,8)}</option>)}</select></label>
  {!snapshots.some(s => s.status === "ready") && <p>先保存任务交接快照，再引用其中的固定代码。</p>}
  {error && <p role="alert" className="collab-error">{error}</p>}
  {page && <><label>讨论代码文件<select aria-label="讨论代码文件" value={file?.path ?? ""} disabled={busy} onChange={e => { if (e.target.value) void load(snapshot,e.target.value); }}><option value="">选择文件</option>{page.files.map(f => <option key={f.path}>{f.path}</option>)}</select></label>{page.nextOffset !== null && <button type="button" className="collab-text-button" disabled={busy} onClick={() => void load(snapshot,undefined,page.nextOffset!)}>更多快照文件</button>}</>}
  {file && <><pre className="collab-code-text" aria-label="讨论原始代码">{sourceLines(file.text).map((line,i) => `${i+1}  ${line}`).join("")}</pre>
   {value && <><label>起始行<input aria-label="代码起始行" type="number" min={1} max={file.lineCount} value={value.startLine} onChange={e => setValue({ ...value, startLine: Number(e.target.value) })}/></label><label>结束行<input aria-label="代码结束行" type="number" min={value.startLine} max={file.lineCount} value={value.endLine} onChange={e => setValue({ ...value, endLine: Number(e.target.value) })}/></label>
    <label><input type="checkbox" checked={replacement !== null} disabled={!file.canSuggest} onChange={e => setReplacement(e.target.checked ? sourceLines(file.text).slice(value.startLine-1,value.endLine).join("") : null)}/>附带代码替换建议</label>
    {replacement !== null && <label>替换内容<textarea aria-label="建议替换内容" rows={5} maxLength={16000} value={replacement} onChange={e => setReplacement(e.target.value)}/><small>替换所选完整行；空内容表示删除。请保留需要的末尾换行。</small></label>}
   </>}
  </>}
 </details>;
}
export function TaskDiscussions({ taskId, userId, members, snapshots, canApply, onApply, initialThread, fixedReviewAnchor, onRestoreReviewRange, contextRun }: { taskId: string; userId: string; members: Member[]; snapshots: Snapshot[]; canApply: boolean; onApply: (id: string, snapshot: string) => void; initialThread?: string | null; fixedReviewAnchor?: ReviewAnchor; onRestoreReviewRange?:(end:number)=>void; contextRun?:{id:string;onSent:()=>void} }) {
 const [listing,setListing] = useState<DiscussionListing | null>(null), [offset,setOffset] = useState(0), [selected,setSelected] = useState(initialThread ?? ""), [detail,setDetail] = useState<DiscussionDetail | null>(null);
 const [composerKey,setComposerKey]=useState(0),[error,setError]=useState(""),[busy,setBusy]=useState(false),[notice,setNotice]=useState(""),[moreBusy,setMoreBusy]=useState(false);
 const alive=useRef(true),writing=useRef(false),generation=useRef(0),detailRef=useRef<DiscussionDetail|null>(null),paging=useRef(false);
 const key=discussionDraftKey(userId,taskId,fixedReviewAnchor);
 const {draft,change,ready:draftReady,error:storageError}=useDiscussionDraft(key,!!listing,saved=>{
  const restoredThread=initialThread??(saved.pending?.action==="reply"?saved.pending.threadId:saved.selected);
  const restoredReview=saved.pending?.action==="create"?(saved.pending.reviewAnchor??saved.reviewAnchor):saved.reviewAnchor;
  setSelected(restoredThread);if(restoredReview)onRestoreReviewRange?.(restoredReview.endLine);
  if(saved.pending)setNotice("已恢复原讨论请求，请重试同一操作核对结果。");
  else if(saved.title||saved.body||Object.values(saved.replies).some(r=>r.body))setNotice("已恢复本窗口的未发送讨论草稿。");
 });
 const {title,body,mentions,anchor,replacement,pending}=draft,replyDraft=draft.replies[selected],reply=replyDraft?.body??"",replyMentions=replyDraft?.mentions??[];
 const patch=(value:Partial<typeof draft>)=>change(old=>({...old,...value,reviewAnchor:fixedReviewAnchor??null}));
 const setTitle=(title:string)=>patch({title}),setBody=(body:string)=>patch({body}),setMentions=(mentions:string[])=>patch({mentions}),setAnchor=(anchor:CodeAnchor|null)=>patch({anchor}),setReplacement=(replacement:string|null)=>patch({replacement});
 const setReply=(body:string)=>change(old=>({...old,replies:{...old.replies,[selected]:{body,mentions:old.replies[selected]?.mentions??[]}}}));
 const setReplyMentions=(mentions:string[])=>change(old=>({...old,replies:{...old.replies,[selected]:{body:old.replies[selected]?.body??"",mentions}}}));
 const reviewFilter=fixedReviewAnchor ? JSON.stringify({kind:fixedReviewAnchor.kind,sourceId:fixedReviewAnchor.sourceId,sourceHash:fixedReviewAnchor.sourceHash,diffHash:fixedReviewAnchor.diffHash,path:fixedReviewAnchor.path}) : "";
 useEffect(()=>{if(draftReady&&fixedReviewAnchor&&draft.reviewAnchor?.endLine!==fixedReviewAnchor.endLine)change(old=>({...old,reviewAnchor:fixedReviewAnchor}));},[draftReady,fixedReviewAnchor,draft.reviewAnchor?.endLine,change]);
 const refresh = useCallback(async () => {
  const current = ++generation.current;
  try {
   const cached=detailRef.current,after=cached?.thread.id===selected&&cached.nextAfter===null?(cached.messages.at(-1)?.id??"0"):"0";
   const [list,discussion] = await Promise.all([collabApi<DiscussionListing>(`tasks/${taskId}/discussions?offset=${offset}${reviewFilter ? "&review="+encodeURIComponent(reviewFilter) : ""}`), selected ? collabApi<DiscussionDetail>(`discussions/${selected}?after=${after}`) : Promise.resolve(null)]);
   if (alive.current && current === generation.current) { setListing(list); setDetail(old=>{const merged=discussion?mergeDiscussionDetail(old,discussion,after):null;detailRef.current=merged;return merged;}); }
  } catch (e) { if (alive.current && current === generation.current) { setError(e instanceof Error ? e.message : "读取讨论失败"); if (e instanceof CollabApiError && [401,403,404].includes(e.status)) { setListing(null); setDetail(null); detailRef.current=null; } } }
 }, [taskId,offset,selected,reviewFilter]);
 useEffect(() => { alive.current=true; void refresh(); const timer=setInterval(() => { if (!document.hidden) void refresh(); },5000); return () => { alive.current=false; clearInterval(timer); }; },[refresh]);
 async function submit(input: DiscussionInput) {
  if(writing.current||!draftReady)return;
  const parsed=discussionInput.safeParse(pending??input);if(!parsed.success){setError("请检查讨论内容、提及成员和代码范围。");return;}
  const fixed=parsed.data;if(!change(old=>({...old,pending:fixed})))return;
  writing.current=true;setBusy(true);setError("");
  try{
   const result=await collabApi<{threadId?:string}>(`tasks/${taskId}/discussions`,fixed);
   change(old=>{if(old.pending?.idempotencyKey!==fixed.idempotencyKey)return old;
    if(fixed.action==="create")return {...old,pending:null,title:"",body:"",mentions:[],anchor:null,replacement:null,selected:result.threadId!};
    if(fixed.action==="reply"){const replies={...old.replies};delete replies[fixed.threadId];return {...old,pending:null,replies};}
    return {...old,pending:null};
   });
   if(!alive.current)return;setNotice("讨论操作已保存");
   if(fixed.action==="create"){setComposerKey(n=>n+1);setSelected(result.threadId!);setOffset(0);}
   await refresh();
  }catch(e){
   if(e instanceof CollabApiError&&[400,409,422].includes(e.status))change(old=>old.pending?.idempotencyKey===fixed.idempotencyKey?{...old,pending:null}:old);
   if(alive.current)setError(e instanceof Error?e.message:"操作结果未知，请重试同一请求");
  }finally{writing.current=false;setBusy(false);}
 }
 async function more(){
  const current=detailRef.current;if(!current?.nextAfter||paging.current)return;
  paging.current=true;setMoreBusy(true);const after=current.nextAfter;
  try{const next=await collabApi<DiscussionDetail>(`discussions/${current.thread.id}?after=${after}`);
   if(alive.current)setDetail(old=>{if(old?.thread.id!==next.thread.id)return old;const merged=mergeDiscussionDetail(old,next,after);detailRef.current=merged;return merged;});
  }catch(e){if(alive.current)setError(e instanceof Error?e.message:"读取回复失败");}
  finally{paging.current=false;if(alive.current)setMoreBusy(false);}
 }
 const d=detail?.thread,locked=busy||!!pending||!draftReady;
 return <section className="collab-snapshots" aria-label={fixedReviewAnchor?"此文件的版本讨论":"任务讨论与代码建议"} id={fixedReviewAnchor?undefined:"task-discussions"}>
  <div className="collab-section-heading"><h2>{fixedReviewAnchor?"此文件的版本讨论":"讨论与代码建议"}</h2>{listing && <button className="collab-button secondary" disabled={locked} onClick={() => void submit({ action:"subscribe",enabled:!listing.subscribed,idempotencyKey:crypto.randomUUID() })}>{listing.subscribed ? "取消任务订阅" : "订阅任务通知"}</button>}</div>
  <p className="collab-small collab-muted">讨论保留成员出处。普通评论不会发送给 AI；代码建议需要负责人明确采纳后，在新的工作区应用。</p>
  {storageError&&<p role="alert" className="collab-error">{storageError}</p>}{error && <p role="alert" className="collab-error">{error}</p>}{notice && <p role="status">{notice}</p>}
  {pending && draftReady && !busy && <button className="collab-button" onClick={() => void submit(pending)}>重试同一讨论操作</button>}
  {listing?.canComment && draftReady && <details><summary>发起讨论</summary><form className="collab-form compact" onSubmit={e=>{e.preventDefault();void submit({action:"create",title,body,mentions,anchor,replacement,...(fixedReviewAnchor?{reviewAnchor:fixedReviewAnchor}:{}),idempotencyKey:crypto.randomUUID()});}}>
   <fieldset disabled={locked}><label>讨论标题<input aria-label="讨论标题" required maxLength={200} value={title} onChange={e=>setTitle(e.target.value)}/></label><label>讨论内容<textarea aria-label="讨论内容" required maxLength={8000} value={body} onChange={e=>setBody(e.target.value)}/></label><Mentions members={members} value={mentions} onChange={setMentions} disabled={locked}/>
   {!fixedReviewAnchor&&<CodePicker key={composerKey} snapshots={snapshots} value={anchor} setValue={setAnchor} replacement={replacement} setReplacement={setReplacement}/>}<button className="collab-button">发布讨论</button></fieldset>
  </form></details>}
  {listing?.threads.map(t=><button key={t.id} className="collab-button secondary" aria-pressed={selected===t.id} onClick={()=>{setDetail(null);detailRef.current=null;setSelected(t.id);change(old=>({...old,selected:t.id}));}}>{t.resolved ? "已解决" : "待讨论"} · {t.title}{t.replacement!==null ? " · 代码建议" : ""}</button>)}
  {listing?.total===0 && <p className="collab-muted">暂无讨论。</p>}
  {listing && listing.total>40 && <div><button disabled={!offset} onClick={()=>setOffset(Math.max(0,offset-40))}>上一页讨论</button><span> {offset+1}–{Math.min(offset+40,listing.total)} / {listing.total} </span><button disabled={offset+40>=listing.total} onClick={()=>setOffset(offset+40)}>下一页讨论</button></div>}
  {d && <article className="collab-snapshot-card" aria-label={`讨论 ${d.title}`}><h3>{d.title}</h3><p>{d.author_name} · {d.resolved ? "已解决" : "待讨论"}</p>
   {d.review_anchor&&<><p className="collab-small collab-git-identity">固定{d.review_anchor.kind==="pull"?"PR":"整合"}差异 {d.review_anchor.diffHash}<br/>{d.review_anchor.path} · {d.review_anchor.side==="before"?"旧侧":"新侧"}第 {d.review_anchor.startLine}–{d.review_anchor.endLine} 行</p><a className="collab-text-button" href={`/api/collab/review-discussions?${new URLSearchParams({anchor:JSON.stringify(d.review_anchor)})}`} target="_blank" rel="noreferrer">核对评论的固定代码</a><p className="collab-small">评论保留原版本，不自动跟随新代码；解决讨论不等于批准合并。</p></>}
   {d.anchor && <><p className="collab-small collab-git-identity">固定快照 {d.anchor.snapshotId}<br/>{d.anchor.path} · 第 {d.anchor.startLine}–{d.anchor.endLine} 行<br/>原文件 {d.anchor.fileHash}</p><a className="collab-text-button" href={`/api/collab/snapshots/${d.anchor.snapshotId}/code?${new URLSearchParams({path:d.anchor.path})}`} target="_blank" rel="noreferrer">打开固定原始代码记录</a></>}
   {d.replacement!==null && <><pre className="collab-code-text" aria-label="已发布的代码建议">{d.replacement || "（删除所选行）"}</pre>{canApply && !d.resolved && <button className="collab-button" disabled={locked} onClick={()=>{onApply(d.id,d.anchor!.snapshotId);setNotice("建议已填入本任务的 AI 面板。核对模型与指令后，点击启动 AI 才会应用。");}}>在新工作区采纳建议…</button>}
    <p className="collab-small">建议仅应用于所标快照，原任务目录保持原样；新结果仍需测试、评审和整合。</p>
    {detail.applications.map(a=><p className="collab-small collab-git-identity" key={a.run_id}>{a.applied_at ? "已应用于独立工作区" : "尚未确认应用"} · 运行 {a.run_id} · {a.status}{a.applied_hash && <><br/>结果 hash {a.applied_hash}</>}</p>)}
   </>}
   {detail.messages.map(m=><div className="collab-form compact" key={m.id}><strong>{m.author_name} · {new Date(m.created_at).toLocaleString()}</strong><p className="collab-prewrap">{m.body}</p>{m.mentions.length>0 && <p>{m.mentions.map(u=>`@${u.name}`).join(" · ")}</p>}</div>)}
   {contextRun&&listing?.canComment&&<DiscussionContext key={`${contextRun.id}:${d.id}:${userId}`} runId={contextRun.id} userId={userId} detail={detail} onSent={contextRun.onSent}/>}
   {detail.nextAfter && <button className="collab-text-button" disabled={moreBusy} onClick={()=>void more()}>更多回复</button>}
   {listing?.canComment && draftReady && !d.resolved && <form className="collab-form compact" onSubmit={e=>{e.preventDefault();void submit({action:"reply",threadId:d.id,body:reply,mentions:replyMentions,idempotencyKey:crypto.randomUUID()});}}><label>回复<textarea aria-label="讨论回复" required disabled={locked} maxLength={8000} value={reply} onChange={e=>setReply(e.target.value)}/></label><Mentions members={members} value={replyMentions} onChange={setReplyMentions} disabled={locked}/><button disabled={locked} className="collab-button">发布回复</button></form>}
   {listing?.canComment && (listing.role==="maintainer" || listing.ownerId===userId || d.author_id===userId) && <button className="collab-text-button" disabled={locked} onClick={()=>void submit({action:"resolve",threadId:d.id,expectedVersion:d.version,resolved:!d.resolved,idempotencyKey:crypto.randomUUID()})}>{d.resolved ? "重新打开讨论" : "标记讨论已解决"}</button>}
  </article>}
 </section>;
}
