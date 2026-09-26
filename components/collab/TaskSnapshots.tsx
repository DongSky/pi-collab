"use client";
import { useState, type FormEvent } from "react";
import { EnvironmentHandoff } from "./EnvironmentHandoff";
import { collabApi, CollabApiError } from "./api";

export type Snapshot = { id: string; run_id: string; status: string; note: string; error_code: string | null; repository_id: string; base_sha: string; created_at: string;
  summary: { sourceHead: string; exportedHead: string; fileCount: number; changeCount: number; excludedCount: number; omissions: string[];
    changes: { path: string; staged: boolean; untracked: boolean; deleted: boolean }[]; excluded: { path: string; reason: string }[] } | null };
const names: Record<string, string> = { pending: "等待生成快照", ready: "快照可恢复", failed: "快照未生成", revoked: "权限已变化" };
const errors: Record<string, string> = {
  snapshot_exit_unconfirmed: "缺少可核验的进程退出证据。请先完成运行对账。", snapshot_unmerged_index: "存在未解决的 Git 冲突，当前快照格式不能完整保存冲突索引。",
  snapshot_source_changed: "捕获期间代码发生变化，请确认没有其他写入者后重试。", snapshot_limit: "超过快照文件数量或总大小上限。",
  snapshot_unsafe_git: "Git 元数据包含不支持的外部引用或链接。", snapshot_unsafe_path: "工作区路径无法安全读取。",
  snapshot_filename_unsupported: "文件名不符合可移植路径要求。", snapshot_path_collision: "文件名存在大小写或 Unicode 冲突。",
  snapshot_index_flags: "Git 索引使用暂存意图、稀疏检出或忽略更新等特殊标志，当前快照格式尚不支持。",
  snapshot_runtime_unsupported: "该运行后端尚不支持快照。", authorization_changed: "申请人的权限已变化，请重新申请。",
};
const reasons: Record<string, string> = { private_path: "私密路径", generated: "生成内容", large_file: "超过 2 MiB", secret_pattern: "疑似凭据", symlink: "符号链接", submodule: "子模块", special_file: "特殊文件" };
export function TaskSnapshots({ snapshots, run, canCapture, refresh, onRestore }: { snapshots: Snapshot[]; run?: { id: string; revision: string; status: string; workspace_status: string }; canCapture: boolean; refresh: () => Promise<void>; onRestore?: (snapshot: Snapshot) => void }) {
  const [note, setNote] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [pending, setPending] = useState<{ runId: string; body: { idempotencyKey: string; expectedRevision: string; note: string } } | null>(null);
  const currentPending = pending?.runId === run?.id ? pending : null;
  async function capture(event: FormEvent) {
    event.preventDefault(); if (!run || busy) return;
    const body = currentPending?.body ?? { idempotencyKey: crypto.randomUUID(), expectedRevision: run.revision, note };
    setPending({ runId: run.id, body }); setBusy(true); setError("");
    try { await collabApi(`runs/${run.id}/snapshots`, body); setPending(null); setNote(""); await refresh(); }
    catch (e) { if (e instanceof CollabApiError && e.status < 500) setPending(null); setError(e instanceof Error ? e.message : "快照申请失败"); }
    finally { setBusy(false); }
  }
  return <section aria-label="任务交接快照" className="collab-snapshots">
    <div className="collab-section-heading"><div><p className="collab-eyebrow">保存代码 · 授权后接续</p><h2>任务交接快照</h2></div></div>
    <p className="collab-muted collab-small">保存提交基线、暂存修改和未跟踪文件；恢复时创建独立工作区。不会恢复旧 AI 会话、凭据、外部服务或已通过测试的状态。</p>
    {error && <p className="collab-error" role="alert">{error}</p>}
    {canCapture && run && ["completed", "failed", "cancelled"].includes(run.status) && ["stopped", "archived"].includes(run.workspace_status) && <form className="collab-form compact" onSubmit={capture}>
      <label>交接说明<textarea aria-label="快照交接说明" rows={2} required maxLength={4000} value={currentPending?.body.note ?? note} disabled={busy || !!currentPending} onChange={e => setNote(e.target.value)} placeholder="已完成什么、还需做什么、依赖哪些环境，以及建议重新执行的验证命令" /></label>
      <button className="collab-button" disabled={busy || (!currentPending && snapshots.some(s => s.run_id === run.id && s.status === "pending"))}>{currentPending ? "重试同一快照请求" : "保存交接快照"}</button>
    </form>}
    {!snapshots.length && <p className="collab-muted">尚无快照。运行停止后可由任务负责人或维护者保存。</p>}
    {snapshots.map(snapshot => <article key={snapshot.id} className="collab-snapshot-card">
      <div className="collab-snapshot-heading"><strong role="status">{names[snapshot.status]}</strong><small>{new Date(snapshot.created_at).toLocaleString()}</small></div>
      <p className="collab-prewrap">{snapshot.note}</p>
      {snapshot.error_code && <p className="collab-muted">{errors[snapshot.error_code] ?? "未能生成完整快照，原工作区保留，可排查后重新申请。"}</p>}
      {snapshot.summary && <>
        <p className="collab-muted collab-small">原提交 {snapshot.summary.sourceHead.slice(0, 12)} · 快照基线 {snapshot.summary.exportedHead.slice(0, 12)} · {snapshot.summary.fileCount} 个工作文件</p>
        <details><summary>变更 {snapshot.summary.changeCount} 项 · 排除 {snapshot.summary.excludedCount} 项</summary>
          <div style={{ maxHeight: "18rem", overflow: "auto" }}>
            {snapshot.summary.changes.map(file => <p className="collab-small" key={file.path}>{file.path} · {file.deleted ? "工作目录已删除" : file.untracked ? "未跟踪" : "已修改"}{file.staged ? " · 包含暂存修改" : ""}</p>)}
            {snapshot.summary.excluded.map(file => <p className="collab-muted collab-small" key={`${file.path}:${file.reason}`}>{file.path} · {reasons[file.reason] ?? file.reason}</p>)}
          </div>
          <p className="collab-muted collab-small">上方各显示最多 200 项。排除规则无法识别所有秘密，请检查完整清单。</p>
          <a className="collab-text-button" href={`/api/collab/snapshots/${snapshot.id}`} download={`snapshot-${snapshot.id}.json`}>下载完整快照清单</a>
        </details>
        <EnvironmentHandoff runId={snapshot.run_id} onRestore={onRestore ? () => onRestore(snapshot) : undefined}/>
        <details><summary>未捕获的内容与验证限制</summary><ul>{snapshot.summary.omissions.map(item => <li key={item} className="collab-muted collab-small">{item}</li>)}</ul></details>
      </>}
    </article>)}
  </section>;
}
