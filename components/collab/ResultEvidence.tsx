"use client";
import { useEffect, useState } from "react";
import { collabApi, CollabApiError } from "./api";
import type { ResultEvidenceBundle } from "@/lib/collab/result-evidence";

export function ResultEvidence({ resultId, version }: { resultId: string; version: number }) {
  const [bundle, setBundle] = useState<ResultEvidenceBundle | null>(null), [busy, setBusy] = useState(false), [stale, setStale] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    if (!bundle) return;
    let active = true, loading = false;
    const check = async () => {
      if (loading || document.visibilityState !== "visible") return; loading = true;
      try {
        const state = await collabApi<{ metadataHash: string }>(`results/${resultId}/evidence?status=1`);
        if (active) setStale(state.metadataHash !== bundle.payload.metadataHash);
      } catch (e) {
        if (active) { setStale(true); setError(e instanceof Error ? e.message : "状态读取失败"); if (e instanceof CollabApiError && [401, 403, 404].includes(e.status)) setBundle(null); }
      } finally { loading = false; }
    };
    const timer = setInterval(() => void check(), 5000);
    return () => { active = false; clearInterval(timer); };
  }, [bundle, resultId]);
  async function load(download = false) {
    if (busy) return; setBusy(true); setError("");
    try {
      const value = await collabApi<ResultEvidenceBundle>(`results/${resultId}/evidence`);
      setBundle(value); setStale(false);
      if (download) {
        const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2) + "\n"], { type: "application/json" })), link = document.createElement("a");
        link.href = url; link.download = `pi-collab-evidence-${resultId}-${value.sha256.slice(0, 12)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (e) { setBundle(null); setError(e instanceof Error ? e.message : "证据汇集失败"); }
    finally { setBusy(false); }
  }
  const p = bundle?.payload;
  const current = p && p.state.currentResult && p.state.dependencyState === "current" && !p.state.withdrawal && p.state.repositoryBaseSha === p.code.baseSha;
  return <section aria-label={`变更证据包 v${version}`} className="collab-settings-section">
    <h3>变更证据包</h3>
    <p className="collab-muted collab-small">汇集该成果的需求、固定代码差异、执行器验证、讨论和版本评审。下载是当前时点的记录，后续合并仍核对最新权限与版本。</p>
    <div className="collab-form-actions"><button className="collab-button" disabled={busy} onClick={() => void load()}>{busy ? "正在汇集…" : bundle ? "重新汇集证据" : "查看变更证据包"}</button><button className="collab-button" disabled={busy} onClick={() => void load(true)}>下载证据包 JSON</button></div>
    {error && <p role="alert" className="collab-error">{error}</p>}
    {p && <div>
      <p role="status">{stale ? "记录已变化，请重新汇集证据。" : current ? "汇集时成果与依赖有效；验证通过不等于允许合并。" : "历史或过期成果：请查看撤回、依赖和基线状态。"}</p>
      <p className="collab-small collab-git-identity">汇集时间：{new Date(p.observedAt).toLocaleString()}<br/>基线：{p.code.baseSha}<br/>受检代码：{p.code.worktreeCommit}<br/>证据 SHA-256：{bundle!.sha256}</p>
      {p.state.withdrawal && <p>撤回原因：{p.state.withdrawal.reason}</p>}
      <details><summary>原始需求与验收</summary><strong>{p.captured.title}</strong><p className="collab-prewrap">{p.captured.description}</p><p className="collab-prewrap">{p.captured.acceptance}</p></details>
      <details><summary>固定代码差异 · {p.code.changes.length} 项</summary>{p.code.changes.map(file => <details key={file.path}><summary>{file.path} · {file.kind}{file.omitted ? ` · 未展示：${file.omitted}` : ""}</summary>{!file.omitted && <pre style={{ overflowX: "auto", maxHeight: 320 }}>{file.lines.map(line => `${line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "}${line.text}`).join("\n")}</pre>}</details>)}<p className="collab-muted">快照排除 {p.code.excluded.length} 项；未展示的内容不算已核对。</p></details>
      <details><summary>执行器验证 · {p.validation.status}</summary><p className="collab-small">{p.validation.evidence.environment.policy} · {p.validation.evidence.environment.image ?? p.validation.evidence.environment.node}</p>{p.validation.evidence.steps.map((step, i) => <div key={i}><code>{step.tool} {JSON.stringify(step.args)}</code><p>退出码 {String(step.exitCode)} · 退出确认 {step.cleanupConfirmed ? "是" : "否"} · 源码未变 {step.sourceUnchanged ? "是" : "否"}</p></div>)}</details>
      <p className="collab-small">整合记录 {p.integrations.length} · 讨论 {p.discussions.length} · GitHub 版本 {p.github.revisions.length} · GitLab 记录 {p.gitlab.length}</p>
      <p className="collab-muted collab-small">评审只适用于各自记录的版本。已识别并隐藏敏感文本 {p.redactions.length} 处；工具摘要不包含原始输出或私有推理。完整结构、评论与批准记录见下载文件。</p>
    </div>}
  </section>;
}
