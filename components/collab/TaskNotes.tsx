"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { collabApi, CollabApiError } from "./api";
type Note = { id: string; sequence: string; source_task_id: string; target_task_id: string; source_title: string; target_title: string; author_name: string; source_run_id: string | null; kind: string; body: string; result_ids: string[]; revision_ids: string[]; created_at: string };
type Listing = { notes: Note[]; hasMore: boolean; nextSequence: string };
type Pending = { targetTaskId: string; kind: string; body: string; resultIds: string[]; revisionIds: string[]; idempotencyKey: string };
const kinds: Record<string, string> = { question: "问题", finding: "发现", blocker: "阻塞", handoff: "交接" };
export function TaskNotes({ taskId, tasks, canSend, eventGeneration }: { taskId: string; tasks: { id: string; title: string }[]; canSend: boolean; eventGeneration: number }) {
  const [notes, setNotes] = useState<Note[]>([]), [hasMore, setHasMore] = useState(false), [trimmed, setTrimmed] = useState(false), [refresh, setRefresh] = useState(0);
  const [target, setTarget] = useState(taskId), [kind, setKind] = useState("question"), [body, setBody] = useState("");
  const [busy, setBusy] = useState(false), [retry, setRetry] = useState(false), [error, setError] = useState(""), [sent, setSent] = useState(false);
  const cursor = useRef("0"), pending = useRef<Pending | null>(null);
  useEffect(() => {
    let active = true, loading = false;
    async function load() {
      if (loading) return; loading = true;
      try {
        const next = await collabApi<Listing>(`tasks/${taskId}/notes?after=${cursor.current}`);
        if (active) {
          cursor.current = next.nextSequence; setHasMore(next.hasMore);
          setNotes(previous => { const unique = [...new Map([...previous, ...next.notes].map(note => [note.id, note])).values()]; if (unique.length > 500) setTrimmed(true); return unique.slice(-500); });
        }
      } catch (e) {
        if (active) { setError(e instanceof Error ? e.message : "读取说明失败"); if (e instanceof CollabApiError && [401, 403, 404].includes(e.status)) { setNotes([]); cursor.current = "0"; } }
      } finally { loading = false; }
    }
    void load(); const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 5000);
    const resume = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", resume); window.addEventListener("online", resume);
    return () => { active = false; clearInterval(timer); document.removeEventListener("visibilitychange", resume); window.removeEventListener("online", resume); };
  }, [taskId, refresh, eventGeneration]);
  async function send(event: FormEvent) {
    event.preventDefault(); if (busy) return; setBusy(true); setError(""); setSent(false);
    pending.current ??= { targetTaskId: target, kind, body, resultIds: [], revisionIds: [], idempotencyKey: crypto.randomUUID() };
    try {
      await collabApi(`tasks/${taskId}/notes`, pending.current); pending.current = null; setRetry(false); setBody(""); setSent(true); setRefresh(n => n + 1);
    } catch (e) {
      if (e instanceof CollabApiError && e.status < 500) pending.current = null;
      setRetry(!!pending.current); setError(e instanceof Error ? e.message : "提交说明失败");
    } finally { setBusy(false); }
  }
  return <section className="collab-snapshots" aria-label="任务协作说明">
    <div className="collab-section-heading"><div><p className="collab-eyebrow">保留出处 · 对齐问题</p><h2>任务协作说明</h2></div></div>
    <p className="collab-muted collab-small">说明供负责人和 AI 下次读取协作上下文时参考。它不会直接中断对方运行；完成与兼容性仍以验证证据为准。</p>
    {error && <p className="collab-error" role="alert">{error}</p>}{sent && <p role="status">协作说明已保存</p>}
    {canSend && <form className="collab-form compact" onSubmit={send}>
      <label>目标任务<select aria-label="协作说明目标任务" value={target} disabled={busy || retry} onChange={e => setTarget(e.target.value)}>{tasks.map(task => <option key={task.id} value={task.id}>{task.title}{task.id === taskId ? " · 当前任务" : ""}</option>)}</select></label>
      <label>类型<select aria-label="协作说明类型" value={kind} disabled={busy || retry} onChange={e => setKind(e.target.value)}>{Object.entries(kinds).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      <label>说明<textarea aria-label="协作说明内容" value={body} required maxLength={4000} rows={3} disabled={busy || retry} onChange={e => setBody(e.target.value)} /></label>
      <div><button className="collab-button" disabled={busy}>{retry ? "重试同一协作说明" : "提交协作说明"}</button></div>
    </form>}
    {!notes.length && <p className="collab-muted">暂无协作说明。</p>}
    {[...notes].reverse().map(note => <article className="collab-snapshot-card" key={note.id} aria-label={`协作${kinds[note.kind]} ${note.source_title}`}>
      <strong>{kinds[note.kind]} · {note.source_title} → {note.target_title}</strong>
      <p className="collab-muted collab-small">{note.author_name} · {note.source_run_id ? `AI 提交 · 运行 ${note.source_run_id.slice(0, 8)}` : "成员提交"} · {new Date(note.created_at).toLocaleString()}</p>
      <p className="collab-prewrap">{note.body}</p>
      {note.revision_ids.map(id => <p key={id}><a className="collab-text-button" href={`/api/collab/contract-revisions/${id}`} download>引用契约 · {id.slice(0, 8)}</a></p>)}
      {note.result_ids.map(id => <p className="collab-muted collab-small" key={id}>引用成果 · {id}</p>)}
    </article>)}
    {hasMore && <button className="collab-text-button" onClick={() => setRefresh(n => n + 1)}>继续载入说明</button>}
    {trimmed && <p className="collab-muted collab-small">本页保留最近载入的 500 条；完整记录仍保存在项目中。</p>}
  </section>;
}
