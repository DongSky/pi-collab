"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { collabApi, CollabApiError } from "./api";
import type { SubtaskContext } from "@/lib/collab/subtask-schema";

type Operation = { path: string; body: Record<string, unknown> };
const statusNames: Record<string, string> = { proposed: "等待确认", accepted: "已启动", rejected: "已拒绝", queued: "排队中", starting: "准备中", running: "执行中", waiting_input: "等待输入", stopping: "停止中", reconciling: "待核验退出", completed: "运行结束", failed: "失败", cancelled: "已停止" };
export function Subtasks({ taskId, projectId, runId, canPropose, onOpenTask, onChange }: { taskId: string; projectId: string; runId?: string; canPropose: boolean; onOpenTask: (id: string) => Promise<void>; onChange: () => Promise<void> }) {
  const [data, setData] = useState<SubtaskContext | null>(null), [error, setError] = useState(""), [message, setMessage] = useState("");
  const [pending, setPending] = useState<Operation | null>(null), [busy, setBusy] = useState(false);
  const [title, setTitle] = useState(""), [description, setDescription] = useState(""), [acceptance, setAcceptance] = useState(""), [prompt, setPrompt] = useState("");
  const [reason, setReason] = useState(""), [acknowledge, setAcknowledge] = useState(false);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try { const next = await collabApi<SubtaskContext>(`tasks/${taskId}/subtasks`, undefined, undefined, signal); if (!signal?.aborted) setData(next); }
    catch (e) { if (signal?.aborted) return; if (e instanceof CollabApiError && [401,403,404].includes(e.status)) setData(null); throw e; }
  }, [taskId]);
  useEffect(() => {
    const controller = new AbortController();
    const read = () => { void refresh(controller.signal).catch(e => setError(e.message)); };
    read(); const timer = setInterval(() => { if (document.visibilityState === "visible") read(); }, 4000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [refresh]);
  async function execute(operation: Operation) {
    setBusy(true); setPending(operation); setError(""); setMessage("");
    try {
      await collabApi(operation.path, operation.body); setPending(null); setMessage("操作已保存，子任务状态会自动更新。");
      await refresh(); await onChange();
    } catch (e) { setError((e as Error).message); if (e instanceof CollabApiError && e.status < 500) setPending(null); }
    finally { setBusy(false); }
  }
  const send = (path: string, body: Record<string, unknown>) => execute({ path, body: { ...body, idempotencyKey: crypto.randomUUID() } });
  const locked = busy || !!pending, validReason = reason.trim().length >= 10;
  function propose(event: FormEvent) { event.preventDefault(); if (runId) void send(`runs/${runId}/subtasks`, { title, description, acceptance, prompt }); }
  function policy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!data) return; const fields = new FormData(event.currentTarget);
    void send(`projects/${projectId}/subtask-policy`, { expectedVersion: data.policy.version, concurrentChildren: Number(fields.get("concurrent")), descendants: Number(fields.get("descendants")), depth: Number(fields.get("depth")), reason });
  }
  return <section className="collab-card" aria-label="独立子 AI 任务">
    <h3>独立子 AI 任务</h3>
    <p className="collab-muted">子 AI 使用独立工作区，可与父 AI 同时执行。提案经成员确认才启动；结果以固定版本返回，由成员选择加入父任务后续输入。</p>
    {error && <p role="alert" className="collab-error">{error}</p>}{message && <p role="status">{message}</p>}
    {pending && <button className="collab-button" disabled={busy} onClick={() => void execute(pending)}>重试同一子任务请求</button>}
    {data ? <>
      {data.parent && <p>父任务：<button className="collab-button" onClick={() => void onOpenTask(data.parent!.taskId)}>{data.parent.title}</button> · 第 {data.parent.depth} 层</p>}
      <p className="collab-small">每棵任务树最多同时运行 {data.policy.concurrentChildren} 个子 AI，累计 {data.policy.descendants} 个子任务，深度 {data.policy.depth} 层。成员、项目与模型限额继续生效。</p>
      {(canPropose || data.canAct || data.canManage) && <label className="collab-form">子任务操作原因<textarea aria-label="子任务操作原因" value={reason} disabled={locked} onChange={e => setReason(e.target.value)} rows={2} maxLength={2000} placeholder="确认、拒绝、采纳、停止或修改配额的原因（至少 10 个字符）" /></label>}
      {canPropose && runId && <details><summary>提出子任务</summary><form className="collab-form compact" onSubmit={propose}>
        <label>子任务标题<input required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} disabled={locked}/></label>
        <label>子任务描述<textarea maxLength={10000} value={description} onChange={e => setDescription(e.target.value)} disabled={locked}/></label>
        <label>子任务验收标准<textarea required maxLength={10000} value={acceptance} onChange={e => setAcceptance(e.target.value)} disabled={locked}/></label>
        <label>子 AI 指令<textarea required maxLength={10000} value={prompt} onChange={e => setPrompt(e.target.value)} disabled={locked}/></label>
        <button className="collab-button" disabled={locked}>保存子任务提案</button>
      </form></details>}
      <h4>待确认与近期提案</h4>
      <label><input type="checkbox" checked={acknowledge} disabled={locked} onChange={e => setAcknowledge(e.target.checked)}/> 我确认启动所选提案，使用下方模型并计入我的项目用量。</label>
      {data.proposals.length === 0 && <p className="collab-muted">暂无子任务提案。父 AI 也可使用协作工具提出。</p>}
      {data.proposals.map(p => <article className="collab-card" key={p.id} aria-label={`子任务提案 ${p.request.title}`}>
        <strong>{p.request.title}</strong> · {statusNames[p.status] ?? p.status} · {p.sourceKind === "agent" ? "AI 提出" : "成员提出"}
        <p className="collab-small">{p.modelName ?? "未配置模型（仅诊断运行可用）"} · {p.runtime} · 基线 {p.baseSha.slice(0,12)}</p>
        <p className="collab-muted collab-small">继承仓库基线、模型和依赖约束；父任务未提交文件与会话不会自动复制。启动前重新核对权限和来源。</p>
        <details><summary>目标、验收与指令</summary><p className="collab-prewrap">{p.request.description}</p><p className="collab-prewrap">{p.request.acceptance}</p><pre className="collab-prewrap">{p.request.prompt}</pre></details>
        {p.note && <p>{p.note}</p>}
        {p.status === "proposed" && <div className="collab-actions">
          {p.canAccept && <button className="collab-button" disabled={locked || !validReason || !acknowledge} onClick={() => void send(`subtasks/${p.id}/decision`, { decision: "accept", expectedVersion: p.version, acknowledge, reason })}>确认启动子 AI</button>}
          {(p.canAccept || data.canManage) && <button className="collab-button" disabled={locked || !validReason} onClick={() => void send(`subtasks/${p.id}/decision`, { decision: "reject", expectedVersion: p.version, acknowledge: false, reason })}>拒绝提案</button>}
          {!p.canAccept && <p className="collab-muted collab-small">启动需由仍持有父运行控制权的原发起人确认。</p>}
        </div>}
      </article>)}
      {data.historyTruncated && <p className="collab-muted">保留全部待确认提案，已处理记录仅显示最近部分；历史操作保存在项目审计。</p>}
      <h4>子任务与返回成果</h4>
      {data.children.length === 0 && <p className="collab-muted">尚未启动子任务。</p>}
      {data.children.map(c => <article className="collab-card" key={c.taskId} aria-label={`子任务 ${c.title}`}>
        <button className="collab-button" onClick={() => void onOpenTask(c.taskId)}>{c.title}</button> · {statusNames[c.run?.status ?? c.status] ?? c.status}
        {c.run?.status === "queued" && !c.run.quotaAvailable && <p role="status">等待任务树的子 AI 并发名额，未确认退出的运行仍占用名额。</p>}
        {c.result ? <><p>返回成果 v{c.result.version} · {c.result.valid ? "有效" : "已失效"} · {c.result.worktreeCommit.slice(0,12)}</p><p className="collab-prewrap">{c.result.note}</p>
          <p className="collab-small">快照、验证与代码哈希已固定；打开子任务查看差异和证据包。</p>
          {c.adoptedResultId === c.result.id ? <p>已加入父任务依赖；新运行会固定当时有效的依赖版本。</p> : data.canAct && <button className="collab-button" disabled={locked || !validReason || !c.result.valid} onClick={() => void send(`tasks/${taskId}/subtasks`, { action: "adopt", childTaskId: c.taskId, resultId: c.result!.id, expectedVersion: data.taskVersion, reason })}>将成果加入父任务后续输入</button>}
        </> : <p className="collab-muted">等待子任务保存快照、通过验证并发布成果。</p>}
      </article>)}
      {data.canAct && <><p className="collab-muted collab-small">采纳需先停止父运行；下一次启动读取固定成果，仍需正常整合和评审。停止子任务会递归请求退出并拒绝待确认提案，父任务单独保留。</p><button className="collab-button" disabled={locked || !validReason} onClick={() => void send(`tasks/${taskId}/subtasks`, { action: "stop", reason })}>停止全部后代任务</button></>}
      {data.canManage && <details><summary>子任务配额</summary><form key={data.policy.version} className="collab-form compact" onSubmit={policy}>
        <label>同时运行子 AI 数<input name="concurrent" type="number" min={1} max={16} required defaultValue={data.policy.concurrentChildren} disabled={locked}/></label>
        <label>每棵树累计子任务数<input name="descendants" type="number" min={1} max={64} required defaultValue={data.policy.descendants} disabled={locked}/></label>
        <label>最大层数<input name="depth" type="number" min={1} max={4} required defaultValue={data.policy.depth} disabled={locked}/></label>
        <button className="collab-button" disabled={locked || !validReason}>保存子任务配额</button>
      </form></details>}
    </> : <p className="collab-muted">正在读取子任务…</p>}
  </section>;
}
