"use client";
import { useCallback, useEffect, useState } from "react";
import { collabApi } from "./api";
type Context = {
  version: number; priority: number; canManage: boolean; totalQueued: number; protectedAfterMinutes: number; priorityCreditMinutes: number;
  queue: { runId: string; taskId: string; title: string; ownerName: string; runtime: string; waitSeconds: number; protected: boolean; dependencyState: string; capacityAvailable: boolean; childCapacityAvailable: boolean }[];
};
const priorities = ["低", "普通", "高"];
export function Scheduling({ projectId }: { projectId: string }) {
  const [data, setData] = useState<Context | null>(null), [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const route = `projects/${projectId}/scheduling`;
  const load = useCallback(async () => { try { setData(await collabApi<Context>(route)); setError(""); } catch (e) { setError(e instanceof Error ? e.message : "读取调度队列失败"); } }, [route]);
  useEffect(() => { void load(); const timer = setInterval(() => { if (!document.hidden && !editing) void load(); }, 5000); return () => clearInterval(timer); }, [load, editing]);
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!data) return;
    const form = new FormData(event.currentTarget); setBusy(true); setError("");
    try {
      await collabApi(route, { expectedVersion: data.version, priority: Number(form.get("priority")), reason: form.get("reason"), idempotencyKey: crypto.randomUUID() }, "PUT");
      setEditing(false); setNotice("项目优先级已保存，下一次领取排队任务时生效。"); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "保存失败，请刷新核对项目优先级"); } finally { setBusy(false); }
  }
  return <section aria-label="调度与等待队列"><h3>调度与等待队列</h3>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <button className="collab-text-button" disabled={busy || editing} onClick={() => void load()}>刷新调度队列</button>
    {data && <><p>项目优先级：{priorities[data.priority]} · 当前排队 {data.totalQueued} 个</p>
      <p className="collab-small">等待满 {data.protectedAfterMinutes} 分钟且符合启动条件的任务优先按先来后到领取；其他任务先照顾活动运行较少的成员，再比较项目优先级与等待时间。每级优先级相当于提前等待 {data.priorityCreditMinutes} 分钟。</p>
      <p className="collab-small">优先级不抢占运行中的 AI，也不跳过依赖、成员／子 AI 配额或磁盘限制。这里仅列本项目的参考顺序，实际启动还取决于执行器空位和运行方式。</p>
      {data.canManage && <><button className="collab-button" disabled={busy} onClick={() => setEditing(!editing)}>{editing ? "取消编辑优先级" : "配置项目优先级"}</button>
        {editing && <form className="collab-form" onSubmit={save} key={data.version}>
          <label>项目排队优先级<select name="priority" aria-label="项目排队优先级" defaultValue={data.priority}>{priorities.map((label, value) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>调度修改说明<textarea name="reason" minLength={10} maxLength={2000} required /></label>
          <p className="collab-small">维护者需启用 MFA；修改记录进入项目审计。</p>
          <button className="collab-button" disabled={busy}>保存项目优先级</button>
        </form>}</>}
      {!data.queue.length ? <p>当前没有排队任务。</p> : <ol>{data.queue.map(run => <li key={run.runId} className="collab-result-card"><strong>{run.title}</strong>
        <p>{run.ownerName} · {run.runtime === "docker" ? "Docker" : "原生"} · 已等待 {Math.floor(run.waitSeconds / 60)} 分钟{run.protected ? " · 已进入等待保护" : ""}</p>
        <p>{run.dependencyState === "waiting" ? "等待上游成果。" : run.dependencyState === "needs_revalidation" ? "固定输入需重新验证。" : ""}{!run.capacityAvailable ? "等待并发或资源额度。" : ""}{!run.childCapacityAvailable ? "等待子 AI 并发名额。" : ""}</p>
      </li>)}</ol>}
      {data.totalQueued > data.queue.length && <p>仅显示前 {data.queue.length} 个，共 {data.totalQueued} 个排队任务。</p>}
    </>}
  </section>;
}
