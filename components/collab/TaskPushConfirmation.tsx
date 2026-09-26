"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { pushConfirmationRequest, pushConfirmationWithdrawal, type PushConfirmationContext } from "@/lib/collab/git/push-confirmation-schema";
import { collabApi, CollabApiError } from "./api";
import { TaskPushDelivery } from "./TaskPushDelivery";
const pendingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("confirm"), body: pushConfirmationRequest }).strict(),
  z.object({ kind: z.literal("withdraw"), id: z.uuid(), body: pushConfirmationWithdrawal }).strict(),
]);
type Pending = z.infer<typeof pendingSchema>;
export function TaskPushConfirmation({ previewId, userId, manifestHash, complete }: { previewId: string; userId: string; manifestHash: string; complete: boolean }) {
  const [context, setContext] = useState<PushConfirmationContext | null>(null), [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false), [error, setError] = useState("");
  const [destination, setDestination] = useState(false), [disclosure, setDisclosure] = useState(false), [reasons, setReasons] = useState<Record<string, string>>({});
  const alive = useRef(true), generation = useRef(0), writing = useRef(false), key = `pi-collab:push-confirmation:${userId}:${previewId}`;
  const retire = useCallback(() => { generation.current++; }, []);
  const refresh = useCallback(async () => {
    const ticket = ++generation.current;
    try { const value = await collabApi<PushConfirmationContext>(`push-previews/${previewId}/confirmations`); if (alive.current && ticket === generation.current) setContext(value); }
    catch (e) { if (alive.current && ticket === generation.current) { setContext(null); setDestination(false); setDisclosure(false); setError(e instanceof Error ? e.message : "无法读取确认记录"); } }
  }, [previewId]);
  useEffect(() => {
    alive.current = true;
    try { const saved = sessionStorage.getItem(key); setPending(saved ? pendingSchema.parse(JSON.parse(saved)) : null); }
    catch { setError("无法恢复原确认请求，请核对已有记录。"); }
    setLoaded(true); void refresh(); const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 3000);
    return () => { alive.current = false; retire(); clearInterval(timer); };
  }, [key, refresh, retire]);
  async function submit(request: Pending) {
    if (writing.current || !loaded || !context?.canWithdraw) return;
    const fixed = pending ?? pendingSchema.parse(request);
    try { sessionStorage.setItem(key, JSON.stringify(fixed)); }
    catch { setError("无法保留原请求编号，尚未发送。请允许本窗口会话存储。"); return; }
    writing.current = true; setBusy(true); setPending(fixed); setError("");
    try {
      await collabApi(fixed.kind === "confirm" ? `push-previews/${previewId}/confirmations` : `push-confirmations/${fixed.id}/withdraw`, fixed.body);
      sessionStorage.removeItem(key); if (alive.current) { setPending(null); setDestination(false); setDisclosure(false); }
    } catch (e) {
      if (e instanceof CollabApiError && e.status < 500) { sessionStorage.removeItem(key); if (alive.current) setPending(null); }
      if (alive.current) setError(e instanceof Error ? e.message : "确认结果未知，请重试原请求");
    } finally { writing.current = false; setBusy(false); if (alive.current) await refresh(); }
  }
  const scope = context?.scope, eligible = context?.canConfirm && scope?.manifestHash === manifestHash;
  return <section aria-label="持久推送确认" className="collab-form compact">
    <h3>保存完整确认与目标占用</h3>
    <p className="collab-small collab-muted">确认固定导出中的全部提交、说明及文件版本。确认会占用此远端任务分支，其他成员不能重复占用；当前步骤不发送代码，后续发送需单独操作。</p>
    {error && <p role="alert" className="collab-error">{error}</p>}
    {pending && <><p>原确认操作响应尚未确认，已保存原编号与内容。</p><button className="collab-button" disabled={busy || !context?.canWithdraw} onClick={() => void submit(pending)}>重试同一推送确认操作</button></>}
    {scope && <p className="collab-small collab-git-identity">GitHub 仓库 {scope.destination.repository.ownerLogin}/{scope.destination.repository.name} · {scope.destination.repository.visibility} · ID {scope.destination.repository.githubRepositoryId}<br/>目标 {scope.destination.ref}<br/>旧 SHA {scope.destination.expectedOld ?? "尚不存在"}<br/>新 SHA {scope.destination.newSha}</p>}
    <p role="status">{complete ? "全部提交版本已在本窗口核对" : "请先逐项核对全部文件版本，并确认每个提交的说明与父关系"}</p>
    {eligible && <>
      <label className="collab-checkbox"><input type="checkbox" checked={destination} disabled={busy || !!pending} onChange={e => setDestination(e.target.checked)}/>确认上述仓库、可见性、任务分支及旧/新提交</label>
      <label className="collab-checkbox"><input type="checkbox" checked={disclosure} disabled={busy || !!pending} onChange={e => setDisclosure(e.target.checked)}/>确认披露完整新增历史（包括中间版本），已核对原始字节和排除限制；不包含后续草稿</label>
      <button className="collab-button" disabled={!loaded || busy || !!pending || !complete || !destination || !disclosure || context?.occupied} onClick={() => {
        if (scope) void submit({ kind: "confirm", body: { ...scope, idempotencyKey: crypto.randomUUID(), acknowledgeHistory: true, acknowledgeDestination: true, acknowledgeDisclosure: true } });
      }}>保存确认并占用目标</button>
    </>}
    {context?.occupied && <p className="collab-muted">此目标已有确认占用。旧确认不会因刷新、重复请求或权限恢复而重新授权。</p>}
    <h4>最近 50 项确认记录</h4>
    {context?.confirmations.map(item => <article className="collab-snapshot-card" key={item.id} aria-label={`推送确认 ${item.id}`}>
      <p role="status">{item.status === "withdrawn" ? "确认已撤回" : item.status === "consumed" ? "确认已用于原发送任务" : item.status === "quarantined" ? "旧目标永久隔离" : item.valid ? "确认已保存，目标已占用" : "确认已失效，目标仍占用"}</p>
      <p className="collab-small collab-git-identity">{item.id}<br/>确认成员 {item.actorId} · {new Date(item.createdAt).toLocaleString()} · {item.commitCount} 个提交<br/>导出 {item.manifestHash}</p>
      <TaskPushDelivery confirmation={item} userId={userId} canControl={context.canWithdraw} refresh={refresh}/>
      {item.status === "reserved" && !item.delivery && context.canWithdraw && <form className="collab-form compact" onSubmit={e => { e.preventDefault(); void submit({ kind: "withdraw", id: item.id, body: { idempotencyKey: crypto.randomUUID(), reason: reasons[item.id] ?? "" } }); }}>
        <label>撤回原因<textarea aria-label="推送确认撤回原因" required minLength={10} maxLength={2000} disabled={busy || !!pending} value={reasons[item.id] ?? ""} onChange={e => setReasons({ ...reasons, [item.id]: e.target.value })}/></label>
        <button className="collab-button" disabled={busy || !!pending}>撤回确认并释放目标</button>
      </form>}
    </article>)}
  </section>;
}
