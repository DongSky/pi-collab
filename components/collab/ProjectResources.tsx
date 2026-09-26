"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { collabApi, CollabApiError } from "./api";
type Resource = { id: string; name: string; status: string; version: number; change_reason: string | null; epoch: string; task_title: string | null; lease_status: string | null };
type Job = { id: string; resource_id: string; status: string; stopped: boolean; cancel_requested: boolean; error_code: string | null; sql_hash: string; result: unknown; can_control: boolean };
type Listing = { resources: Resource[]; requests: { id: string; task_title: string; status: string; resource_ids: string[]; wait_until: string; can_control: boolean }[]; jobs: Job[] };
const jobNames: Record<string, string> = { queued: "等待 broker 执行", running: "SQL 执行中", succeeded: "SQL 已提交", failed: "SQL 未通过", cancelled: "SQL 已取消", unknown: "SQL 结果未知" };
function ResourceActionForm({ endpoint, label, payload, disabled, completed, changed }: { endpoint: string; label: string; payload: Record<string, unknown>; disabled?: boolean; completed?: boolean; changed: () => void }) {
 const [reason,setReason]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState(""),[retry,setRetry]=useState(false);
 const pending=useRef<Record<string,unknown>|null>(null);
 async function submit(event:FormEvent) {
  event.preventDefault();if(busy)return;setBusy(true);setError("");
  pending.current??={...payload,reason,idempotencyKey:crypto.randomUUID()};
  try{await collabApi(endpoint,pending.current);pending.current=null;setRetry(false);setReason("");changed();}
  catch(e){if(e instanceof CollabApiError&&e.status<500){pending.current=null;changed();}setRetry(!!pending.current);setError(e instanceof Error?e.message:"资源操作失败");}
  finally{setBusy(false);}
 }
 if(completed&&!retry&&!busy)return null;
 return <details><summary>{retry?"重试同一资源操作":label}</summary><form className="collab-form compact" onSubmit={submit}>
  <label>处理原因<textarea aria-label={`${label}原因`} required minLength={10} maxLength={2000} value={reason} disabled={busy||retry} onChange={e=>setReason(e.target.value)}/></label>
  {error&&<p className="collab-error" role="alert">{error}</p>}
  <button className="collab-button" disabled={busy||(disabled&&!retry)}>{retry?"重试同一资源操作":label}</button>
 </form></details>;
}
export function ProjectResources({ projectId, role, eventGeneration }: { projectId: string; role: string; eventGeneration: number }) {
 const [data, setData] = useState<Listing | null>(null), [name, setName] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false), [retry, setRetry] = useState(false), [refresh, setRefresh] = useState(0);
 const pending = useRef<{ name: string; idempotencyKey: string } | null>(null);
 useEffect(() => {
  let active = true, loading = false;
  async function load() {
   if (loading) return; loading = true;
   try { const result = await collabApi<Listing>(`projects/${projectId}/resources`); if (active) setData(result); }
   catch (e) { if (active) { setError(e instanceof Error ? e.message : "读取测试资源失败"); if (e instanceof CollabApiError && [401,403,404].includes(e.status)) setData(null); } }
   finally { loading = false; }
  }
  void load(); const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 5000);
  const resume = () => { if (document.visibilityState === "visible") void load(); }; document.addEventListener("visibilitychange", resume); window.addEventListener("online", resume);
  return () => { active = false; clearInterval(timer); document.removeEventListener("visibilitychange", resume); window.removeEventListener("online", resume); };
 }, [projectId, eventGeneration, refresh]);
 async function create(event: FormEvent) {
  event.preventDefault(); if (busy) return; setBusy(true); setError(""); pending.current ??= { name, idempotencyKey: crypto.randomUUID() };
  try { await collabApi(`projects/${projectId}/resources`, pending.current); pending.current = null; setRetry(false); setName(""); setRefresh(n=>n+1); }
  catch (e) { if (e instanceof CollabApiError && e.status < 500) pending.current = null; setRetry(!!pending.current); setError(e instanceof Error ? e.message : "创建测试资源失败"); }
  finally { setBusy(false); }
 }
 return <section className="collab-snapshots" aria-label="受管理测试资源">
  <div className="collab-section-heading"><div><p className="collab-eyebrow">独立数据库角色 · 到期拒绝旧写入</p><h2>受管理测试资源</h2></div></div>
  <p className="collab-muted collab-small">每项资源提供独立的 PostgreSQL 测试 schema。AI 通过平台申请租约和提交 SQL；普通终端不持有数据库凭据。多个资源一次申请，等待时不占住部分资源。</p>
  {error && <p className="collab-error" role="alert">{error}</p>}
  {role === "maintainer" && <details><summary>创建 PostgreSQL 测试资源</summary><form className="collab-form compact" onSubmit={create}>
   <label>资源名称<input aria-label="测试资源名称" required maxLength={100} value={name} disabled={busy || retry} onChange={e=>setName(e.target.value)} /></label>
   <button className="collab-button" disabled={busy}>{retry ? "重试同一资源创建" : "创建测试资源"}</button>
  </form></details>}
  {!data?.resources.length && <p className="collab-muted">暂无受管理测试资源。</p>}
  {data?.resources.map(resource=><article className="collab-snapshot-card" key={resource.id} aria-label={`测试资源 ${resource.name}`}><strong role="status">{resource.name} · {resource.lease_status === "releasing" ? resource.status === "disabled" ? "已停用，等待旧作业退出" : "等待旧作业退出" : resource.status === "requested" ? "等待创建" : resource.status === "disabled" ? "已停用" : resource.task_title ? "使用中" : "可申请"}</strong>
   <p className="collab-muted collab-small">{resource.task_title && `当前任务：${resource.task_title} · `}租约代数 {resource.epoch}</p>
   {resource.change_reason&&<p className="collab-muted collab-small">最近处理原因：{resource.change_reason}</p>}
   {role==="maintainer"&&<ResourceActionForm endpoint={`resources/${resource.id}/actions`} label={resource.status==="disabled"?"恢复资源":"停用资源"} payload={{action:resource.status==="disabled"?"enable":"disable",expectedVersion:resource.version}} disabled={resource.status==="disabled"&&resource.lease_status!==null} changed={()=>setRefresh(n=>n+1)}/>}
  </article>)}
  {data?.requests.map(q=><article key={q.id} className="collab-snapshot-card" aria-label={`资源申请 ${q.task_title}`}>
   <p className="collab-muted collab-small" role="status">{q.task_title} · {q.status==="waiting"?"等待资源":q.status==="releasing"?"等待作业退出":"持有资源"} · {q.resource_ids.map(id=>data.resources.find(r=>r.id===id)?.name ?? "测试资源").join("、")}{q.status==="waiting"&&` · 等待至 ${new Date(q.wait_until).toLocaleTimeString()}`}</p>
   {q.can_control&&<ResourceActionForm endpoint={`resource-controls/${q.id}`} label={q.status==="waiting"?"取消等待":"释放资源租约"} payload={{targetKind:"request"}} disabled={q.status==="releasing"} changed={()=>setRefresh(n=>n+1)}/>}
  </article>)}
  {data?.jobs.map(job=><article className="collab-snapshot-card" key={job.id} aria-label={`资源作业 ${job.id}`}><strong role="status">{data.resources.find(r=>r.id===job.resource_id)?.name} · {jobNames[job.status]}</strong>
   <p className="collab-muted collab-small">作业 {job.id.slice(0,8)} · SQL hash {job.sql_hash.slice(0,12)} · {job.stopped ? "数据库连接已退出" : "仍需确认数据库连接退出"}</p>
   {job.cancel_requested && !job.stopped && <p className="collab-muted">已请求停止，确认连接退出前不会把资源交给其他运行。</p>}
   {job.status === "unknown" && <p className="collab-muted">提交结果未知，请核对实际数据。不会自动重放该 SQL。</p>}
   {job.error_code && <p className="collab-muted collab-small">诊断代码：{job.error_code}</p>}
   {job.result !== null && <details><summary>查看 SQL 结果</summary><pre className="collab-prewrap collab-small">{JSON.stringify(job.result,null,2)}</pre></details>}
   {job.can_control&&<ResourceActionForm endpoint={`resource-controls/${job.id}`} label="取消此 SQL 作业" payload={{targetKind:"job"}} disabled={job.cancel_requested} completed={job.stopped} changed={()=>setRefresh(n=>n+1)}/>}
  </article>)}
  <p className="collab-muted collab-small">最多显示 100 项活动申请及 50 个近期作业。取消作业或释放租约不会停止 AI，AI 可再次申请；维护者停用资源可阻止新申请。旧作业确认退出后才可恢复，已有测试数据保留。SQL 提交成功不等于项目验证或整合通过。</p>
 </section>;
}
