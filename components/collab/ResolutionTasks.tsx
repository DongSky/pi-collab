"use client";
import { useRef, useState, type FormEvent } from "react";
import type { ResolutionInput } from "@/lib/collab/resolution-schema";
import { collabApi, CollabApiError } from "./api";
export type ResolutionInfo = { task_id: string; integration_id: string; input: ResolutionInput; input_state: string };
export type ResolutionMember = { user_id: string; name: string; role: string };
export function ResolutionCreator({ integrationId, userId, role, members, existing, enabled, onOpen }: {
  integrationId: string; userId: string; role: string; members: ResolutionMember[]; existing: { id: string; title: string } | null; enabled: boolean; onOpen: (taskId: string) => Promise<void>;
}) {
  const [ownerId, setOwnerId] = useState(userId), [title, setTitle] = useState("修复整合冲突"), [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false), [retry, setRetry] = useState(false), [error, setError] = useState(""), [created, setCreated] = useState<{ id: string; title: string } | null>(null);
  const pending = useRef<{ ownerId: string; title: string; reason: string; idempotencyKey: string } | null>(null);
  const saved = existing ?? created;
  async function open(id: string) { try { await onOpen(id); } catch (e) { setError(e instanceof Error ? e.message : "打开修复任务失败"); } }
  async function submit(event?: FormEvent) {
    event?.preventDefault(); if (busy) return;
    pending.current ??= { ownerId, title, reason, idempotencyKey: crypto.randomUUID() }; setBusy(true); setError("");
    try {
      const result = await collabApi<{ taskId: string }>(`integrations/${integrationId}/resolution`, pending.current);
      setCreated({ id: result.taskId, title: pending.current.title }); pending.current = null; setRetry(false);
    } catch (e) {
      if (e instanceof CollabApiError && e.status < 500) pending.current = null;
      setRetry(!!pending.current); setError(e instanceof Error ? e.message : "创建修复任务失败");
    } finally { setBusy(false); }
  }
  return <div className="collab-resolution-create">
    {error && <p className="collab-error" role="alert">{error}</p>}
    {saved ? <p><button className="collab-text-button" onClick={() => void open(saved.id)}>打开修复任务：{saved.title}</button></p>
      : enabled && ["maintainer", "developer"].includes(role) ? <details><summary>创建冲突修复任务</summary>
        <p className="collab-muted collab-small">新负责人在独立工作区修复完整组合。来源、目标和必跑规则固定；原工作区保留。修复后须重新验证、发布并取得独立评审。</p>
        {retry && <button className="collab-button" disabled={busy} onClick={() => void submit()}>重试同一修复请求</button>}
        <form className="collab-form compact" onSubmit={submit}>
          <label>修复任务名称<input aria-label="修复任务名称" required maxLength={200} value={title} disabled={busy || retry} onChange={e => setTitle(e.target.value)} /></label>
          <label>修复负责人<select aria-label="修复负责人" value={ownerId} disabled={busy || retry || role !== "maintainer"} onChange={e => setOwnerId(e.target.value)}>{members.filter(member => ["developer", "maintainer"].includes(member.role) && (role === "maintainer" || member.user_id === userId)).map(member => <option key={member.user_id} value={member.user_id}>{member.name}</option>)}</select></label>
          <label>修复目标<textarea aria-label="修复目标" required minLength={10} maxLength={2000} rows={3} value={reason} disabled={busy || retry} onChange={e => setReason(e.target.value)} /></label>
          <button className="collab-button" disabled={busy || retry}>确认创建修复任务</button>
        </form>
      </details> : !saved && !enabled ? <p className="collab-muted collab-small">修复任务需要当前有效的冲突和必跑规则。请先更新规则或重新整合。</p> : null}
  </div>;
}
export function ResolutionContext({ resolution, tasks }: { resolution: ResolutionInfo | null; tasks: { id: string; title: string }[] }) {
  if (!resolution) return null;
  return <section className="collab-snapshots" aria-label="固定冲突修复来源">
    <h2>固定冲突修复来源</h2>
    <p className="collab-muted">修复成果替代下列完整组合。发布新成果时需确认所有冲突选择，之后重新组合并由独立成员评审。</p>
    <p className="collab-small">原整合 {resolution.integration_id.slice(0, 12)} · {resolution.input.targetBranch} · 基线 {resolution.input.targetSha.slice(0, 12)}</p>
    <strong role="status">{resolution.input_state === "current" ? "修复来源当前有效" : "修复来源已失效，请从新整合创建修复任务"}</strong>
    <ol>{resolution.input.sources.map(source => <li key={source.resultId}>{tasks.find(t => t.id === source.taskId)?.title ?? source.taskId.slice(0, 8)} · 成果 {source.resultId.slice(0, 8)} · {source.worktreeCommit.slice(0, 12)}</li>)}</ol>
    <p className="collab-muted collab-small">原始冲突：{resolution.input.conflict.files.map(file => file.path).join("、")}。后续输入仍会组合；请一并核对运行中的冲突说明和新快照，包含二进制、重命名及删除选择。</p>
    <a className="collab-text-button" href={`/api/collab/tasks/${resolution.task_id}/resolution`} download>查看固定修复来源</a>
  </section>;
}
