"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { collabApi, CollabApiError } from "./api";
type Catalogue = { sources: { promotion_id: string; repository_id: string; name: string; old_sha: string; new_sha: string; base_sha: string }[]; tasks: { task_id: string; title: string; target_sha: string; current: boolean }[] };
export function ManagedReverts({ projectId, role, onOpen }: { projectId: string; role: string; onOpen: (taskId: string) => Promise<void> }) {
  const [data, setData] = useState<Catalogue | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false), [sourceId, setSourceId] = useState("");
  const pending = useRef<Record<string, string> | null>(null);
  const refresh = useCallback(async () => { setData(await collabApi<Catalogue>(`projects/${projectId}/reverts`)); }, [projectId]);
  useEffect(() => { let live = true; collabApi<Catalogue>(`projects/${projectId}/reverts`).then(value => { if (live) setData(value); }).catch(e => { if (live) setError(e.message); }); return () => { live = false; }; }, [projectId]);
  const source = data?.sources.find(item => item.promotion_id === sourceId);
  async function create(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault(); if (busy) return;
    if (event && source) { const fields = new FormData(event.currentTarget); pending.current ??= { promotionId: source.promotion_id, baseSha: source.base_sha, title: String(fields.get("title")), reason: String(fields.get("reason")), idempotencyKey: crypto.randomUUID() }; }
    if (!pending.current) return;
    setBusy(true); setError("");
    try { const result = await collabApi<{ taskId: string }>(`projects/${projectId}/reverts`, pending.current); pending.current = null; await refresh(); await onOpen(result.taskId); }
    catch (e) { if (e instanceof CollabApiError && e.status < 500) pending.current = null; setError(e instanceof Error ? e.message : "创建失败"); }
    finally { setBusy(false); }
  }
  return <details className="collab-snapshot-card"><summary>撤回共享历史（创建 revert 任务）</summary>
    <p className="collab-muted">选择一次已推进的完整变更。新任务在当前基线上生成反向提交，保留后续独立变更；有冲突时需人工或 AI 修复。之后仍需保存快照、固定验证、发布成果、独立评审和显式推进。</p>
    {error && <p role="alert" className="collab-error">{error}</p>}
    <button className="collab-text-button" disabled={busy} onClick={() => void refresh().catch(e => setError(e.message))}>刷新撤回来源</button>
    {role === "maintainer" && <form className="collab-form" onSubmit={e => void create(e)}><label>撤回哪次推进<select required value={sourceId} disabled={busy || !!pending.current} onChange={e => setSourceId(e.target.value)}><option value="">选择已推进变更</option>{data?.sources.map(item => <option key={item.promotion_id} value={item.promotion_id}>{item.name} · {item.old_sha.slice(0,8)} → {item.new_sha.slice(0,8)}</option>)}</select></label>
      {source && <p>新任务固定基线：{source.base_sha.slice(0,12)}；撤回来源：{source.new_sha.slice(0,12)}。</p>}
      <label>撤回任务名称<input name="title" required maxLength={200} defaultValue="撤回已推进变更" disabled={busy || !!pending.current}/></label>
      <label>撤回原因<textarea name="reason" required minLength={10} maxLength={2000} disabled={busy || !!pending.current}/></label>
      <button className="collab-button" disabled={busy || !source || !!pending.current}>创建固定来源的撤回任务</button>
    </form>}
    {!!pending.current && <button className="collab-button" disabled={busy} onClick={() => void create()}>重试同一撤回请求</button>}
    {data?.tasks.map(task => <p key={task.task_id}><button className="collab-text-button" onClick={() => void onOpen(task.task_id).catch(e => setError(e.message))}>{task.title}</button> · {task.current ? "基线有效" : "基线已变化，请重新申请"} · {task.target_sha.slice(0,12)}</p>)}
  </details>;
}
