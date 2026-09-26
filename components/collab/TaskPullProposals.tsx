"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { pullProposalRequest, pullProposalCancel, type PullProposalContext } from "@/lib/collab/git/pull-proposal-schema";
import { collabApi, CollabApiError } from "./api";
import { TaskPullDelivery } from "./TaskPullDelivery";

const pendingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("prepare"), body: pullProposalRequest }).strict(),
  z.object({ kind: z.literal("cancel"), id: z.uuid(), body: pullProposalCancel }).strict(),
]);
type Pending = z.infer<typeof pendingSchema>;
const statuses = { queued: "等待读取 PR 目标", running: "正在读取 PR 目标", ready: "已保存只读 PR 提案", existing: "发现已有 PR，仅供查看", failed: "PR 提案准备失败", cancelled: "PR 提案已取消" };
export function TaskPullProposals({ deliveryId, userId }: { deliveryId: string; userId: string }) {
  const [context, setContext] = useState<PullProposalContext | null>(null), [pending, setPending] = useState<Pending | null>(null);
  const [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [title, setTitle] = useState(""), [body, setBody] = useState(""), [reason, setReason] = useState("");
  const alive = useRef(true), writing = useRef(false), sequence = useRef(0), key = `pi-collab:pull-proposal:${userId}:${deliveryId}`;
  const refresh = useCallback(async () => {
    const current = ++sequence.current;
    try {
      const result = await collabApi<PullProposalContext>(`push-deliveries/${deliveryId}/pull-proposals`);
      if (alive.current && current === sequence.current) setContext(result);
    } catch (e) {
      if (alive.current && current === sequence.current) {
        setContext(null); setError(e instanceof Error ? e.message : "无法读取 PR 提案");
      }
    }
  }, [deliveryId]);
  useEffect(() => {
    alive.current = true;
    try { const saved = sessionStorage.getItem(key); setPending(saved ? pendingSchema.parse(JSON.parse(saved)) : null); }
    catch { setError("无法恢复原提案请求，请先核对已有记录。"); }
    setLoaded(true); void refresh();
    const visible = () => { if (!document.hidden) void refresh(); }, timer = setInterval(visible, 3000);
    window.addEventListener("online", visible); document.addEventListener("visibilitychange", visible);
    return () => { alive.current = false; clearInterval(timer); window.removeEventListener("online", visible); document.removeEventListener("visibilitychange", visible); };
  }, [key, refresh]);
  async function submit(value: Pending) {
    if (writing.current || !loaded || !(pending || value.kind === "cancel" ? context?.canCancel : context?.canRequest)) return;
    const parsed = pendingSchema.safeParse(pending ?? value);
    if (!parsed.success) { setError("请核对标题、说明长度和取消原因。"); return; }
    const fixed = parsed.data;
    try { sessionStorage.setItem(key, JSON.stringify(fixed)); }
    catch { setError("无法保留原请求编号，尚未提交。请允许本窗口会话存储。"); return; }
    writing.current = true; setBusy(true); setPending(fixed); setError("");
    try {
      await collabApi(fixed.kind === "prepare" ? `push-deliveries/${deliveryId}/pull-proposals` : `pull-proposals/${fixed.id}/cancel`, fixed.body);
      sessionStorage.removeItem(key); if (alive.current) { setPending(null); setReason(""); }
    } catch (e) {
      if (e instanceof CollabApiError && e.status < 500) { sessionStorage.removeItem(key); if (alive.current) setPending(null); }
      if (alive.current) setError(e instanceof Error ? e.message : "响应未知，请重试原请求");
    } finally { writing.current = false; setBusy(false); if (alive.current) await refresh(); }
  }
  const active = context?.proposals.some(item => ["queued", "running"].includes(item.status));
  return <details className="collab-form compact" aria-label="草稿 PR 提案"><summary>准备草稿 PR 提案</summary>
    <p className="collab-small">读取此已确认推送的任务分支和 GitHub 当前目标，保存完整标题与说明。此步骤不会创建 PR 或通知仓库成员。</p>
    {error && <p role="alert" className="collab-error">{error}</p>}
    <button className="collab-button secondary" onClick={() => void refresh()}>刷新 PR 提案</button>
    {pending && <><p>原操作响应尚未确认，已保存相同请求编号与内容。</p><button className="collab-button" disabled={busy || !context?.canCancel} onClick={() => void submit(pending)}>重试同一 PR 提案操作</button></>}
    {context?.canRequest && !pending && <form className="collab-form compact" onSubmit={e => {
      e.preventDefault(); void submit({ kind: "prepare", body: { idempotencyKey: crypto.randomUUID(), expectedTaskVersion: context.taskVersion, title, body } });
    }}>
      <label>PR 标题<input aria-label="PR 提案标题" required maxLength={256} value={title} disabled={busy || active} onChange={e => setTitle(e.target.value)}/></label>
      <label>PR 说明<textarea aria-label="PR 提案说明" required maxLength={48000} value={body} disabled={busy || active} onChange={e => setBody(e.target.value)}/></label>
      <button className="collab-button" disabled={!loaded || busy || active}>读取目标并保存 PR 提案</button>
    </form>}
    {context?.proposals.map(item => <article key={item.jobId} className="collab-form compact" data-pull-proposal={item.jobId}>
      <p role="status">{statuses[item.status]}</p><strong>{item.title}</strong>
      <p className="collab-small collab-git-identity">仓库 {item.source.binding.ownerLogin}/{item.source.binding.name} · {({ public: "公开", private: "私有", internal: "组织内部" })[item.source.binding.visibility]}<br/>请求成员 {item.actorName}<br/>已推送提交 {item.source.headSha}</p>
      {item.failure && <p className="collab-small">处理记录：{item.failure}</p>}
      {item.observation && <>
        <p className="collab-small collab-git-identity">目标 {item.observation.target.baseRef} · {item.observation.target.baseSha}<br/>观察时间 {new Date(item.observation.target.verifiedAt).toLocaleString()}</p>
        {item.observation.existing.map(pr => <a key={pr.id} href={pr.url} target="_blank" rel="noreferrer">查看已有 PR #{pr.number}</a>)}
      </>}
      {item.attempt && <>
        <p>保存时的目标可能随后变化。下方创建流程需要另行明确确认并重新核验；此提案不代表 CI、评审或合并通过。</p>
        {!item.valid && item.status === "ready" && <p>原提案权限或关联已失效，请重新准备。</p>}
        <details><summary>完整生成的 PR 标题与说明</summary><strong>{item.attempt.request.title}</strong><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{item.attempt.request.body}</pre></details>
        <details><summary>精确请求与观察证据</summary><p className="collab-small collab-git-identity">提案 {item.jobId}<br/>成员 {item.actorId}<br/>请求 SHA-256 {item.attempt.requestHash} · {item.attempt.requestBytes} 字节<br/>观察 SHA-256 {item.observationHash}</p><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{item.requestText}</pre></details>
      </>}
      {context.canCancel && !pending && ["queued", "running"].includes(item.status) && !item.stopRequested && <form className="collab-form compact" onSubmit={e => {
        e.preventDefault(); void submit({ kind: "cancel", id: item.jobId, body: { idempotencyKey: crypto.randomUUID(), reason } });
      }}>
        <label>取消原因<textarea aria-label="PR 提案取消原因" required minLength={10} maxLength={2000} value={reason} onChange={e => setReason(e.target.value)}/></label>
        <button className="collab-button secondary" disabled={busy}>取消 PR 提案准备</button>
      </form>}
      {item.stopRequested && <p>已请求停止此提案的只读准备。</p>}
      {item.status === "ready" && <TaskPullDelivery key={item.jobId + ":" + userId} proposal={item} userId={userId}/>}
    </article>)}
  </details>;
}
