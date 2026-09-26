"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { collabApi, CollabApiError } from "./api";
type Preview = { id: string; title: string; status: string; author_id: string; snapshot_id: string; runtime: string; expires_at: string; failure: string | null; cleaned_at: string | null; cleanup_confirmed: boolean; output_tail: string };
type Listing = { role: string; configured: boolean; previews: Preview[]; logs: { id: string; preview_id: string; method: string; path: string; code: number }[] };
const names: Record<string, string> = { queued: "排队中", starting: "安装／构建／启动中", ready: "运行中", stopping: "等待退出", stopped: "已停止", failed: "启动失败", unknown: "退出待核查" };
export function ServicePreviews({ taskId, userId }: { taskId: string; userId: string }) {
  const [data, setData] = useState<Listing | null>(null), [validations, setValidations] = useState<{ id: string; status: string; profile_name: string }[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState(""), [opened, setOpened] = useState<{ id: string; url: string; expiresAt: string } | null>(null);
  const access = useRef({ active: true, epoch: 0, read: 0 });
  const failed = useCallback((error: unknown) => {
    if (error instanceof CollabApiError && [401, 403, 404].includes(error.status)) {
      access.current.epoch++; access.current.read++;
      setData(null); setValidations([]); setOpened(null); setNotice("");
    }
    setError(error instanceof Error ? error.message : "动态预览操作失败");
  }, []);
  const refresh = useCallback(async () => {
    const read = ++access.current.read, epoch = access.current.epoch;
    const current = () => access.current.active && access.current.read === read && access.current.epoch === epoch;
    try {
      const [next, v] = await Promise.all([collabApi<Listing>(`tasks/${taskId}/service-previews`), collabApi<{ validations: typeof validations }>(`tasks/${taskId}/validations`)]);
      if (!current()) return;
      setData(next); setValidations(v.validations.filter(x => x.status === "passed")); setError("");
      setOpened(old => old && next.previews.some(p => p.id === old.id && p.status === "ready") && new Date(old.expiresAt).getTime() > Date.now() ? old : null);
    } catch (e) { if (current()) failed(e); }
  }, [taskId, failed]);
  useEffect(() => {
    const lifecycle = access.current; lifecycle.active = true; void refresh();
    const resume = () => { if (!document.hidden) void refresh(); };
    const timer = setInterval(resume, 3000);
    document.addEventListener("visibilitychange", resume); window.addEventListener("online", resume);
    return () => { lifecycle.active = false; lifecycle.epoch++; lifecycle.read++; clearInterval(timer); document.removeEventListener("visibilitychange", resume); window.removeEventListener("online", resume); };
  }, [refresh]);
  useEffect(() => { if (!opened) return; const timer = setTimeout(() => setOpened(null), Math.max(0, new Date(opened.expiresAt).getTime() - Date.now())); return () => clearTimeout(timer); }, [opened]);
  async function act(work: (current: () => boolean) => Promise<void>) {
    const epoch = access.current.epoch, current = () => access.current.active && access.current.epoch === epoch;
    setBusy(true); setError("");
    try { await work(current); if (current()) await refresh(); }
    catch (e) { if (current()) failed(e); }
    finally { if (access.current.active) setBusy(false); }
  }
  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    await act(async current => { await collabApi(`tasks/${taskId}/service-previews`, { validationId: f.get("validation"), title: f.get("title"), acknowledge: true, idempotencyKey: crypto.randomUUID(), config: { install: f.get("install"), build: String(f.get("build")).trim() ? { version: 1, steps: JSON.parse(String(f.get("build"))) } : null, start: { tool: f.get("tool"), args: JSON.parse(String(f.get("args"))) }, healthPath: f.get("health"), seconds: Number(f.get("seconds")) } }); if (current()) setNotice("动态预览已排队。安装、构建和运行仅修改独立临时副本。"); });
  }
  return <section className="collab-snapshots" aria-label="动态服务预览"><h2>动态服务预览</h2>
    <p className="collab-muted collab-small">从通过验证的快照重建临时服务，支持 Node/npm 与 HTTP 接口。原生为默认，来源为 Docker 时继续容器运行。安装、构建和服务输出可在记录中查看；停止或到期后自动回收临时副本。</p>
    {error && <p role="alert" className="collab-error">{error}</p>}{notice && <p role="status">{notice}</p>}
    {data && !data.configured && <p>需要配置独立预览来源。</p>}
    {data && ["developer", "maintainer"].includes(data.role) && <details><summary>启动动态预览</summary><form className="collab-form compact" onSubmit={create}>
      <label>动态预览来源<select name="validation" aria-label="动态预览来源" required><option value="">选择已通过验证的快照</option>{validations.map(v => <option key={v.id} value={v.id}>{v.profile_name} · {v.id.slice(0, 8)}</option>)}</select></label>
      <label>动态预览名称<input name="title" defaultValue="检查点服务" maxLength={120} required /></label>
      <label>安装依赖<select name="install" aria-label="安装依赖"><option value="none">不安装</option><option value="npm-ci">npm ci（固定锁文件，禁用安装脚本）</option></select></label>
      <label>构建步骤（JSON 数组，可留空）<textarea name="build" rows={3} placeholder={'[{"tool":"npm","args":["run","build"],"timeoutSeconds":120}]'} /></label>
      <label>启动程序<select name="tool" aria-label="启动程序"><option value="node">Node</option><option value="npm">npm</option></select></label>
      <label>启动参数（JSON 数组）<input name="args" defaultValue={'["server.js"]'} required /></label>
      <label>健康检查路径<input name="health" defaultValue="/" required /></label>
      <label>预览有效时间（秒）<input name="seconds" type="number" min={30} max={3600} defaultValue={900} required /></label>
      <p className="collab-small">服务须监听 HOST/PORT，并使用相对资源和接口地址。支持短 HTTP 请求，暂不支持 WebSocket、流式响应、应用 Cookie 或生产数据库。每项目最多 4 个活动预览，文件写入计入产物软配额。</p>
      <label><input type="checkbox" required />确认执行此快照中的安装／构建／启动步骤；服务临时数据将在停止后回收</label>
      <button className="collab-button" disabled={busy || !data.configured}>创建动态服务预览</button>
    </form></details>}
    {data?.previews.map(p => <article className="collab-snapshot-card" key={p.id} aria-label={`动态预览 ${p.title}`}><h3>{p.title} · {names[p.status]}</h3><p className="collab-small collab-git-identity">{p.runtime} · 固定快照 {p.snapshot_id}<br />到期 {new Date(p.expires_at).toLocaleString()}</p>
      {p.failure && <p role="status">{p.failure}</p>}{p.cleaned_at && <p>进程退出已确认，临时副本已回收。</p>}{p.status === "unknown" && <p>执行器会继续核对退出凭据；确认前保留副本与额度，不重新执行原请求。</p>}
      {p.status === "ready" && <button className="collab-button" disabled={busy} onClick={() => void act(async current => { const result = await collabApi<{ url: string; expiresAt: string }>(`service-previews/${p.id}`, {}); if (current()) setOpened({ id: p.id, ...result }); })}>打开动态预览</button>}
      {["queued", "starting", "ready", "stopping", "unknown"].includes(p.status) && (p.author_id === userId || data.role === "maintainer") && <form className="collab-form compact" onSubmit={e => { e.preventDefault(); const reason = String(new FormData(e.currentTarget).get("reason")); void act(async current => { await collabApi(`service-previews/${p.id}/stop`, { reason }); if (current()) setNotice("停止请求已记录，等待执行器确认退出并回收。"); }); }}><label>停止动态预览说明<input name="reason" required minLength={10} maxLength={2000} /></label><button className="collab-button" disabled={busy}>停止动态预览</button></form>}
      <details><summary>安装与服务日志（末尾 16000 字符）</summary><pre style={{ maxHeight: 300, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{p.output_tail || "暂无输出"}</pre></details>
      <details><summary>HTTP 访问记录</summary>{data.logs.filter(l => l.preview_id === p.id).map(l => <p key={l.id} className="collab-small">{l.code} · {l.method} · {l.path}</p>)}</details>
    </article>)}
    {opened && <div><p>个人访问有效至 {new Date(opened.expiresAt).toLocaleTimeString()}</p><button className="collab-text-button" onClick={() => setOpened(null)}>关闭动态预览</button><iframe title="动态服务沙箱预览" src={opened.url} sandbox="allow-scripts" referrerPolicy="no-referrer" style={{ width: "100%", height: 480, border: "1px solid var(--border)", background: "white" }} /></div>}
  </section>;
}
