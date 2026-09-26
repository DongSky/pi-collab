"use client";
import { useState, type FormEvent } from "react";
import { collabApi, CollabApiError } from "./api";

type Task = { id: string; title: string; description: string; acceptance: string; status: string; version: number; is_resolution: boolean };
type Change = { title: string; description: string; acceptance: string; status: string };
type Edit = { id: string; version: number; previous: Change; updated: Change; reason: string; evidence_invalidated: boolean; created_at: string; actor_name: string };
type Request = Change & { expectedVersion: number; idempotencyKey: string; reason: string; acknowledgeCompletion: boolean };
const statuses: Record<string, string> = { draft: "草稿", ready: "待开始", in_progress: "进行中", in_review: "评审中", ready_to_merge: "待合并", done: "已完成", blocked: "阻塞", cancelled: "已取消" };
const fields: Record<keyof Change, string> = { title: "标题", description: "目标与修改范围", acceptance: "验收标准", status: "状态" };

export function TaskEditor({ task, canEdit, onChange }: { task: Task; canEdit: boolean; onChange: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [version, setVersion] = useState(task.version);
  const [status, setStatus] = useState(task.status);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Request | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [history, setHistory] = useState<{ edits: Edit[]; truncated: boolean } | null>(null);
  async function loadHistory() {
    try { setHistory(await collabApi(`tasks/${task.id}/history`)); }
    catch (e) { setHistory(null); setError(e instanceof Error ? e.message : "修改记录读取失败"); }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const request = pending ?? { title: String(form.get("title")), description: String(form.get("description")), acceptance: String(form.get("acceptance")), status,
      expectedVersion: version, idempotencyKey: crypto.randomUUID(), reason: String(form.get("reason")), acknowledgeCompletion: form.get("acknowledgeCompletion") === "on" };
    setPending(request); setBusy(true); setError(""); setNotice("");
    try {
      const result = await collabApi<{ evidenceInvalidated: boolean }>(`tasks/${task.id}`, request, "PATCH");
      setPending(null); setEditing(false);
      setNotice(result.evidenceInvalidated ? "任务已更新；原成果和验证不再适用于新目标，请重新运行与验证。" : "任务已更新。");
      await onChange(); await loadHistory();
    } catch (e) {
      if (e instanceof CollabApiError && e.status < 500) setPending(null);
      setError(e instanceof Error ? e.message : "保存结果未确认，请使用原请求重试。");
    } finally { setBusy(false); }
  }
  return <section className="collab-task-editor" aria-label="任务维护">
    <div className="collab-form-actions">
      {canEdit && !editing && <button className="collab-text-button" onClick={() => { setEditing(true); setVersion(task.version); setStatus(task.status); setError(""); setNotice(""); }}>编辑任务与状态</button>}
      <button className="collab-text-button" onClick={() => history ? setHistory(null) : void loadHistory()}>{history ? "收起修改记录" : "查看修改记录"}</button>
    </div>
    {error && <p className="collab-error" role="alert">{error}</p>}
    {notice && <p className="collab-member-notice" role="status">{notice}</p>}
    {editing && <form className="collab-form compact" onSubmit={save}>
      <p className="collab-muted collab-small">有活动运行时请先停止并等待结束。修改目标或验收会使原成果与相关验证失效；任务状态不授予代码批准或合并权限。</p>
      {pending && <p role="status">保存结果尚未确认，重试会沿用原请求。</p>}
      <fieldset disabled={busy || !!pending} className="collab-task-edit-fields">
        <label>任务标题<input aria-label="任务标题" name="title" defaultValue={task.title} maxLength={200} required /></label>
        <label>任务目标<textarea aria-label="任务目标" name="description" defaultValue={task.description} maxLength={20000} rows={4} readOnly={task.is_resolution} /></label>
        <label>任务验收<textarea aria-label="任务验收" name="acceptance" defaultValue={task.acceptance} maxLength={20000} rows={3} readOnly={task.is_resolution} /></label>
        {task.is_resolution && <p className="collab-small collab-muted">修复任务的目标与验收已固定。</p>}
        <label>任务状态<select aria-label="任务状态" value={status} onChange={e => setStatus(e.target.value)}>{Object.entries(statuses).filter(([key]) => !["in_progress", "ready_to_merge"].includes(key) || task.status === key).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        {status === "done" && task.status !== "done" && <label className="collab-checkbox"><input type="checkbox" name="acknowledgeCompletion" required />我已核对验收标准；标记完成不会批准或合并代码。</label>}
        <label>修改原因<textarea aria-label="修改原因" name="reason" minLength={10} maxLength={2000} rows={2} required placeholder="说明修改目标、阻塞、完成或重新打开的原因" /></label>
      </fieldset>
      <div className="collab-form-actions"><button className="collab-button primary" disabled={busy}>{busy ? "保存中…" : pending ? "重试原保存请求" : "保存任务"}</button><button type="button" className="collab-text-button" disabled={busy || !!pending} onClick={() => setEditing(false)}>取消编辑</button></div>
    </form>}
    {history && <div className="collab-task-edit-history"><h3>人工修改记录</h3>{!history.edits.length && <p className="collab-muted">尚无人工修改。运行状态变化见任务运行记录。</p>}
      {history.edits.map(edit => <details key={edit.id}><summary>{edit.actor_name} · v{edit.version} · {new Date(edit.created_at).toLocaleString()}</summary><p>{edit.reason}</p>
        {(Object.keys(fields) as (keyof Change)[]).filter(key => edit.previous[key] !== edit.updated[key]).map(key => <div key={key}><strong>{fields[key]}</strong><p className="collab-prewrap">原：{key === "status" ? statuses[edit.previous[key]] : edit.previous[key] || "（空）"}</p><p className="collab-prewrap">现：{key === "status" ? statuses[edit.updated[key]] : edit.updated[key] || "（空）"}</p></div>)}
        {edit.evidence_invalidated && <p className="collab-muted">此次修改已使原目标的成果与验证失效。</p>}
      </details>)}{history.truncated && <p>显示最近 50 次人工修改；更早记录仍保留在数据库中。</p>}
    </div>}
  </section>;
}
