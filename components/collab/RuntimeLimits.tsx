"use client";
import { useCallback, useEffect, useState } from "react";
import { collabApi } from "./api";
type Policy = { version: number; aiSeconds: number; terminalSeconds: number; workspaceBytes: number; memberBytes: number; projectBytes: number; chargedBytes: string; canManage: boolean; storageAvailable: boolean; workspaces: { id: string; title: string; owner_name: string; status: string; bytes: string | null; charged_bytes: string; error_code: string | null; measured_at: string | null; timeout_seconds: number | null }[] };
const MiB = 1024 * 1024;
const size = (value: string | number | null) => value === null ? "未测量" : `${(Number(value) / MiB).toFixed(1)} MiB`;
export function RuntimeLimits({ projectId }: { projectId: string }) {
  const route = `projects/${projectId}/runtime-policy`, [data, setData] = useState<Policy | null>(null), [error, setError] = useState(""), [notice, setNotice] = useState(""), [editing, setEditing] = useState(false), [busy, setBusy] = useState(false);
  const load = useCallback(async () => { try { setData(await collabApi<Policy>(route)); setError(""); } catch (e) { setError(e instanceof Error ? e.message : "读取运行额度失败"); } }, [route]);
  useEffect(() => { void load(); const timer = setInterval(() => { if (!document.hidden && !editing) void load(); }, 5000); return () => clearInterval(timer); }, [load, editing]);
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!data) return; const f = new FormData(event.currentTarget); setBusy(true); setError("");
    try {
      await collabApi(route, { expectedVersion: data.version, idempotencyKey: crypto.randomUUID(), reason: f.get("reason"), aiSeconds: Number(f.get("aiSeconds")), terminalSeconds: Number(f.get("terminalSeconds")), workspaceBytes: Number(f.get("workspaceMiB")) * MiB, memberBytes: Number(f.get("memberMiB")) * MiB, projectBytes: Number(f.get("projectMiB")) * MiB }, "PUT");
      setEditing(false); setNotice("运行额度已保存。活动运行保留已固定的时长和工作区额度，新启动使用新设置。"); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "保存运行额度失败"); } finally { setBusy(false); }
  }
  return <section aria-label="运行时长与磁盘额度"><h3>运行时长与磁盘额度</h3>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {data && <><p>AI 最长 {data.aiSeconds} 秒 · 人工终端最长 {data.terminalSeconds} 秒 · 每工作区 {size(data.workspaceBytes)}</p>
      <p>项目计入额度 {size(data.chargedBytes)} / {size(data.projectBytes)} · 每位成员 {size(data.memberBytes)}</p>
      {!data.storageAvailable && <p role="status">当前成员的新运行等待磁盘额度或用量核查；任务仍保留在队列。可由维护者调整额度。</p>}
      <p className="collab-small">启动前按完整工作区额度预留。执行器约每 2 秒检查逻辑文件大小，超额停止运行；这不是文件系统硬配额，快速写入可能短暂超额。已停止和归档目录继续计入额度，测量未知时阻止新启动。这里不会删除代码、快照或审计。</p>
      {data.canManage && <><button className="collab-button" disabled={busy} onClick={() => setEditing(!editing)}>{editing ? "取消编辑时长与磁盘" : "配置时长与磁盘"}</button>
        {editing && <form className="collab-form" onSubmit={save} key={data.version}>
          <label>AI 运行上限（秒）<input name="aiSeconds" type="number" min={1} max={86400} defaultValue={data.aiSeconds} required /></label>
          <label>终端运行上限（秒）<input name="terminalSeconds" type="number" min={1} max={86400} defaultValue={data.terminalSeconds} required /></label>
          <label>每工作区额度（MiB）<input name="workspaceMiB" type="number" min={1} max={1048576} defaultValue={data.workspaceBytes / MiB} required /></label>
          <label>每位成员额度（MiB）<input name="memberMiB" type="number" min={1} max={10485760} defaultValue={data.memberBytes / MiB} required /></label>
          <label>项目工作区总额度（MiB）<input name="projectMiB" type="number" min={1} max={10485760} defaultValue={data.projectBytes / MiB} required /></label>
          <p className="collab-small">项目额度须不小于成员额度，成员额度须不小于工作区额度。调低总额度会影响之后的排队任务。</p>
          <label>时长与磁盘修改说明<textarea name="reason" minLength={10} maxLength={2000} required /></label>
          <button className="collab-button" disabled={busy}>保存时长与磁盘</button>
        </form>}</>}
      <details><summary>工作区用量（最近 100 个）</summary>{data.workspaces.map(w => <article className="collab-result-card" key={w.id}><strong>{w.title}</strong><p>{w.owner_name} · {w.status} · 测得 {size(w.bytes)} · 计入 {size(w.charged_bytes)}</p>{w.error_code && <p role="status">用量未能完整核验，等待执行器重新测量。</p>}{w.measured_at && <time>{new Date(w.measured_at).toLocaleString()}</time>}</article>)}</details>
    </>}
  </section>;
}
