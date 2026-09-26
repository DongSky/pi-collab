"use client";
import { PullRemoteEvents } from "./PullRemoteEvents";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { pullObservationRequest, pullObservationCancel, type PullObservationContext } from "@/lib/collab/git/pull-observation-schema";
import type { TaskPullSnapshot } from "@/lib/collab/git/github-task-pull";
import { PullRevisions } from "./PullRevisions";
import { collabApi, CollabApiError } from "./api";
const pendingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("read"), body: pullObservationRequest }).strict(),
  z.object({ kind: z.literal("cancel"), jobId: z.uuid(), body: pullObservationCancel }).strict(),
]);
type Pending = z.infer<typeof pendingSchema>;
const statuses = { queued: "等待远端 PR 读取", running: "正在读取远端 PR", observed: "已保存远端 PR 观察", failed: "远端 PR 读取失败，历史记录保留", cancelled: "远端 PR 读取已取消" };
function Snapshot({ value }: { value: TaskPullSnapshot }) {
  return <div className="collab-form compact">
    <strong>{value.merged ? "观察到已合并" : value.state === "closed" ? "观察到已关闭" : value.draft ? "观察到开放的草稿 PR" : "观察到开放的 PR"}</strong>
    <p className="collab-small collab-git-identity">观察时间 {new Date(value.observedAt).toLocaleString()}<br/>来源 {value.headRef} · {value.headSha}<br/>目标 {value.baseRef} · {value.baseSha}</p>
    <details><summary>内容与状态摘要</summary><p className="collab-small collab-git-identity">标题 SHA-256 {value.titleHash}<br/>说明 SHA-256 {value.bodyHash}<br/>GitHub 更新时间 {new Date(value.updatedAt).toLocaleString()}<br/>允许维护者修改：{value.maintainerCanModify ? "是" : "否"}<br/>GitHub 返回的合并 SHA {value.mergeCommitSha ?? "无"}</p>
      <p className="collab-small">合并 SHA 可能是 GitHub 的临时测试合并；此观察不证明 CI、评审或受保护合并已通过，也不推进本机基线。</p>
    </details>
  </div>;
}
export function PullObservations({ changeId, userId }: { changeId: string; userId: string }) {
  const [context, setContext] = useState<PullObservationContext | null>(null), [pending, setPending] = useState<Pending | null>(null);
  const [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [reason, setReason] = useState("");
  const alive = useRef(true), writing = useRef(false), sequence = useRef(0), key = "pi-collab:pull-observation:" + userId + ":" + changeId;
  const route = "pull-changes/" + changeId + "/observations";
  const refresh = useCallback(async () => {
    const current = ++sequence.current;
    try { const value = await collabApi<PullObservationContext>(route); if (alive.current && current === sequence.current) setContext(value); }
    catch (e) { if (alive.current && current === sequence.current) { setContext(null); setError(e instanceof Error ? e.message : "无法读取 PR 观察记录"); } }
  }, [route]);
  useEffect(() => {
    alive.current = true;
    try { const saved = sessionStorage.getItem(key); setPending(saved ? pendingSchema.parse(JSON.parse(saved)) : null); }
    catch { setError("无法恢复原读取编号，请核对已有记录。"); }
    setLoaded(true); void refresh();
    const visible = () => { if (!document.hidden) void refresh(); }, timer = setInterval(visible, 3000);
    window.addEventListener("online", visible); document.addEventListener("visibilitychange", visible);
    return () => { alive.current = false; clearInterval(timer); window.removeEventListener("online", visible); document.removeEventListener("visibilitychange", visible); };
  }, [key, refresh]);
  async function submit(value: Pending) {
    if (writing.current || !loaded || !context?.canCancel) return;
    const parsed = pendingSchema.safeParse(pending ?? value);
    if (!parsed.success) { setError("请核对读取版本或取消原因。"); return; }
    const fixed = parsed.data;
    try { sessionStorage.setItem(key, JSON.stringify(fixed)); }
    catch { setError("无法保留原请求编号，尚未提交。请允许本窗口会话存储。"); return; }
    writing.current = true; setBusy(true); setPending(fixed); setError("");
    try {
      await collabApi(fixed.kind === "read" ? route : "pull-observations/" + fixed.jobId + "/cancel", fixed.body);
      sessionStorage.removeItem(key); if (alive.current) { setPending(null); setReason(""); }
    } catch (e) {
      if (e instanceof CollabApiError && e.status < 500) { sessionStorage.removeItem(key); if (alive.current) setPending(null); }
      if (alive.current) setError(e instanceof Error ? e.message : "响应未知，请重试原读取请求");
    } finally { writing.current = false; setBusy(false); if (alive.current) await refresh(); }
  }
  const active = context?.jobs.some(j => ["queued", "running"].includes(j.status)), latest = context?.latest;
  return <details className="collab-form compact" aria-label="远端 PR 状态观察"><summary>远端 PR 状态与版本观察</summary>
    <PullRemoteEvents changeId={changeId}/>
    <p className="collab-small">手动读取同一 PR 的版本和开关状态，并保存共享记录。打开页面只刷新已有记录；不会自动访问 GitHub。观察不是实时状态；固定代码可在下方下载，CI 仍需另外验证。</p>
    {error && <p role="alert" className="collab-error">{error}</p>}
    <button className="collab-button secondary" onClick={() => void refresh()}>刷新已有 PR 观察记录</button>
    {pending && <><p>原读取操作响应未确认，已保留相同编号及版本。</p><button className="collab-button" disabled={busy || !context?.canCancel} onClick={() => void submit(pending)}>重试同一 PR 读取操作</button></>}
    {context?.canRequest && !pending && <button className="collab-button" disabled={!loaded || busy || active} onClick={() => void submit({ kind: "read", body: {
      idempotencyKey: crypto.randomUUID(), expectedTaskVersion: context.taskVersion, expectedObservationVersion: context.observationVersion,
    } })}>读取 GitHub PR 状态</button>}
    {context && <section aria-label="最近成功的 PR 观察" className="collab-form compact">
      <p>最近成功观察 · {latest ? "记录版本 " + context.observationVersion : "创建时记录"}</p>
      <Snapshot value={latest?.observation?.snapshot ?? context.initial}/>
      {context.jobs[0]?.status === "failed" && <p>最近一次读取失败，保留的成功观察可能已过期；失败不代表 PR 被删除或关闭。</p>}
    </section>}
    <p className="collab-small">最近 20 项读取任务；成功观察按版本追加，失败或取消不会覆盖历史。</p>
    <PullRevisions key={changeId} changeId={changeId} userId={userId}/>
    {context?.jobs.map(job => <article key={job.jobId} className="collab-form compact" data-pull-observation={job.jobId}>
      <p role="status">{statuses[job.status]}</p>
      <p className="collab-small collab-git-identity">请求成员 {job.actorName}<br/>读取编号 {job.jobId}{job.observationVersion && <><br/>记录版本 {job.observationVersion}</>}</p>
      {job.failure && <details><summary>读取诊断</summary><p className="collab-small">{job.failure}</p></details>}
      {job.observation && <details><summary>固定观察与证据</summary><Snapshot value={job.observation.snapshot}/>
        <p className="collab-small collab-git-identity">证据 SHA-256 {job.observationHash}<br/>只读令牌已撤销</p>
      </details>}
      {job.stopRequested && <p>已记录取消请求。</p>}
      {context.canCancel && !pending && ["queued", "running"].includes(job.status) && !job.stopRequested && <form className="collab-form compact" onSubmit={e => {
        e.preventDefault(); void submit({ kind: "cancel", jobId: job.jobId, body: { idempotencyKey: crypto.randomUUID(), reason } });
      }}>
        <label>PR 读取取消原因<textarea aria-label="PR 读取取消原因" required minLength={10} maxLength={2000} value={reason} onChange={e => setReason(e.target.value)}/></label>
        <button className="collab-button secondary" disabled={busy}>取消此次 PR 读取</button>
      </form>}
    </article>)}
  </details>;
}
