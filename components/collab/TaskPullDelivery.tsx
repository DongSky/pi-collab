"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { PullProposalRecord } from "@/lib/collab/git/pull-proposal-schema";
import { pullDeliveryRequest, pullDeliveryAction, type PullDeliveryContext } from "@/lib/collab/git/pull-delivery-schema";
import { collabApi, CollabApiError } from "./api";
import { PullObservations } from "./PullObservations";
const pendingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create"), body: pullDeliveryRequest }).strict(),
  z.object({ kind: z.literal("action"), body: pullDeliveryAction }).strict(),
]);
type Pending = z.infer<typeof pendingSchema>;
const statuses = { queued: "等待创建草稿 PR", running: "正在创建草稿 PR", created: "远端已确认创建草稿 PR", rejected: "远端明确拒绝创建",
  not_created: "确认未创建 PR", unknown: "PR 创建结果未知，分支保持占用", retired: "未知 PR 创建已封存，旧分支永久隔离" };
export function TaskPullDelivery({ proposal, userId }: { proposal: PullProposalRecord; userId: string }) {
  const [context, setContext] = useState<PullDeliveryContext | null>(null), [pending, setPending] = useState<Pending | null>(null);
  const [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [content, setContent] = useState(false), [notification, setNotification] = useState(false), [versions, setVersions] = useState(false);
  const [reason, setReason] = useState(""), [retire, setRetire] = useState(false);
  const alive = useRef(true), writing = useRef(false), sequence = useRef(0);
  const key = "pi-collab:pull-creation:" + userId + ":" + proposal.jobId;
  const refresh = useCallback(async () => {
    const current = ++sequence.current;
    try {
      const result = await collabApi<PullDeliveryContext>("pull-proposals/" + proposal.jobId + "/create");
      if (alive.current && current === sequence.current) setContext(result);
    } catch (e) {
      if (alive.current && current === sequence.current) { setContext(null); setError(e instanceof Error ? e.message : "无法读取 PR 创建状态"); }
    }
  }, [proposal.jobId]);
  useEffect(() => {
    alive.current = true;
    try { const saved = sessionStorage.getItem(key); setPending(saved ? pendingSchema.parse(JSON.parse(saved)) : null); }
    catch { setError("无法恢复原创建请求，请先核对已有记录。"); }
    setLoaded(true); void refresh();
    const visible = () => { if (!document.hidden) void refresh(); }, timer = setInterval(visible, 3000);
    window.addEventListener("online", visible); document.addEventListener("visibilitychange", visible);
    return () => { alive.current = false; clearInterval(timer); window.removeEventListener("online", visible); document.removeEventListener("visibilitychange", visible); };
  }, [key, refresh]);
  async function submit(value: Pending) {
    if (writing.current || !loaded || !context?.canControl) return;
    const parsed = pendingSchema.safeParse(pending ?? value);
    if (!parsed.success) { setError("请确认完整内容、通知影响和版本，或填写处理原因。"); return; }
    const fixed = parsed.data;
    try { sessionStorage.setItem(key, JSON.stringify(fixed)); }
    catch { setError("无法保留请求编号，尚未提交。请允许本窗口会话存储。"); return; }
    writing.current = true; setBusy(true); setPending(fixed); setError("");
    try {
      await collabApi(fixed.kind === "create" ? "pull-proposals/" + proposal.jobId + "/create" : "pull-deliveries/" + proposal.jobId + "/actions", fixed.body);
      sessionStorage.removeItem(key);
      if (alive.current) { setPending(null); setContent(false); setNotification(false); setVersions(false); setRetire(false); setReason(""); }
    } catch (e) {
      if (e instanceof CollabApiError && e.status < 500) { sessionStorage.removeItem(key); if (alive.current) setPending(null); }
      if (alive.current) setError(e instanceof Error ? e.message : "响应未知，请重试原创建请求");
    } finally { writing.current = false; setBusy(false); if (alive.current) await refresh(); }
  }
  const delivery = context?.delivery, attempt = proposal.attempt;
  return <details className="collab-form compact" aria-label="创建草稿 PR"><summary>创建草稿 PR</summary>
    <p className="collab-small">此操作会将保存的标题和说明发送到 GitHub，创建草稿 PR，可能通知仓库成员。服务会重新核验版本；创建后仍须检查代码、CI 与评审。</p>
    {error && <p role="alert" className="collab-error">{error}</p>}
    <button className="collab-button secondary" onClick={() => void refresh()}>刷新 PR 创建状态</button>
    {pending && <><p>原操作响应尚未确认，已保存相同请求编号及内容。</p><button className="collab-button" disabled={busy || !context?.canControl} onClick={() => void submit(pending)}>重试同一 PR 创建操作</button></>}
    {context?.occupied && !delivery && <p>此任务分支已有推送或 PR 创建占用，处理原操作后才能继续。</p>}
    {context?.canCreate && !delivery && attempt && proposal.observationHash && !pending && <form className="collab-form compact" onSubmit={e => {
      e.preventDefault(); if (!content || !notification || !versions) return;
      void submit({ kind: "create", body: { idempotencyKey: crypto.randomUUID(), requestHash: attempt.requestHash, observationHash: proposal.observationHash!,
        acknowledgeContent: true, acknowledgeNotification: true, acknowledgeVersions: true } });
    }}>
      <p className="collab-small collab-git-identity">仓库 {proposal.source.binding.ownerLogin}/{proposal.source.binding.name}<br/>来源 {attempt.request.head} · {attempt.intent.headSha}<br/>目标 {attempt.request.base} · {attempt.intent.baseSha}</p>
      <strong>{attempt.request.title}</strong><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{attempt.request.body}</pre>
      <label className="collab-checkbox"><input type="checkbox" required checked={content} disabled={busy} onChange={e => setContent(e.target.checked)}/>我已核对完整 PR 标题、说明及目标仓库</label>
      <label className="collab-checkbox"><input type="checkbox" required checked={notification} disabled={busy} onChange={e => setNotification(e.target.checked)}/>明确创建草稿 PR，并允许 GitHub 通知仓库成员</label>
      <label className="collab-checkbox"><input type="checkbox" required checked={versions} disabled={busy} onChange={e => setVersions(e.target.checked)}/>了解创建期间分支可能变化，仍需后续检查与评审</label>
      <button className="collab-button" disabled={!loaded || busy || context.occupied || !content || !notification || !versions}>确认发送并创建草稿 PR</button>
    </form>}
    {delivery && <section className="collab-form compact" data-pull-delivery={delivery.jobId}>
      <p role="status">{statuses[delivery.status]}</p>
      <p className="collab-small collab-git-identity">请求成员 {delivery.actorName}<br/>创建请求 {delivery.jobId}<br/>请求 SHA-256 {delivery.requestHash}</p>
      <p className="collab-small">凭据清理：{({ unrecorded: "无持久结果", not_requested: "未申请", issuance_unconfirmed: "签发结果未确认", revoked: "已撤销", revocation_unconfirmed: "撤销未确认" })[delivery.credential.status]}</p>
      {delivery.failure && <details><summary>处理诊断</summary><p className="collab-small">{delivery.failure}</p></details>}
      {delivery.outcome?.status === "created" && <p>{({ matching: "创建后观察到的版本与提案一致；这不是实时状态或合并许可。", changed: "PR 已创建，但观察到版本或内容变化。请重新核对，旧检查不能自动沿用。", unavailable: "PR 已创建，尚未确认创建后的版本。请先核对远端状态。" })[delivery.outcome.revision]}</p>}
      {delivery.changeRequest && <>
        <a href={delivery.changeRequest.url} target="_blank" rel="noreferrer">打开已创建 PR #{delivery.changeRequest.number}</a>
        <details><summary>创建与版本观察记录</summary>
          {delivery.changeRequest.observations.map(item => <div key={item.sequence}>
            <p className="collab-small collab-git-identity">{item.kind === "creation" ? "创建回执" : "创建后读取"} · {new Date(item.evidence.observedAt).toLocaleString()}<br/>来源 {item.sourceSha}<br/>目标 {item.targetSha}<br/>证据 SHA-256 {item.evidenceHash}</p>
          </div>)}
          <p className="collab-small">这些是创建时的固定观察记录；后续变化可在下方读取，完整差异、可信 CI 和远端评审仍需另外验证。</p>
        </details>
        <PullObservations key={delivery.changeRequest.id + ":" + userId} changeId={delivery.changeRequest.id} userId={userId}/>
      </>}
      {delivery.outcome?.status === "not_created" && delivery.outcome.existing?.map(pr => <a key={pr.id} href={pr.url} target="_blank" rel="noreferrer">查看已有 PR #{pr.number}（未接管）</a>)}
      {["unknown", "retired"].includes(delivery.status) && <p>创建请求仍可能迟到生效。当前找不到 PR、正文标记或令牌失效均不能证明请求已终止；旧分支继续隔离，不能重发。请从新工作区及新任务分支继续。</p>}
      {delivery.stopRequested && <p>停止请求已记录；发送授权后不能保证撤销远端创建。</p>}
      {context?.canControl && !pending && ((["queued", "running"].includes(delivery.status) && !delivery.stopRequested) || delivery.canRetire) && <form className="collab-form compact" onSubmit={e => {
        e.preventDefault(); void submit({ kind: "action", body: delivery.canRetire
          ? { idempotencyKey: crypto.randomUUID(), action: "retire", reason, acknowledgeUnknown: true }
          : { idempotencyKey: crypto.randomUUID(), action: "cancel", reason, acknowledgeUnknown: false } });
      }}>
        <label>PR 创建处理原因<textarea aria-label="PR 创建处理原因" required minLength={delivery.canRetire ? 20 : 10} maxLength={2000} value={reason} disabled={busy} onChange={e => setReason(e.target.value)}/></label>
        {delivery.canRetire && <label className="collab-checkbox"><input type="checkbox" required checked={retire} onChange={e => setRetire(e.target.checked)}/>确认结果仍未知，永久隔离此 PR 任务分支</label>}
        <button className="collab-button secondary" disabled={busy || (delivery.canRetire && !retire)}>{delivery.canRetire ? "封存未知 PR 创建并隔离分支" : "请求停止 PR 创建"}</button>
      </form>}
    </section>}
  </details>;
}
