"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { collabApi, CollabApiError } from "./api";
import type { WorkDeclaration } from "@/lib/collab/work-intent-schema";
import type { Snapshot } from "./TaskSnapshots";

type Intent = { author_kind: "human" | "agent"; id: string; revision: number; declaration: WorkDeclaration; created_at: string };
type Listing = { latest: Intent | null; history: Intent[]; overlaps: { taskId: string; title: string; revision: number; paths: { ours: string; theirs: string }[]; pathCount: number; symbols: string[] }[]; peersTruncated: boolean };
type Report = { snapshotId: string; baseSha: string; intentRevision: number | null; changeCount: number; undeclaredCount: number; changesTruncated: boolean; excludedCount: number; excludedTruncated: boolean; changes: { path: string; kind: string; declared: boolean }[]; excluded: { path: string; reason: string }[] };
const kinds: Record<WorkDeclaration["changeType"], string> = { feature: "新功能", fix: "修复", refactor: "重构", api: "公共 API", schema: "数据结构", config: "共享配置", docs: "文档", test: "测试" };
export function WorkIntents({ runId, eventGeneration, canDeclare, snapshots }: { runId: string; eventGeneration: number; canDeclare: boolean; snapshots: Snapshot[] }) {
  const [data, setData] = useState<Listing | null>(null), [refresh, setRefresh] = useState(0), [error, setError] = useState("");
  const [paths, setPaths] = useState(""), [symbols, setSymbols] = useState(""), [summary, setSummary] = useState(""), [kind, setKind] = useState<WorkDeclaration["changeType"]>("feature"), [eta, setEta] = useState("");
  const [revision, setRevision] = useState(0), [busy, setBusy] = useState(false), [retry, setRetry] = useState(false), [report, setReport] = useState<Report | null>(null);
  const pending = useRef<{ expectedRevision: number; idempotencyKey: string; declaration: WorkDeclaration } | null>(null), initialized = useRef(false);
  function loadForm(intent: Intent | null) {
    setRevision(intent?.revision ?? 0); setPaths(intent?.declaration.paths.join("\n") ?? ""); setSymbols(intent?.declaration.symbols.join("\n") ?? ""); setSummary(intent?.declaration.summary ?? ""); setKind(intent?.declaration.changeType ?? "feature");
    const date = intent?.declaration.expectedCompletion ? new Date(intent.declaration.expectedCompletion) : null;
    setEta(date ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "");
  }
  useEffect(() => {
    let active = true, loading = false;
    async function load() {
      if (loading) return; loading = true;
      try {
        const next = await collabApi<Listing>(`runs/${runId}/intents`);
        if (active) { setData(next); if (!initialized.current) { initialized.current = true; loadForm(next.latest); } }
      } catch (e) {
        if (active) { setError(e instanceof Error ? e.message : "读取范围失败"); if (e instanceof CollabApiError && [401, 403, 404].includes(e.status)) { setData(null); setReport(null); } }
      } finally { loading = false; }
    }
    void load(); const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 5000);
    const resume = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", resume); window.addEventListener("online", resume);
    return () => { active = false; clearInterval(timer); document.removeEventListener("visibilitychange", resume); window.removeEventListener("online", resume); };
  }, [runId, refresh, eventGeneration]);
  async function save(event: FormEvent) {
    event.preventDefault(); if (busy || !data) return; setBusy(true); setError("");
    pending.current ??= { expectedRevision: revision, idempotencyKey: crypto.randomUUID(), declaration: { paths: paths.split("\n").map(s => s.trim()).filter(Boolean), symbols: symbols.split("\n").map(s => s.trim()).filter(Boolean), summary, changeType: kind, expectedCompletion: eta ? new Date(eta).toISOString() : null } };
    try {
      const result = await collabApi<{ revision: number }>(`runs/${runId}/intents`, pending.current);
      pending.current = null; setRetry(false); setRevision(result.revision); setRefresh(n => n + 1);
    } catch (e) {
      if (e instanceof CollabApiError && e.status < 500) { pending.current = null; setRefresh(n => n + 1); }
      setRetry(!!pending.current); setError(e instanceof Error ? e.message : "范围声明失败");
    } finally { setBusy(false); }
  }
  async function inspect(id: string) {
    setBusy(true); setError(""); setReport(null);
    try { setReport(await collabApi<Report>(`snapshots/${id}/scope`)); }
    catch (e) { setError(e instanceof Error ? e.message : "无法核对范围"); }
    finally { setBusy(false); }
  }
  return <section className="collab-snapshots" aria-label="修改范围与重叠告警">
    <div className="collab-section-heading"><div><p className="collab-eyebrow">提前沟通 · 保留声明历史</p><h2>修改范围与重叠告警</h2></div></div>
    <p className="collab-muted collab-small">声明用于协作提醒，不授予文件权限或独占修改权。重叠任务仍可并行；公共接口变更需要另行协商。</p>
    {error && <p className="collab-error" role="alert">{error}</p>}
    <p role="status">{data?.latest ? `当前范围声明 v${data.latest.revision}` : "本次运行尚未声明范围"}</p>
    {canDeclare && data && <form className="collab-form compact" onSubmit={save}>
      <label>预期修改路径<textarea aria-label="预期修改路径" required rows={3} maxLength={32768} placeholder={"src/api/\nsrc/types.ts"} value={paths} disabled={busy || retry} onChange={e => setPaths(e.target.value)} /></label>
      <p className="collab-muted collab-small">每行一项；目录以 / 结尾，包含其子目录。请填写相对路径，不使用通配符。</p>
      <label>变更类型<select aria-label="范围变更类型" value={kind} disabled={busy || retry} onChange={e => setKind(e.target.value as WorkDeclaration["changeType"])}>{Object.entries(kinds).map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select></label>
      <label>范围说明<textarea aria-label="范围说明" required rows={2} maxLength={2000} value={summary} disabled={busy || retry} onChange={e => setSummary(e.target.value)} /></label>
      <details><summary>可选接口标识与时间</summary>
        <label>符号或 API 标识<textarea aria-label="符号或 API 标识" rows={2} value={symbols} disabled={busy || retry} onChange={e => setSymbols(e.target.value)} placeholder="每行一项，例如 GET /api/orders" /></label>
        <label>预计完成时间<input aria-label="预计完成时间" type="datetime-local" value={eta} disabled={busy || retry} onChange={e => setEta(e.target.value)} /></label>
      </details>
      {(data.latest?.revision ?? 0) !== revision && <p className="collab-muted">其他成员已更新声明，请先载入最新版本，再重新修改。</p>}
      <div className="collab-form-actions"><button className="collab-button" disabled={busy || (!retry && (data.latest?.revision ?? 0) !== revision)}>{retry ? "重试同一范围声明" : "保存范围声明"}</button>
        <button type="button" className="collab-text-button" disabled={busy || retry} onClick={() => loadForm(data.latest)}>载入最新声明</button></div>
    </form>}
    {!canDeclare && <p className="collab-muted collab-small">仅当前运行的控制者或维护者可在运行结束前声明。停止后保留历史，不补写范围。</p>}
    {data?.latest && <p className="collab-prewrap">{data.latest.declaration.paths.join("\n")}<br />{data.latest.declaration.summary}</p>}
    {data?.overlaps.map(peer => <article className="collab-snapshot-card" key={peer.taskId}><strong>范围重叠：{peer.title}</strong><p className="collab-muted collab-small">对方声明 v{peer.revision}；请与负责人协调接口与修改顺序。</p>
      {peer.paths.map((p, i) => <p className="collab-prewrap collab-small" key={i}>{p.ours} ↔ {p.theirs}</p>)}{peer.pathCount > peer.paths.length && <p>还有 {peer.pathCount - peer.paths.length} 项路径重叠。</p>}{peer.symbols.map(s => <p className="collab-prewrap collab-small" key={s}>共同接口标识：{s}</p>)}
    </article>)}
    {!!data?.latest && !data.overlaps.length && <p className="collab-muted">已检查的声明中未发现路径或接口标识重叠。未声明的任务和语义冲突仍需人工关注。</p>}
    {data?.peersTruncated && <p className="collab-muted">仅比较最近 200 个相关任务，告警列表不完整。</p>}
    {!!data?.history.length && <details><summary>范围声明历史</summary>{data.history.map(i => <p className="collab-prewrap collab-small" key={i.id}>v{i.revision} · {i.author_kind === "agent" ? "AI 提交" : "成员提交"} · {new Date(i.created_at).toLocaleString()} · {i.declaration.paths.join("、")}<br />{i.declaration.summary}</p>)}<p className="collab-muted collab-small">显示最近 50 个版本。</p></details>}
    {snapshots.filter(s => s.run_id === runId && s.status === "ready").map(s => <div className="collab-form-actions" key={s.id}><button className="collab-text-button" disabled={busy} onClick={() => void inspect(s.id)}>核对快照范围 · {s.id.slice(0, 8)}</button><a className="collab-text-button" href={`/api/collab/snapshots/${s.id}/scope`} download>下载范围证据</a></div>)}
    {report && <article className="collab-snapshot-card"><strong role="status">实际变更 {report.changeCount} 项 · 未声明 {report.undeclaredCount} 项</strong>
      <p className="collab-muted collab-small">仓库基线 {report.baseSha.slice(0, 12)} · {report.intentRevision ? `声明 v${report.intentRevision}` : "无范围声明"}。比较快照中的最终工作代码，包含本地提交；不追溯中途写入后又还原的操作。</p>
      {report.changes.map(c => <p className="collab-prewrap collab-small" key={c.path}>{c.path} · {{ added: "新增", modified: "修改", deleted: "删除" }[c.kind]} · {c.declared ? "已声明" : "未声明"}</p>)}
      {report.changesTruncated && <p>显示前 1,000 项变更，计数包含全部已检查路径。</p>}
      <p className="collab-muted">{report.excludedCount} 项排除路径未核对，不能据此认定全部修改均在范围内。</p>
      {!!report.excludedCount && <details><summary>未核对的排除路径</summary>{report.excluded.map(e => <p className="collab-prewrap collab-small" key={e.path}>{e.path} · {e.reason}</p>)}{report.excludedTruncated && <p>只显示前 1,000 项排除路径。</p>}</details>}
    </article>}
  </section>;
}
