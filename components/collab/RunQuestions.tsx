"use client";
import { useCallback, useEffect, useState } from "react";
import { collabApi, CollabApiError } from "./api";
import type { ControlState } from "./RunControl";
type Question = { id: string; question: string; choices: string[]; status: string; answer: string | null; author_name: string | null; control_version: string | null };
type Data = { run: { status: string; control: ControlState }; questions: Question[] };
export function RunQuestions({ runId, userId, onChange }: { runId: string; userId: string; onChange: () => Promise<void> }) {
  const [data, setData] = useState<Data | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false), [answers, setAnswers] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<{ id: string; body: { expectedVersion: string; answer: string; idempotencyKey: string } } | null>(null);
  const load = useCallback(async () => { try { setData(await collabApi<Data>(`runs/${runId}/questions`)); } catch (e) { setData(null); setError(e instanceof Error ? e.message : "读取 AI 问题失败"); } }, [runId]);
  useEffect(() => { void load(); const timer = setInterval(() => { if (!document.hidden) void load(); }, 3000); return () => clearInterval(timer); }, [load]);
  async function answer(q: Question) {
    if (busy || !data) return;
    const request = pending ?? { id: q.id, body: { expectedVersion: data.run.control.version, answer: answers[q.id] ?? "", idempotencyKey: crypto.randomUUID() } };
    setPending(request); setBusy(true); setError("");
    try { await collabApi(`questions/${request.id}/answer`, request.body); setPending(null); setAnswers(values => ({ ...values, [q.id]: "" })); await load(); await onChange(); }
    catch (e) { if (e instanceof CollabApiError && e.status < 500) setPending(null); setError(e instanceof Error ? e.message : "回答结果未知，请重试同一回答"); }
    finally { setBusy(false); }
  }
  const canAnswer = data?.run.control.controllerId === userId && data.run.control.valid && data.run.control.instructionsOpen && data.run.status === "waiting_input";
  return <section aria-label="AI 提问与回答"><h3>AI 提问与回答</h3>
    {error && <p role="alert">{error}</p>}
    {pending && !busy && <button className="collab-button" onClick={() => void answer({ id: pending.id } as Question)}>重试同一回答</button>}
    {!data?.questions.length && <p className="collab-muted">AI 需要你决定后才能继续时，问题会显示在这里。</p>}
    {data?.questions.map(q => <article className="collab-result-card" key={q.id}>
      <p className="collab-prewrap"><strong>{q.question}</strong></p>
      <p>{q.status === "pending" ? "等待当前控制者回答" : q.status === "answered" ? `已回答 · ${q.author_name} · 控制版本 ${q.control_version}` : "运行已停止，问题已取消"}</p>
      {q.answer && <p className="collab-prewrap">{q.answer}</p>}
      {q.status === "pending" && <><p className="collab-small">等待保留当前 AI 和工作区，仍占用并发名额并计入运行时限。回答不会授予额外权限；运行输出用于确认 AI 后续行为。</p>
        {canAnswer ? <form className="collab-form" onSubmit={event => { event.preventDefault(); void answer(q); }}>
          {!!q.choices.length && <div className="collab-form-actions">{q.choices.map((choice, i) => <button type="button" className="collab-text-button" key={i} disabled={busy || !!pending} onClick={() => setAnswers(values => ({ ...values, [q.id]: choice }))}>{choice}</button>)}</div>}
          <label>回答 AI<textarea aria-label="回答 AI" value={answers[q.id] ?? ""} onChange={event => setAnswers(values => ({ ...values, [q.id]: event.target.value }))} maxLength={10000} required disabled={busy || !!pending} /></label>
          <button className="collab-button primary" disabled={busy || !!pending}>提交回答并继续</button>
        </form> : <p>由当前控制者 {data.run.control.controllerName} 回答；需要接手时可先申请控制权。</p>}
      </>}
    </article>)}
  </section>;
}
