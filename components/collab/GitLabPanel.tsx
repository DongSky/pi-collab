"use client";
import {useCallback,useEffect,useRef,useState} from "react";
import {collabApi,CollabApiError} from "./api";
import {gitlabPendingOperation} from "@/lib/collab/gitlab/schema";
import type {GitLabPlan} from "@/lib/collab/gitlab/plan";
type Connection={id:string;name:string;origin:string;remote_id:string;repository_id:string|null;enabled:boolean;version:string;evidence:{path:string;webUrl:string}};
type Operation={id:string;connection_id:string;kind:string;actor_id:string;source_id:string|null;status:string;stage:string;failure:string|null;result:{planHash?:string;commitSha?:string;branch?:string;url?:string;mr?:{state:string;draft:boolean;head_pipeline?:{status:string}|null}}};
type Listing={connections:Connection[];operations:Operation[];reviews:{operation_id:string;reviewer_id:string;reviewer_name:string;decision:string;note:string}[];results:{id:string;title:string;task_id:string;repository_id:string;version:number;can_prepare:boolean}[];role:string;canManage:boolean};
const labels:Record<string,string>={import:'导入仓库',sync:'同步默认分支',prepare:'准备变更',publish:'发送分支并创建 MR',observe:'刷新 MR',ready:'转为待评审',merge:'合并 MR',queued:'排队中',running:'执行中',completed:'完成',failed:'未完成',uncertain:'结果待核查'};
export function GitLabPanel({projectId,taskId,userId}:{projectId:string;taskId:string;userId:string}){
 const[data,setData]=useState<Listing|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[reason,setReason]=useState(''),[selected,setSelected]=useState(''),[resultId,setResultId]=useState(''),[opened,setOpened]=useState<{id:string;plan:GitLabPlan;planHash:string}|null>(null),[ack,setAck]=useState(false),[note,setNote]=useState(''),[retry,setRetry]=useState(false);
 const pending=useRef<ReturnType<typeof gitlabPendingOperation.parse>|null>(null);
 const writing=useRef(false),sequence=useRef(0),alive=useRef(true);
 const [loaded,setLoaded]=useState(false);
 const storageKey=`pi-collab:gitlab-operation:${userId}:${projectId}`;
 const refresh=useCallback(async()=>{
  const request=++sequence.current;
  try {
   const next=await collabApi<Listing>(`projects/${projectId}/gitlab`);
   if(!alive.current||request!==sequence.current)return;
   setData(next);setSelected(id=>next.connections.some(c=>c.id===id)?id:next.connections.find(c=>c.enabled)?.id??next.connections[0]?.id??'');
  } catch(e) {
   if(!alive.current||request!==sequence.current)return;
   if(e instanceof CollabApiError&&[401,403,404].includes(e.status)){setData(null);setOpened(null);setAck(false);}
   setError(e instanceof Error?e.message:'无法读取 GitLab 状态');
  }
 },[projectId]);
 const invalidate=useCallback(()=>{alive.current=false;sequence.current++;},[]);
 useEffect(()=>{
  alive.current=true;
  try {const saved=sessionStorage.getItem(storageKey);pending.current=saved?gitlabPendingOperation.parse(JSON.parse(saved)):null;setRetry(!!pending.current);setLoaded(true);}
  catch {setLoaded(false);setError('无法恢复原 GitLab 请求，请先核对已有操作记录；未发送新的请求。');}
  void refresh();
  const visible=()=>{if(document.visibilityState==='visible')void refresh();};
  const timer=setInterval(visible,5000);document.addEventListener('visibilitychange',visible);window.addEventListener('online',visible);
  return()=>{invalidate();clearInterval(timer);document.removeEventListener('visibilitychange',visible);window.removeEventListener('online',visible);};
 },[refresh,storageKey,invalidate]);
 async function send(connectionId:string,command:Record<string,unknown>){
  if(writing.current||!loaded)return;
  const parsed=gitlabPendingOperation.safeParse(pending.current??{connectionId,command:{...command,reason,idempotencyKey:crypto.randomUUID()}});
  if(!parsed.success){setError('请填写完整操作说明并核对固定版本。');return;}
  const fixed=parsed.data;
  try {sessionStorage.setItem(storageKey,JSON.stringify(fixed));}
  catch {setError('无法保留原请求编号，尚未发送。请允许本窗口会话存储。');return;}
  writing.current=true;pending.current=fixed;setRetry(true);setBusy(true);setError('');
  try {
   await collabApi(`projects/${projectId}/gitlab`,fixed);
   sessionStorage.removeItem(storageKey);pending.current=null;
   if(alive.current){setRetry(false);setAck(false);await refresh();}
  }catch(e){
   if(e instanceof CollabApiError&&e.status<500){sessionStorage.removeItem(storageKey);pending.current=null;}
   if(alive.current){setRetry(!!pending.current);setError(e instanceof Error?e.message:'操作结果未确认，请重试同一 GitLab 请求。');}
  }finally{writing.current=false;setBusy(false);}
 }
 async function open(op:Operation){setBusy(true);setError('');setAck(false);try{const next=await collabApi<{plan:GitLabPlan;planHash:string}>(`gitlab/operations/${op.id}/plan`);setOpened({id:op.id,...next});setNote('');}catch(e){setError(e instanceof Error?e.message:'无法读取预览');}finally{setBusy(false);}}
 async function review(decision:string){if(!opened)return;setBusy(true);setError('');try{await collabApi(`gitlab/operations/${opened.id}/reviews`,{planHash:opened.planHash,decision,note});await refresh();}catch(e){setError(e instanceof Error?e.message:'评审失败');}finally{setBusy(false);}}
 async function toggle(c:Connection){setBusy(true);setError('');try{await collabApi(`gitlab/connections/${c.id}`,{expectedVersion:c.version,enabled:!c.enabled,reason});await refresh();}catch(e){setError(e instanceof Error?e.message:'连接更新失败');}finally{setBusy(false);}}
 const connection=data?.connections.find(c=>c.id===selected),locked=busy||retry||!loaded,canWrite=data&&['maintainer','developer'].includes(data.role),validReason=reason.trim().length>=10;
 return <section className="collab-snapshots" aria-label="GitLab 协作交付"><h2>GitLab 协作交付</h2><p className="collab-muted collab-small">从已验证成果准备固定变更，确认后发送独立分支并创建草稿 MR。GitLab 首版提交成果快照，不复制 AI 的中间提交历史。导入与发送由独立 Git 服务执行。</p>
 {error&&<p role="alert" className="collab-error">{error}</p>}{retry&&<><p role="status">原 GitLab 操作响应尚未确认，已保留原请求编号与完整内容；刷新或切换任务后仍可重试。{pending.current&&` 操作：${labels[pending.current.command.kind]} · 连接 ${pending.current.connectionId.slice(0,8)}`}</p>{pending.current&&<details><summary>查看待确认的 GitLab 操作</summary><p className="collab-prewrap">{pending.current.command.reason}</p><pre className="collab-prewrap collab-small">{JSON.stringify(pending.current,null,2)}</pre></details>}<button className="collab-button" disabled={busy||!loaded||!data} onClick={()=>pending.current&&void send(pending.current.connectionId,pending.current.command)}>重试同一 GitLab 操作</button></>}
 {!data?.connections.length?<p className="collab-muted">管理员尚未接入 GitLab 项目。部署管理员通过本机 GitLab 接入命令配置项目专用令牌；页面不接收令牌。</p>:<>
 <div className="collab-form compact"><label>GitLab 仓库<select aria-label="GitLab 仓库" disabled={locked} value={selected} onChange={e=>{setSelected(e.target.value);setResultId('');setOpened(null);}}>{data.connections.map(c=><option key={c.id} value={c.id}>{c.name} · {c.evidence.path} · {c.enabled?'启用':'停用'}</option>)}</select></label><label>GitLab 操作说明<textarea aria-label="GitLab 操作说明" minLength={10} maxLength={2000} value={reason} onChange={e=>setReason(e.target.value)}/></label></div>
 {connection&&<><p><a href={connection.evidence.webUrl} target="_blank" rel="noreferrer">打开 GitLab 项目</a></p>{!connection.repository_id&&data.role==='maintainer'&&<button className="collab-button" disabled={locked||!validReason||!connection.enabled} onClick={()=>void send(connection.id,{kind:'import'})}>导入 GitLab 仓库</button>}{data.canManage&&<button className="collab-text-button" disabled={locked||!validReason} onClick={()=>void toggle(connection)}>{connection.enabled?'停用 GitLab 连接':'启用 GitLab 连接'}</button>}
 {connection.repository_id&&data.role==='maintainer'&&<button className="collab-button" disabled={locked||!validReason||!connection.enabled} onClick={()=>void send(connection.id,{kind:'sync'})}>同步 GitLab 默认分支</button>}
 {connection.repository_id&&canWrite&&<div className="collab-form compact"><label>GitLab 成果版本<select aria-label="GitLab 成果版本" value={resultId} onChange={e=>setResultId(e.target.value)}><option value="">选择当前任务的已验证成果</option>{data.results.filter(r=>r.repository_id===connection.repository_id&&r.task_id===taskId&&r.can_prepare).map(r=><option key={r.id} value={r.id}>{r.title} · v{r.version}</option>)}</select></label><button className="collab-button" disabled={locked||!resultId||!validReason||!connection.enabled} onClick={()=>void send(connection.id,{kind:'prepare',resultId})}>准备 GitLab 变更预览</button></div>}</>}
 {data.operations.filter(o=>o.connection_id===selected).map(op=><article key={op.id} className="collab-snapshot-card" aria-label={`GitLab 操作 ${op.id}`}><strong>{labels[op.kind]} · {labels[op.status]}</strong><p className="collab-small">{op.id.slice(0,8)}{op.result.branch&&` · ${op.result.branch}`}</p>{op.failure&&<p className="collab-muted">{op.status==='uncertain'?'保留原操作，核查 GitLab 记录后再处理；不会自动重发。':'请核对权限、远端基线与成果状态。'} <small>{op.failure}</small></p>}
 {op.kind==='prepare'&&op.status==='completed'&&<button className="collab-button" disabled={locked} onClick={()=>void open(op)}>打开固定变更预览</button>}
 {op.result.url&&<a href={op.result.url} target="_blank" rel="noreferrer">打开 MR</a>}{op.result.mr&&<p>MR：{op.result.mr.state} · {op.result.mr.draft?'草稿':'待评审 / 已交付'} · CI：{op.result.mr.head_pipeline?.status??'未获取'}</p>}
 {op.kind==='publish'&&op.status==='completed'&&<div className="collab-form-actions"><button className="collab-button" disabled={locked||!validReason} onClick={()=>void send(op.connection_id,{kind:'observe',sourceId:op.id})}>刷新 MR 状态</button>{data.role==='maintainer'&&<><button className="collab-button" disabled={locked||!validReason} onClick={()=>void send(op.connection_id,{kind:'ready',sourceId:op.id,expectedSha:op.result.commitSha})}>转为待评审 MR</button><button className="collab-button" disabled={locked||!validReason} onClick={()=>void send(op.connection_id,{kind:'merge',sourceId:op.id,expectedSha:op.result.commitSha})}>核对评审与 CI 后合并</button></>}</div>}
 {data.reviews.filter(r=>r.operation_id===op.id).map(r=><p key={r.reviewer_id}>{r.reviewer_name} · {r.decision==='approve'?'批准':'拒绝'} · {r.note}</p>)}
 </article>)}
 </>}
 {opened&&<section className="collab-snapshot-card" aria-label="GitLab 固定变更预览"><h3>固定变更预览</h3><p className="collab-prewrap collab-small">基线：{opened.plan.baseSha}<br/>提交：{opened.plan.commitSha}<br/>校验：{opened.planHash}</p><p>{opened.plan.changes.length} 个文本文件。排除 {opened.plan.excluded.length} 项；排除项保留远端原值，不发送本地改动。</p>
 {opened.plan.changes.map(c=><details key={c.path}><summary>{c.kind} · {c.path}</summary><h4>修改前</h4><pre className="collab-prewrap">{c.before??'（不存在）'}</pre><h4>修改后</h4><pre className="collab-prewrap">{c.after??'（删除）'}</pre></details>)}
 {opened.plan.excluded.length>0&&<details><summary>查看排除项</summary>{opened.plan.excluded.map(p=><p key={p.path}>{p.path} · {p.reason}</p>)}</details>}
 <label className="collab-check"><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)}/>已核对完整变更与排除项，确认向 GitLab 发送此版本</label>
 {canWrite&&<button className="collab-button" disabled={locked||!ack||!validReason} onClick={()=>{const op=data?.operations.find(o=>o.id===opened.id);if(op)void send(op.connection_id,{kind:'publish',sourceId:opened.id,planHash:opened.planHash,acknowledge:true});}}>发送固定版本并创建草稿 MR</button>}
 {data&&['maintainer','reviewer'].includes(data.role)&&data.operations.find(o=>o.id===opened.id)?.actor_id!==userId&&<div className="collab-form compact"><label>GitLab 独立评审说明<textarea aria-label="GitLab 独立评审说明" value={note} onChange={e=>setNote(e.target.value)} minLength={10} maxLength={2000}/></label><div className="collab-form-actions"><button className="collab-button" disabled={locked||note.trim().length<10} onClick={()=>void review('approve')}>批准固定版本</button><button className="collab-text-button" disabled={locked||note.trim().length<10} onClick={()=>void review('reject')}>拒绝固定版本</button></div></div>}
 </section>}
 <p className="collab-muted collab-small">合并需要独立批准、当前提交 CI 成功及 GitLab 允许合并。仅显示最近 50 项操作；状态观察保留独立记录。合并后点击“同步 GitLab 默认分支”，后续任务即可从新基线开始，旧任务保持原基线。</p>
 </section>;
}
