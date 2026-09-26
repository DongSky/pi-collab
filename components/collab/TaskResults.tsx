"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { collabApi, CollabApiError } from "./api";
import { ResultEvidence } from "./ResultEvidence";

type Result = { id: string; version: number; snapshot_id: string; validation_id: string; worktree_commit: string; note: string; withdrawal_reason: string | null; dependency_state: string };
type Listing = { revert?: { promotion_id: string; target_sha: string; new_sha: string; old_sha: string } | null; resolution: { integrationId: string } | null; task: { version: number; current_result_id: string | null }; results: Result[]; validations: { id: string; snapshot_id: string; profile_name: string; worktree_commit: string }[] };
type Inputs = { run: { dependency_state: string }; dependencies: { task_id: string; title: string; kind: string; result_id: string | null; version: number | null; worktree_commit: string | null; is_current: boolean }[] };
const states: Record<string, string> = { current: "依赖版本当前有效", waiting: "等待严格依赖成果", needs_revalidation: "依赖需要重新验证", untracked: "旧运行未记录依赖版本" };
export function TaskResults({ taskId, runId, canPublish, onChange }: { taskId: string; runId?: string; canPublish: boolean; onChange: () => Promise<void> }) {
  const [data, setData] = useState<Listing | null>(null), [inputs, setInputs] = useState<Inputs | null>(null);
  const [validationId, setValidationId] = useState(""), [note, setNote] = useState(""), [reason, setReason] = useState("");
  const [acknowledgeResolution, setAcknowledgeResolution] = useState(false);
  const [busy, setBusy] = useState(false), [retry, setRetry] = useState(false), [error, setError] = useState(""), [refresh, setRefresh] = useState(0);
  const pending = useRef<{ endpoint: string; body: unknown } | null>(null);
  useEffect(() => {
    let active = true, loading = false; setInputs(null);
    async function load() {
      if (loading) return; loading = true;
      try {
        const [results, dependencies] = await Promise.all([collabApi<Listing>(`tasks/${taskId}/results`), runId ? collabApi<Inputs>(`runs/${runId}/dependencies`) : Promise.resolve(null)]);
        if (active) { setData(results); setInputs(dependencies); }
      } catch (e) { if (active) { setError(e instanceof Error ? e.message : "读取成果失败"); if (e instanceof CollabApiError && [401, 403, 404].includes(e.status)) { setData(null); setInputs(null); } } }
      finally { loading = false; }
    }
    void load(); const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [taskId, runId, refresh]);
  async function submit(endpoint: string, body: unknown) {
    if (busy) return; setBusy(true); setError(""); pending.current ??= { endpoint, body };
    try { await collabApi(pending.current.endpoint, pending.current.body); pending.current = null; setRetry(false); setAcknowledgeResolution(false); setRefresh(n => n + 1); await onChange(); }
    catch (e) { if (e instanceof CollabApiError && e.status < 500) { pending.current = null; setRefresh(n => n + 1); } setRetry(!!pending.current); setError(e instanceof Error ? e.message : "提交失败"); }
    finally { setBusy(false); }
  }
  function publish(event: FormEvent) {
    event.preventDefault(); if (!data) return;
    void submit(`tasks/${taskId}/results`, { validationId, note, expectedVersion: data.task.version, idempotencyKey: crypto.randomUUID(), ...((data.resolution || data.revert) ? { acknowledgeResolution } : {}) });
  }
  return <section className="collab-snapshots" aria-label="任务成果与依赖版本">
    <div className="collab-section-heading"><div><p className="collab-eyebrow">明确输入 · 不覆盖旧成果</p><h2>任务成果与依赖版本</h2></div></div>
    <p className="collab-muted collab-small">发布经过验证的快照供下游使用，不代表任务完成或可以合并。新版本保留旧记录，运行中的 AI 不会被强制替换输入。</p>
    {error && <p className="collab-error" role="alert">{error}</p>}
    {retry && <button className="collab-button" disabled={busy} onClick={() => pending.current && void submit(pending.current.endpoint, pending.current.body)}>重试同一成果操作</button>}
    {inputs && <div className="collab-snapshot-card"><strong role="status">{states[inputs.run.dependency_state]}</strong>
      <p className="collab-muted collab-small">已锁定的直接依赖可从当前工作区的 ../dependencies/ 读取。源副本不可修改；软依赖缺失时可先开发，之后必须使用真实成果重新运行与验证。</p>
      {inputs.dependencies.map(d => <p className="collab-small" key={d.task_id}>{d.title} · {d.kind === "strict" ? "严格" : "软依赖"} · {d.result_id ? `v${d.version} · ${d.worktree_commit?.slice(0, 12)}${d.is_current ? "" : " · 已非当前版本或已撤回"}` : "尚无锁定成果"}</p>)}
      {inputs.run.dependency_state === "needs_revalidation" && <p className="collab-muted">旧运行保持原输入。请保存代码后显式启动新运行，取得当前依赖并重新验证；旧证据不能用于发布新成果。</p>}
    </div>}
    {canPublish && data && <form className="collab-form compact" onSubmit={publish}>
      <label>成果验证记录<select aria-label="成果验证记录" required value={validationId} disabled={busy || retry} onChange={e => { setValidationId(e.target.value); setAcknowledgeResolution(false); }}><option value="">选择已通过且依赖有效的验证</option>{data.validations.map(v => <option key={v.id} value={v.id}>{v.profile_name} · {v.worktree_commit.slice(0, 12)} · {v.id.slice(0, 8)}</option>)}</select></label>
      {data.revert && <p className="collab-muted">撤回来源 {data.revert.new_sha.slice(0,12)} · 固定基线 {data.revert.target_sha.slice(0,12)}。请确认保留后续独立变更，说明文本、二进制与删除选择。</p>}
      <label>成果说明<textarea aria-label="成果说明" required rows={2} minLength={(data.resolution || data.revert) ? 10 : 1} maxLength={4000} value={note} disabled={busy || retry} onChange={e => setNote(e.target.value)} placeholder={(data.resolution || data.revert) ? "说明如何保留整组成果，以及文本、二进制、重命名和删除冲突的选择" : "下游可以使用哪些接口或文件，尚有哪些限制"} /></label>
      {(data.resolution || data.revert) && <label className="collab-checkbox"><input type="checkbox" aria-label="确认所有冲突选择" checked={acknowledgeResolution} disabled={busy || retry} onChange={e => setAcknowledgeResolution(e.target.checked)} /><span>我已核对全部冲突选择，包括二进制、重命名与删除；此成果包含已核对的固定变更，仍须独立评审。</span></label>}
      <button className="collab-button" disabled={busy || retry || !data.validations.some(v => v.id === validationId) || (!!(data.resolution || data.revert) && !acknowledgeResolution)}>发布成果版本</button>
    </form>}
    {!data?.results.length && <p className="collab-muted">尚未发布可供下游使用的成果。</p>}
    {data?.results.map(r => <article key={r.id} className="collab-snapshot-card"><div className="collab-snapshot-heading"><strong role="status">成果 v{r.version}{r.withdrawal_reason ? " · 已撤回" : data.task.current_result_id === r.id ? " · 当前版本" : " · 历史版本"}</strong><small>{r.worktree_commit.slice(0, 12)}</small></div>
      <p className="collab-prewrap">{r.note}</p>{r.withdrawal_reason && <p className="collab-muted">撤回原因：{r.withdrawal_reason}</p>}
      {r.dependency_state !== "current" && <p className="collab-muted">此成果的依赖已变化，需要重新验证。</p>}
      <div className="collab-form-actions"><a className="collab-text-button" href={`/api/collab/snapshots/${r.snapshot_id}`} download>查看快照清单</a><a className="collab-text-button" href={`/api/collab/validations/${r.validation_id}`} download>查看验证证据</a></div>
      <ResultEvidence resultId={r.id} version={r.version} />
      {canPublish && !r.withdrawal_reason && <details><summary>撤回此成果</summary><form className="collab-form compact" onSubmit={e => { e.preventDefault(); void submit(`results/${r.id}/withdraw`, { reason }); }}>
        <label>撤回原因<textarea aria-label={`成果 v${r.version} 撤回原因`} required minLength={10} maxLength={2000} rows={2} disabled={busy || retry} value={reason} onChange={e => setReason(e.target.value)} /></label>
        <button className="collab-button" disabled={busy || retry}>确认撤回成果 v{r.version}</button>
      </form></details>}
    </article>)}
  </section>;
}
