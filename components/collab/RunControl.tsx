"use client";
import type { DiscussionInstructionSource } from "@/lib/collab/discussion-context-schema";
import { useEffect, useState, type FormEvent } from "react";
import { collabApi, CollabApiError } from "./api";
import { RunQuestions } from "./RunQuestions";

export type ControlState = { controllerId: string; controllerName: string; version: string; instructionsOpen: boolean; valid: boolean };
type Data = {
  run: { execution_kind: "ai" | "terminal"; id: string; status: string; requested_by: string; control: ControlState };
  requests: { id: string; requester_id: string; requester_name: string; control_version: string; status: string; note: string; response: string | null; handler_name: string | null; created_at: string }[];
  instructions: { id: string; author_id: string; author_name: string; control_version: string; kind: string; message: string; status: string; created_at: string; discussion: DiscussionInstructionSource|null }[];
};
const requestNames: Record<string, string> = { pending: "等待处理", accepted: "已同意交接", rejected: "已拒绝", withdrawn: "已撤回", expired: "已失效" };
const instructionNames: Record<string, string> = { queued: "等待投递", dispatching: "投递中", delivered: "运行已接收", rejected: "未被接收", unknown: "结果未知 · 不会重发", cancelled: "未发送 · 已取消" };

export function RunControl({ runId, userId, role, eventGeneration, onChange, onOpenDiscussion, compact=false }: { compact?:boolean; runId: string; userId: string; role: string; eventGeneration: number; onChange: () => Promise<void>; onOpenDiscussion?:(id:string)=>void }) {
  const [data, setData] = useState<Data | null>(null), [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [generation, setGeneration] = useState(0);
  const [pending, setPending] = useState<{ path: string; body: Record<string, unknown> } | null>(null);
  const [formKey, setFormKey] = useState(0);
  useEffect(() => {
    let disposed = false, loading = false;
    const controller = new AbortController();
    async function refresh() {
      if (loading || document.hidden) return;
      loading = true;
      try { const next = await collabApi<Data>(`runs/${runId}/control`, undefined, undefined, controller.signal); if (!disposed) setData(next); }
      catch (e) { if (!disposed) { setData(null); setError(e instanceof Error ? e.message : "控制权读取失败"); } }
      finally { loading = false; }
    }
    void refresh(); const timer = setInterval(() => void refresh(), 5000);
    const resume = () => void refresh(); document.addEventListener("visibilitychange", resume);
    return () => { disposed = true; controller.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", resume); };
  }, [runId, generation, eventGeneration]);
  async function send(path: string, body: Record<string, unknown>) {
    if (busy) return;
    const request = pending ?? { path, body: { ...body, idempotencyKey: crypto.randomUUID() } };
    setPending(request); setBusy(true); setError("");
    try {
      await collabApi(request.path, request.body);
      setPending(null); setFormKey(n => n + 1); setGeneration(n => n + 1); await onChange();
    } catch (e) {
      if (e instanceof CollabApiError && e.status < 500) { setPending(null); setGeneration(n => n + 1); }
      setError(e instanceof Error ? e.message : "结果未确认，请重试原请求。");
    } finally { setBusy(false); }
  }
  const control = data?.run.control;
  const isController = control?.controllerId === userId;
  const active = data && ["queued", "starting", "running", "waiting_input"].includes(data.run.status) && control?.instructionsOpen;
  const canRequest = active && !isController && ["developer", "maintainer"].includes(role);
  const canInstruct = data?.run.execution_kind!=="terminal" && isController && control?.valid && control.instructionsOpen && data && ["running", "waiting_input"].includes(data.run.status);
  function request(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!control) return;
    const fields = new FormData(event.currentTarget);
    void send(`runs/${runId}/control`, { expectedVersion: control.version, note: fields.get("note") });
  }
  function decide(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault(); if (!control) return;
    const fields = new FormData(event.currentTarget);
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement;
    void send(`control-requests/${id}`, { expectedVersion: control.version, action: submitter.value, note: fields.get("note") });
  }
  function instruct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!control) return;
    const fields = new FormData(event.currentTarget);
    void send(`runs/${runId}/instructions`, { expectedVersion: control.version, kind: fields.get("kind"), message: fields.get("message") });
  }
  return <section className="collab-run-control collab-snapshots" aria-label="会话控制与交接">
    {!compact&&<div className="collab-section-heading"><div><p className="collab-eyebrow">一个运行 · 一个当前控制者</p><h2>会话控制与交接</h2></div><button className="collab-text-button" onClick={() => setGeneration(n => n + 1)}>刷新控制权</button></div>}
    {error && <p className="collab-error" role="alert">{error}</p>}
    {pending && !busy && <div className="collab-member-notice"><p>上次操作结果尚未确认，请沿用原请求重试。</p><button className="collab-button" onClick={() => void send(pending.path, pending.body)}>重试原控制请求</button></div>}
    {data && control && <>
      <p className="collab-control-owner" role="status">当前控制者：<strong>{control.controllerName}</strong>{isController ? "（你）" : ""} · v{control.version}{!control.valid ? " · 权限已失效，运行将停止" : ""}</p>
      {!compact&&<p className="collab-muted collab-small">交接后由新控制者追加指令；原发起人与任务负责人不变。尚未投递的旧指令会取消，运行已接收的指令可能继续执行。维护者保留紧急停止权限。</p>}
      {!active && <p className="collab-muted">本次运行不再接受控制权交接或新指令。后续工作请通过任务的新运行继续。</p>}
      <div className="collab-control-forms" key={formKey}>
        {canRequest && !data.requests.some(r => r.requester_id === userId && r.status === "pending") && <form className="collab-form compact" onSubmit={request}>
          <label>接管申请说明<textarea aria-label="接管申请说明" name="note" minLength={10} maxLength={2000} required rows={2} disabled={busy || !!pending} placeholder="说明为什么接手，以及计划如何继续" /></label>
          <button className="collab-button" disabled={busy || !!pending}>申请控制权</button>
        </form>}
        {canInstruct && <form className="collab-form compact" onSubmit={instruct}>
          <label>指令方式<select aria-label="指令方式" name="kind" disabled={busy || !!pending}><option value="steer">调整当前方向</option><option value="follow_up">当前工作后继续</option></select></label>
          <label>给当前 AI 的指令<textarea aria-label="给当前 AI 的指令" name="message" maxLength={20000} required rows={3} disabled={busy || !!pending} /></label>
          <button className="collab-button primary" disabled={busy || !!pending}>发送运行指令</button>
        </form>}
      </div>
      {data.run.execution_kind === "ai" && <RunQuestions key={runId} runId={runId} userId={userId} onChange={onChange} />}
      {data.requests.length > 0 && <div className="collab-control-history"><h3>控制申请与交接记录</h3>{data.requests.map(q => <article key={q.id} className="collab-control-request">
        <p><strong>{q.requester_name}</strong> · {requestNames[q.status]} · {new Date(q.created_at).toLocaleString()}</p><p className="collab-prewrap">{q.note}</p>
        {q.response && <p className="collab-muted collab-prewrap">{q.handler_name}：{q.response}</p>}
        {q.status === "pending" && (isController || role === "maintainer" || q.requester_id === userId) && <form className="collab-form compact" onSubmit={event => decide(event, q.id)}>
          <label>处理说明<textarea aria-label={`处理 ${q.requester_name} 的申请说明`} name="note" minLength={10} maxLength={2000} required rows={2} disabled={busy || !!pending} /></label>
          <div className="collab-form-actions">{(isController || role === "maintainer") && <><button className="collab-button" name="action" value="accept" disabled={busy || !!pending}>同意交接</button><button className="collab-text-button" name="action" value="reject" disabled={busy || !!pending}>拒绝申请</button></>}{q.requester_id === userId && <button className="collab-text-button" name="action" value="withdraw" disabled={busy || !!pending}>撤回申请</button>}</div>
        </form>}
      </article>)}</div>}
      {data.instructions.length > 0 && <div className="collab-control-history"><h3>成员指令记录</h3><p className="collab-muted collab-small">“运行已接收”只表示进入运行输入队列，执行结果以运行输出为准。显示最近 50 条，历史仍保留。</p>{data.instructions.map(i => <article key={i.id} className="collab-control-instruction">
        {i.discussion&&<div className="collab-small collab-git-identity"><button className="collab-text-button" onClick={()=>onOpenDiscussion?.(i.discussion!.threadId)}>来自讨论：{i.discussion.title} · {i.discussion.messageIds.length} 条评论</button><br/>来源 hash {i.discussion.sourceHash}</div>}
        <p><strong>{i.author_name}</strong> · {data.run.execution_kind === "terminal" ? "终端输入" : i.kind === "steer" ? "调整方向" : "继续工作"} · {instructionNames[i.status]}</p><p className="collab-prewrap">{i.message}</p><small className="collab-muted">控制版本 {i.control_version} · {new Date(i.created_at).toLocaleString()}</small>
      </article>)}</div>}
    </>}
  </section>;
}
