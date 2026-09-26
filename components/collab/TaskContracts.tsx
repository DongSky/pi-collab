"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ContractCompatibility } from "./ContractCompatibility";
import type { CompatibilityReport } from "@/lib/collab/contract-compatibility";
import { collabApi, CollabApiError } from "./api";
import type { ContractContent } from "@/lib/collab/contract-schema";
type Approval = { taskId: string; ownerId: string; decisionId: string | null; version: number; decision: string | null; approved: boolean; note: string | null };
type Contract = { id: string; key: string; repository_id: string; producer_task_id: string; current_revision_id: string | null; version: number; body: string | null; body_hash: string | null; override_reason: string | null };
type Proposal = { compatibilityReport: CompatibilityReport; source_run_id: string | null; id: string; key: string; content: ContractContent; producer_task_id: string; published_revision_id: string | null; stale: boolean; approvals: Approval[]; overridden_tasks: string[]; override_reason: string | null; task_names: Record<string, string> };
type Listing = { contracts: Contract[]; proposals: Proposal[] };
type Inputs = { run: { dependency_state: string }; contracts: { key: string; version: number; body: string; body_hash: string; revision_id: string; is_current: boolean }[] };
const empty: ContractContent = { title: "", format: "text", definition: "", compatibility: "initial", migrationGuide: "", mockJson: null };
export function TaskContracts({ taskId, tasks, runId, userId, role, canPropose, repositories, eventGeneration, onChange }: { taskId: string; tasks: { id: string; title: string }[]; runId?: string; userId: string; role: string; canPropose: boolean; repositories: { id: string; name: string }[]; eventGeneration: number; onChange: () => Promise<void> }) {
  const [data, setData] = useState<Listing | null>(null), [inputs, setInputs] = useState<Inputs | null>(null), [refresh, setRefresh] = useState(0);
  const [contractId, setContractId] = useState(""), [repositoryId, setRepositoryId] = useState(""), [key, setKey] = useState(""), [content, setContent] = useState<ContractContent>(empty), [extra, setExtra] = useState<string[]>([]);
  const [parentRevisionId, setParentRevisionId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({}), [reasons, setReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false), [retry, setRetry] = useState(false), [error, setError] = useState("");
  const pending = useRef<{ endpoint: string; body: unknown } | null>(null);
  const requirementSignature = useRef<string | null>(null), refreshProject = useRef(onChange);
  useEffect(() => { refreshProject.current = onChange; }, [onChange]);
  useEffect(() => {
    let active = true, loading = false; setInputs(null);
    async function load() {
      if (loading) return; loading = true;
      try {
        const [next, pins] = await Promise.all([collabApi<Listing>(`tasks/${taskId}/contracts`), runId ? collabApi<Inputs>(`runs/${runId}/contracts`) : Promise.resolve(null)]);
        if (active) {
          const signature = JSON.stringify(next.contracts.map(c => [c.id, c.current_revision_id]));
          if (requirementSignature.current !== null && requirementSignature.current !== signature) await refreshProject.current();
          if (active) { requirementSignature.current = signature; setData(next); setInputs(pins); }
        }
      } catch (e) { if (active) { setError(e instanceof Error ? e.message : "无法读取契约"); if (e instanceof CollabApiError && [401, 403, 404].includes(e.status)) { setData(null); setInputs(null); } } }
      finally { loading = false; }
    }
    void load(); const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 5000);
    const resume = () => { if (document.visibilityState === "visible") void load(); }; document.addEventListener("visibilitychange", resume);
    return () => { active = false; clearInterval(timer); document.removeEventListener("visibilitychange", resume); };
  }, [taskId, runId, refresh, eventGeneration]);
  async function submit(endpoint: string, body: unknown) {
    if (busy) return; setBusy(true); setError(""); pending.current ??= { endpoint, body };
    try { await collabApi(pending.current.endpoint, pending.current.body); pending.current = null; setRetry(false); setRefresh(n => n + 1); await onChange(); }
    catch (e) { if (e instanceof CollabApiError && e.status < 500) { pending.current = null; setRefresh(n => n + 1); } setRetry(!!pending.current); setError(e instanceof Error ? e.message : "契约操作失败"); }
    finally { setBusy(false); }
  }
  function select(id: string) {
    setContractId(id); const c = data?.contracts.find(c => c.id === id);
    setParentRevisionId(c?.current_revision_id ?? null);
    if (c) { setRepositoryId(c.repository_id); setKey(c.key); setContent(c.body ? { ...JSON.parse(c.body), compatibility: "compatible" } : empty); } else { setKey(""); setContent(empty); }
  }
  function propose(event: FormEvent) {
    event.preventDefault(); const current = data?.contracts.find(c => c.id === contractId);
    void submit(`tasks/${taskId}/contracts`, { repositoryId: current?.repository_id ?? repositoryId, key: current?.key ?? key, parentRevisionId, content,
      affectedTaskIds: extra, idempotencyKey: crypto.randomUUID() });
  }
  const locked = busy || retry;
  return <section className="collab-snapshots" aria-label="接口契约与确认">
    <div className="collab-section-heading"><div><p className="collab-eyebrow">先约定接口 · 再独立实现</p><h2>接口契约与确认</h2></div></div>
    <p className="collab-muted collab-small">提案自动纳入依赖图中的下游任务。负责人确认后发布固定版本；维护者可带原因裁决。mock 是示例数据，仍需真实依赖与组合验证。</p>
    {error && <p className="collab-error" role="alert">{error}</p>}
    {retry && <button className="collab-button" disabled={busy} onClick={() => pending.current && void submit(pending.current.endpoint, pending.current.body)}>重试同一契约操作</button>}
    {inputs && <div className="collab-snapshot-card"><strong>本次运行锁定的契约</strong>
      {inputs.contracts.map(c => <details key={c.revision_id}><summary>{c.key} · v{c.version}{c.is_current ? "" : " · 已有新版"}</summary><pre className="collab-prewrap collab-small">{JSON.parse(c.body).definition}</pre><small>{c.body_hash}</small></details>)}
      {!inputs.contracts.length && <p className="collab-muted">本次运行没有锁定契约。后来新增的要求不会补写进旧运行。</p>}
      {inputs.run.dependency_state === "needs_revalidation" && <p role="status">依赖或契约已变化，请保存工作后启动新运行并重新验证。</p>}
    </div>}
    {data?.contracts.map(c => <article className="collab-snapshot-card" key={c.id}><strong role="status">{c.key} · {c.current_revision_id ? `已发布 v${c.version}` : "尚未发布"}</strong>
      {c.body && <details><summary>查看当前契约</summary><pre className="collab-prewrap collab-small">{JSON.parse(c.body).definition}</pre>{JSON.parse(c.body).mockJson && <pre className="collab-prewrap collab-small">Mock：{JSON.parse(c.body).mockJson}</pre>}</details>}
      {c.override_reason && <p className="collab-prewrap collab-small">维护者裁决：{c.override_reason}</p>}
    </article>)}
    {canPropose && <details><summary>创建或修订契约提案</summary><form className="collab-form compact" onSubmit={propose}>
      <label>修订对象<select aria-label="契约修订对象" value={contractId} disabled={locked} onChange={e => select(e.target.value)}><option value="">创建新契约</option>{data?.contracts.filter(c => c.producer_task_id === taskId).map(c => <option key={c.id} value={c.id}>{c.key} · v{c.version}</option>)}</select></label>
      {contractId && data?.contracts.find(c => c.id === contractId)?.current_revision_id !== parentRevisionId && <p className="collab-muted">当前契约已有新版本。此草稿仍基于旧版本，请先载入当前契约，再重新编辑。<button type="button" className="collab-text-button" disabled={locked} onClick={() => select(contractId)}>载入当前契约</button></p>}
      <label>契约仓库<select aria-label="契约仓库" required value={repositoryId} disabled={locked || !!contractId} onChange={e => setRepositoryId(e.target.value)}><option value="">选择仓库</option>{repositories.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
      <label>契约标识<input aria-label="契约标识" required maxLength={80} pattern="[a-z0-9][a-z0-9._-]*" value={key} disabled={locked || !!contractId} onChange={e => setKey(e.target.value)} placeholder="orders-api" /></label>
      <label>契约标题<input aria-label="契约标题" required maxLength={120} value={content.title} disabled={locked} onChange={e => setContent(c => ({ ...c, title: e.target.value }))} /></label>
      <label>定义格式<select aria-label="契约定义格式" disabled={locked} value={content.format} onChange={e => setContent(c => ({ ...c, format: e.target.value as ContractContent["format"] }))}><option value="text">文本约定</option><option value="json-schema">JSON Schema（JSON）</option><option value="openapi">OpenAPI（JSON）</option></select></label>
      <label>接口定义<textarea aria-label="接口定义" required rows={5} maxLength={20000} disabled={locked} value={content.definition} onChange={e => setContent(c => ({ ...c, definition: e.target.value }))} /></label>
      <label>兼容策略<select aria-label="契约兼容策略" value={content.compatibility} disabled={locked} onChange={e => setContent(c => ({ ...c, compatibility: e.target.value as ContractContent["compatibility"] }))}><option value="initial">首次发布</option><option value="compatible">兼容扩展（需确认）</option><option value="breaking">破坏性变更</option></select></label>
      <label>迁移说明<textarea aria-label="契约迁移说明" rows={2} maxLength={4000} required={content.compatibility === "breaking"} minLength={content.compatibility === "breaking" ? 10 : undefined} value={content.migrationGuide} disabled={locked} onChange={e => setContent(c => ({ ...c, migrationGuide: e.target.value }))} /></label>
      <label>JSON mock 示例<textarea aria-label="契约 mock" rows={2} maxLength={8000} value={content.mockJson ?? ""} disabled={locked} onChange={e => setContent(c => ({ ...c, mockJson: e.target.value || null }))} /></label>
      <label>额外受影响任务<select aria-label="额外受影响任务" multiple size={4} value={extra} disabled={locked} onChange={e => setExtra([...e.target.selectedOptions].map(option => option.value))}>{tasks.filter(t => t.id !== taskId).map(t => <option key={t.id} value={t.id}>{t.title}</option>)}</select></label>
      <p className="collab-muted collab-small">可选多项；依赖图中的下游任务和已有契约消费者会自动加入。</p>
      <button className="collab-button" disabled={locked}>提交契约提案</button>
    </form></details>}
    {data?.proposals.map(p => <article className="collab-snapshot-card" key={p.id} aria-label={`契约提案 ${p.content.title}`}><strong role="status">{p.content.title} · {p.published_revision_id ? "已发布" : p.stale ? "基准已过期" : "等待确认"}</strong>
      <p className="collab-small">{p.key} · {{ initial: "首次发布", compatible: "兼容扩展", breaking: "破坏性变更" }[p.content.compatibility]}</p>
      {p.source_run_id && <p className="collab-muted collab-small">AI 提案 · 运行 {p.source_run_id.slice(0, 8)}</p>}
      <details><summary>查看提案内容</summary><pre className="collab-prewrap collab-small">{p.content.definition}</pre><p className="collab-prewrap collab-small">{p.content.migrationGuide}</p>{p.content.mockJson && <pre className="collab-prewrap collab-small">Mock：{p.content.mockJson}</pre>}</details>
      {p.compatibilityReport && <ContractCompatibility report={p.compatibilityReport} claimed={p.content.compatibility}/> }
      {p.override_reason && <p className="collab-prewrap collab-small">维护者裁决：{p.override_reason}</p>}
      {p.published_revision_id && <a className="collab-text-button" href={`/api/collab/contract-revisions/${p.published_revision_id}`} download>下载此版本与确认记录</a>}
      {p.approvals.map(a => <div key={a.taskId}><p className="collab-prewrap collab-small">{p.task_names[a.taskId]} · {p.overridden_tasks.includes(a.taskId) ? "已由维护者裁决" : a.approved ? "已确认" : a.decision === "reject" ? "拒绝或需重新确认" : "尚未有效确认"}{a.note && ` · ${a.note}`}</p>
        {!p.published_revision_id && !p.stale && a.ownerId === userId && ["maintainer", "developer"].includes(role) && <form className="collab-form compact" onSubmit={e => { e.preventDefault(); const decision = (e.nativeEvent as SubmitEvent).submitter?.getAttribute("value") ?? "approve"; void submit(`contract-proposals/${p.id}/decisions`, { taskId: a.taskId, expectedVersion: a.version, decision, note: notes[`${p.id}:${a.taskId}`] ?? "", idempotencyKey: crypto.randomUUID() }); }}>
          <label>确认说明<textarea aria-label={`契约确认说明 ${p.task_names[a.taskId]}`} rows={2} required maxLength={2000} value={notes[`${p.id}:${a.taskId}`] ?? ""} disabled={locked} onChange={e => setNotes(n => ({ ...n, [`${p.id}:${a.taskId}`]: e.target.value }))} /></label>
          <div className="collab-form-actions"><button className="collab-button" value="approve" disabled={locked}>确认契约 · {p.task_names[a.taskId]}</button><button className="collab-text-button" value="reject" disabled={locked}>拒绝契约 · {p.task_names[a.taskId]}</button></div>
        </form>}
      </div>)}
      {!p.published_revision_id && !p.stale && (role === "maintainer" || (canPropose && p.producer_task_id === taskId)) && <form className="collab-form compact" onSubmit={e => { e.preventDefault(); void submit(`contract-proposals/${p.id}/publish`, { idempotencyKey: crypto.randomUUID(), overrideReason: reasons[p.id]?.trim() || null }); }}>
        {role === "maintainer" && <label>维护者裁决原因<textarea aria-label={`维护者裁决原因 ${p.content.title}`} rows={2} maxLength={2000} value={reasons[p.id] ?? ""} disabled={locked} onChange={e => setReasons(r => ({ ...r, [p.id]: e.target.value }))} placeholder="全部有效确认时可留空；绕过缺少或拒绝确认时必须说明原因（至少 10 字符）" /></label>}
        <button className="collab-button" disabled={locked}>发布契约 · {p.content.title}</button>
      </form>}
    </article>)}
    <p className="collab-muted collab-small">当前展示最多 100 项相关契约和 50 个近期提案；已发布版本及审计记录持续保留。</p>
  </section>;
}
