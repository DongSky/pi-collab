"use client";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { PushConfirmationRecord } from "@/lib/collab/git/push-confirmation-schema";
import { pushDeliveryAction, pushDeliveryRequest } from "@/lib/collab/git/push-delivery-schema";
import { collabApi, CollabApiError } from "./api";
import { TaskPullProposals } from "./TaskPullProposals";
const pendingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("send"), body: pushDeliveryRequest }).strict(),
  z.object({ kind: z.literal("action"), id: z.uuid(), body: pushDeliveryAction }).strict(),
]);
type Pending = z.infer<typeof pendingSchema>;
const statuses = { queued: "等待发送", running: "发送处理中", acknowledged: "远端已确认接收", rejected: "远端明确拒绝", not_sent: "确认未发送", unknown: "发送结果未知，目标保持占用", retired: "未知任务已封存，旧目标永久隔离" };
export function TaskPushDelivery({ confirmation, userId, canControl, refresh }: { confirmation: PushConfirmationRecord; userId: string; canControl: boolean; refresh: () => Promise<void> }) {
  const [pending, setPending] = useState<Pending | null>(null), [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false), [error, setError] = useState("");
  const [acknowledge, setAcknowledge] = useState(false), [reason, setReason] = useState("");
  const writing = useRef(false), alive = useRef(true), key = `pi-collab:push-delivery:${userId}:${confirmation.id}`, delivery = confirmation.delivery;
  useEffect(() => {
    alive.current = true;
    try { const saved = sessionStorage.getItem(key); setPending(saved ? pendingSchema.parse(JSON.parse(saved)) : null); }
    catch { setError("无法恢复原发送操作，请核对已有任务。"); }
    setLoaded(true); return () => { alive.current = false; };
  }, [key]);
  async function submit(value: Pending) {
    if (writing.current || !loaded || !canControl) return;
    const fixed = pending ?? pendingSchema.parse(value);
    try { sessionStorage.setItem(key, JSON.stringify(fixed)); }
    catch { setError("无法保留请求编号，尚未发送。请允许本窗口会话存储。"); return; }
    writing.current = true; setBusy(true); setPending(fixed); setError("");
    try {
      await collabApi(fixed.kind === "send" ? `push-confirmations/${confirmation.id}/send` : `push-deliveries/${fixed.id}/actions`, fixed.body);
      sessionStorage.removeItem(key); if (alive.current) { setPending(null); setAcknowledge(false); setReason(""); }
    } catch (e) {
      if (e instanceof CollabApiError && e.status < 500) { sessionStorage.removeItem(key); if (alive.current) setPending(null); }
      if (alive.current) setError(e instanceof Error ? e.message : "操作响应未知，请重试原编号");
    } finally { writing.current = false; setBusy(false); if (alive.current) await refresh(); }
  }
  return <section aria-label="固定导出发送" className="collab-form compact">
    {error && <p role="alert" className="collab-error">{error}</p>}
    {pending && <><p>操作响应尚未确认，已保存原请求编号及内容。</p><button className="collab-button" disabled={busy || !canControl} onClick={() => void submit(pending)}>重试同一发送操作</button></>}
    {!delivery && confirmation.status === "reserved" && confirmation.valid && canControl && <>
      <p className="collab-small">发送上方已确认的完整历史到指定任务分支。发送可能在浏览器关闭后继续；同一导出只允许一个发送任务。</p>
      <label className="collab-checkbox"><input type="checkbox" checked={acknowledge} disabled={busy || !!pending} onChange={e => setAcknowledge(e.target.checked)}/>明确发送此已确认的固定导出</label>
      <button className="collab-button" disabled={!loaded || busy || !!pending || !acknowledge} onClick={() => void submit({ kind: "send", body: { idempotencyKey: crypto.randomUUID(), manifestHash: confirmation.manifestHash, acknowledgePush: true } })}>发送到已确认的任务分支</button>
    </>}
    {delivery && <>
      <p role="status">{statuses[delivery.status]}</p>
      <p className="collab-small collab-git-identity">任务 {delivery.jobId}<br/>请求成员 {delivery.actorId}<br/>{delivery.gateAt ? `发送授权已持久记录：${new Date(delivery.gateAt).toLocaleString()}` : "尚无发送授权记录"}<br/>{delivery.requestHash && `请求 SHA-256 ${delivery.requestHash}`}</p>
      {delivery.failure && <p className="collab-small">处理记录：{delivery.failure}</p>}
      <p className="collab-small">凭据清理：{({ unrecorded: "无持久结果", not_requested: "未申请", issuance_unconfirmed: "签发结果未确认", revoked: "已撤销", revocation_unconfirmed: "撤销未确认" })[delivery.credential.status]}{delivery.credential.expiresAt && `；到期时间 ${new Date(delivery.credential.expiresAt).toLocaleString()}`}</p>
      {delivery.stopRequested && <p>已记录停止请求。发送授权记录后，停止不能保证撤销远端效果。</p>}
      {delivery.status === "acknowledged" && <TaskPullProposals key={`${delivery.jobId}:${userId}`} deliveryId={delivery.jobId} userId={userId}/>}
      {["unknown", "retired"].includes(delivery.status) && <p>远端请求仍可能迟到生效；查看当前提交或令牌失效均不能证明未发送。不能重发、释放或继续使用旧目标。封存后请从新工作区及新任务分支继续。</p>}
      {canControl && !pending && ((["queued", "running"].includes(delivery.status) && !delivery.stopRequested) || delivery.canRetire) && <form className="collab-form compact" onSubmit={e => {
        e.preventDefault(); void submit({ kind: "action", id: delivery.jobId, body: delivery.canRetire
          ? { idempotencyKey: crypto.randomUUID(), action: "retire", reason, acknowledgeUnknown: true }
          : { idempotencyKey: crypto.randomUUID(), action: "cancel", reason, acknowledgeUnknown: false } });
      }}>
        <label>处理原因<textarea aria-label="发送任务处理原因" minLength={delivery.canRetire ? 20 : 10} maxLength={2000} required value={reason} disabled={busy} onChange={e => setReason(e.target.value)}/></label>
        {delivery.canRetire && <label className="collab-checkbox"><input type="checkbox" required checked={acknowledge} onChange={e => setAcknowledge(e.target.checked)}/>确认远端结果仍未知，永久隔离旧分支，并从新工作区继续</label>}
        <button className="collab-button" disabled={busy || (delivery.canRetire && !acknowledge)}>{delivery.canRetire ? "封存未知任务并永久隔离旧目标" : "请求停止发送"}</button>
      </form>}
    </>}
  </section>;
}
