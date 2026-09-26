"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { collabApi, CollabApiError } from "./api";
import type { PullReleaseContext } from "@/lib/collab/git/pull-release-schema";
const decisionNames:Record<string,string>={approve:"批准此版本",changes_requested:"要求修改",comment:"评审说明"};
const statusNames:Record<string,string>={queued:"等待交付",running:"正在核对与交付",ready:"已转为待评审",merged:"GitHub 已确认合并",rejected:"GitHub 拒绝操作",not_sent:"未发送远端操作",unknown:"远端结果未知，禁止自动重试",cancelled:"已取消"};
const failureNames:Record<string,string>={github_release_revision_changed:"远端代码或 PR 状态已变化，需要重新读取、评审。",github_release_permission_required:"GitHub App 权限不足。合并需要 contents/pull_requests 写权限和 administration 读权限。",github_release_protection_required:"默认分支需要管理员也遵守的严格保护、至少一名评审、旧批准失效、最后推送独立批准和无绕过名单。",github_release_ruleset_unsupported:"此分支使用 ruleset；当前合并适配器支持经典分支保护，请通过 GitHub 合并。",github_release_remote_not_ready:"GitHub 尚未判定此 PR 可以合并。请检查远端评审、CI 和分支更新。",stale_pull_release:"本地代码、权限、评审或 CI 证据已变化，需要重新确认。"};
type Pending={route:string;body:Record<string,unknown>};
export function PullRelease({revisionId,userId}:{revisionId:string;userId:string}){
 const [context,setContext]=useState<PullReleaseContext|null>(null),[decision,setDecision]=useState("comment"),[body,setBody]=useState(""),[reason,setReason]=useState(""),[ack,setAck]=useState(false);
 const [error,setError]=useState(""),[notice,setNotice]=useState(""),[busy,setBusy]=useState(false),[pending,setPending]=useState<Pending|null>(null);
 const alive=useRef(true),writing=useRef(false);const route=`pull-revisions/${revisionId}/release`,key=`pi-collab:pull-release:${userId}:${revisionId}`;
 const refresh=useCallback(async()=>{try{const c=await collabApi<PullReleaseContext>(route);if(alive.current)setContext(c);}catch(e){if(alive.current){setContext(null);setError(e instanceof Error?e.message:"读取交付状态失败");}}},[route]);
 useEffect(()=>{alive.current=true;try{const value=sessionStorage.getItem(key);if(value){const v=JSON.parse(value);if(typeof v.route==="string"&&v.body&&typeof v.body==="object")setPending(v);}}catch{setError("无法恢复原请求，请核对交付历史。");}void refresh();const timer=setInterval(()=>{if(!document.hidden)void refresh();},5000);return()=>{alive.current=false;clearInterval(timer);};},[key,refresh]);
 async function submit(value:Pending){if(writing.current)return;const fixed=pending??value;writing.current=true;setBusy(true);setError("");setNotice("");
  try{sessionStorage.setItem(key,JSON.stringify(fixed));setPending(fixed);await collabApi(fixed.route,fixed.body);sessionStorage.removeItem(key);if(alive.current){setPending(null);setBody("");setReason("");setAck(false);setNotice("操作已记录，请查看最新评审和交付状态。");}await refresh();}
  catch(e){if(e instanceof CollabApiError&&e.status<500){sessionStorage.removeItem(key);setPending(null);}setError(e instanceof Error?e.message:"结果未确认，请重试原请求。");}
  finally{writing.current=false;setBusy(false);}
 }
 const occupied=context?.jobs.some(j=>["queued","running","unknown","merged"].includes(j.status));
 return <details className="collab-form compact" aria-label="PR 团队评审与交付"><summary>团队评审与受保护交付</summary>
  <p className="collab-small">团队评审绑定当前固定 head/base 和差异。GitHub 原生批准、CI 与分支保护还需单独满足；平台不会替成员冒充 GitHub 评审。</p>
  {error&&<p className="collab-error" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  <button className="collab-text-button" onClick={()=>void refresh()}>刷新评审与交付</button>
  {pending&&<button className="collab-button" disabled={busy} onClick={()=>void submit(pending)}>重试同一评审或交付请求</button>}
  {context&&<><p className="collab-small collab-git-identity">head {context.headSha}<br/>base {context.baseSha}<br/>差异 {context.diffHash}</p>
   {!context.current&&<p role="status">历史版本：请先重新读取 PR 状态和固定代码，再进行评审或交付。</p>}
   <p>{context.eligible?"团队独立评审与当前 CI 已满足；提交时仍会重新核对。":"合并前需要独立批准、没有有效的修改要求，以及当前 CI 通过。"}</p>
   {context.canReview&&context.current&&<form className="collab-form compact" onSubmit={e=>{e.preventDefault();void submit({route:`pull-revisions/${revisionId}/reviews`,body:{idempotencyKey:crypto.randomUUID(),diffHash:context.diffHash,decision,body}});}}>
    <label>评审结论<select aria-label="PR 评审结论" value={decision} disabled={busy||!!pending} onChange={e=>setDecision(e.target.value)}><option value="comment">评审说明</option>{context.independent&&<><option value="approve">批准此版本</option><option value="changes_requested">要求修改</option></>}</select></label>
    {!context.independent&&<p className="collab-small">你是任务负责人或 PR 发起人，可以补充说明；批准需要另一位成员。</p>}
    <label>评审说明<textarea aria-label="PR 评审说明" minLength={10} maxLength={4000} required value={body} disabled={busy||!!pending} onChange={e=>setBody(e.target.value)}/></label><button className="collab-button" disabled={busy||!!pending}>提交固定版本评审</button>
   </form>}
   {context.votes.filter(v=>!v.valid).map(v=><p key={v.id} className="collab-small">{v.actorName} 的原评审已因权限或归属变化失效。</p>)}
   {context.reviews.map(r=><article key={r.id} className="collab-snapshot-card"><strong>{r.actorName} · {decisionNames[r.decision]}</strong><p className="collab-prewrap">{r.body}</p><small>{new Date(r.createdAt).toLocaleString()}</small></article>)}
   {context.canRelease&&context.current&&!occupied&&<form className="collab-form compact" onSubmit={e=>{e.preventDefault();void submit({route,body:{idempotencyKey:crypto.randomUUID(),action:context.draft?"ready":"merge",diffHash:context.diffHash,expectedTaskVersion:context.taskVersion,reason,acknowledge:true}});}}>
    <label>交付说明<textarea aria-label="PR 交付说明" required minLength={10} maxLength={2000} value={reason} disabled={busy||!!pending} onChange={e=>setReason(e.target.value)}/></label>
    <label><input type="checkbox" checked={ack} disabled={busy||!!pending} onChange={e=>setAck(e.target.checked)}/>{context.draft?"确认将此草稿转为待评审并触发 GitHub 通知":"确认将固定版本合并到远端默认分支；已核对变更与影响"}</label>
    <button className="collab-button" disabled={busy||!!pending||!ack||(!context.draft&&!context.eligible)}>{context.draft?"转为待评审":"合并到受保护分支"}</button>
   </form>}
   <p className="collab-small collab-muted">转为待评审后，重新读取 PR 状态、固定代码与 CI。合并仅支持普通 merge commit；当前保护适配器支持经典分支保护，ruleset/合并队列由 GitHub 页面处理。</p>
   {context.jobs.map(j=><article className="collab-snapshot-card" key={j.jobId}><strong role="status">{statusNames[j.status]??j.status}</strong><p className="collab-small">{j.actorName} · {j.action==="ready"?"转为待评审":"受保护合并"}</p>
    {j.result?.sha&&<p className="collab-git-identity">远端合并提交 {j.result.sha}<br/>本地基线请通过仓库「同步 GitHub 基线」读取并快进。</p>}
    {j.failure&&<p className="collab-small">{failureNames[j.failure]??j.failure}</p>}
    {j.status==="unknown"&&<p>请使用上方 PR 状态读取核对远端结果。原写入不会自动重放；未知操作继续占用此 PR。</p>}
    {j.status==="queued"&&context.canRelease&&<button className="collab-text-button" disabled={busy||!!pending} onClick={()=>void submit({route:`pull-releases/${j.jobId}/cancel`,body:{}})}>取消待发送交付</button>}
   </article>)}
  </>}
 </details>;
}
