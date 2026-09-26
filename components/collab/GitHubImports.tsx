"use client";
import { useEffect, useRef, useState } from "react";
import { collabApi, CollabApiError } from "./api";

type ImportEntry = { id: string; repositoryId: string; name: string; status: "pending" | "fetching" | "completed" | "failed";
  failure: string | null; baseSha: string | null; createdAt: string; dispatch: { state: string; mode: string; stopRequested: boolean } | null };
type ImportOptions = { canImport: boolean; installations: { id: string; accountLogin: string; appSlug: string }[] };
export function GitHubImports({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<ImportEntry[]>([]), [options, setOptions] = useState<ImportOptions>({ canImport: false, installations: [] });
  const [error, setError] = useState(""), [actionError, setActionError] = useState(""), [generation, setGeneration] = useState(0);
  const [connectionId, setConnectionId] = useState(""), [githubRepositoryId, setRemote] = useState(""), [name, setName] = useState(""), [reason, setReason] = useState("");
  const [reasons, setReasons] = useState<Record<string, string>>({}), [busy, setBusy] = useState(false), [retry, setRetry] = useState(false);
  const pending = useRef<{ url: string; body: Record<string, unknown> } | null>(null);
  useEffect(() => {
    let active = true, latest = 0;
    const load = async () => {
      const request = ++latest;
      try {
        const [records, scope] = await Promise.all([collabApi<{ imports: ImportEntry[] }>(`projects/${projectId}/github-imports`), collabApi<ImportOptions>(`projects/${projectId}/github-import-options`)]);
        if (active && request === latest) { setItems(records.imports); setOptions(scope); setError(""); }
      } catch (e) { if (active && request === latest) { setItems([]); setOptions({ canImport: false, installations: [] }); setError(e instanceof Error ? e.message : "读取仓库导入记录失败"); } }
    };
    void load(); const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [projectId, generation]);
  async function submit(url: string, body: Record<string, unknown>) {
    if (busy) return; pending.current ??= { url, body }; setBusy(true); setActionError("");
    try { await collabApi(pending.current.url, pending.current.body); pending.current = null; setRetry(false); }
    catch (e) { if (e instanceof CollabApiError && e.status < 500) pending.current = null; setRetry(!!pending.current); setActionError(e instanceof Error ? e.message : "提交仓库导入失败"); }
    finally { setBusy(false); setGeneration(n => n + 1); }
  }
  if (!items.length && !error && !options.canImport) return null;
  const labels = { pending: "等待导入", fetching: "获取中或待核查", completed: "已导入", failed: "导入未完成" };
  return <section className="collab-form compact" aria-label="GitHub 仓库导入"><strong>GitHub 仓库导入</strong>
    {error && <p role="alert" className="collab-error">{error}</p>}
    {actionError && <p role="alert" className="collab-error">{actionError}</p>}
    {options.canImport && retry && <button className="collab-button" disabled={busy} onClick={() => pending.current && void submit(pending.current.url, pending.current.body)}>重试同一导入操作</button>}
    <p className="collab-muted collab-small">导入保留核验时的原始提交与分支历史，不代表已经同步到远端最新状态。Git LFS 与子模块保留引用，尚不下载附属内容。中断后可核查原导入；只有完整代码通过核验才会用于新任务。</p>
    {options.canImport && (options.installations.length ? <form className="collab-form compact" aria-label="导入新 GitHub 仓库" onSubmit={e => {
      e.preventDefault(); void submit(`projects/${projectId}/github-imports`, { connectionId, githubRepositoryId, name, reason, idempotencyKey: crypto.randomUUID() });
    }}>
      <p className="collab-small">使用团队安装导入新仓库需同时具备团队管理员和本项目维护者权限，并启用双重验证。</p>
      <label>团队 GitHub 安装<select aria-label="导入使用的 GitHub 安装" required disabled={busy || retry} value={connectionId} onChange={e => setConnectionId(e.target.value)}>
        <option value="" disabled>请选择安装</option>{options.installations.map(item => <option key={item.id} value={item.id}>{item.accountLogin} · {item.appSlug}</option>)}
      </select></label>
      <label>GitHub 仓库数字编号<input aria-label="GitHub 仓库数字编号" inputMode="numeric" pattern="[1-9][0-9]{0,15}" required disabled={busy || retry} value={githubRepositoryId} onChange={e => setRemote(e.target.value)}/></label>
      <p className="collab-small collab-muted">使用 GitHub 仓库信息中的数字 ID。安装必须有权读取该仓库；导入完成后可查看核验的仓库链接。</p>
      <label>项目内仓库名称<input aria-label="项目内仓库名称" required maxLength={120} disabled={busy || retry} value={name} onChange={e => setName(e.target.value)}/></label>
      <label>导入原因<textarea aria-label="导入原因" required minLength={10} maxLength={2000} disabled={busy || retry} value={reason} onChange={e => setReason(e.target.value)}/></label>
      <button className="collab-button" disabled={busy || retry || !options.installations.some(item => item.id === connectionId)}>导入到本项目</button>
    </form> : <p className="collab-muted collab-small">团队尚无启用的 GitHub 安装，请先由本机管理员登记安装。</p>)}
    <p className="collab-small">最近 20 次导入</p>
    {items.map(item => <article key={item.id} className="collab-snapshot-card" aria-label={`仓库导入 ${item.name}`}><strong>{item.name}</strong>
      <p role="status">{item.failure === "github_import_cancelled" ? "已取消，未发布本机仓库" : item.dispatch?.state === "attention" ? "执行已中断，等待管理员核查" : item.dispatch?.stopRequested && !["failed", "completed"].includes(item.status) ? "已请求取消，等待确认" : item.dispatch?.mode === "reconcile" && ["queued", "running"].includes(item.dispatch.state) ? "原导入核查中" : labels[item.status]}</p>
      <p className="collab-small" style={{ overflowWrap: "anywhere" }}>{item.baseSha ? `导入提交 ${item.baseSha}` : "尚未发布可用代码"}<br/>记录 {item.id} · {new Date(item.createdAt).toLocaleString()}</p>
      {item.status === "failed" && <p className="collab-muted collab-small">{["github_import_authority_changed", "github_maintainer_authority_required", "github_connection_unavailable"].includes(item.failure ?? "") ? "项目权限或安装授权发生变化，请由管理员重新核对。" : item.failure === "github_import_cancelled" ? "取消已确认。" : "代码获取或完整性核验未通过，请由管理员检查原请求。"} 已创建的目录保留，未完成的代码不会用于新任务。</p>}
      {options.canImport && !["completed", "failed"].includes(item.status) && <form className="collab-form compact" onSubmit={e => {
        e.preventDefault(); const action = (e.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "cancel" || (item.dispatch && ["queued", "running"].includes(item.dispatch.state)) ? "cancel" : "reconcile";
        void submit(`github-imports/${item.id}/actions`, { action, reason: reasons[item.id] ?? "", idempotencyKey: crypto.randomUUID() });
      }}>
        <label>处理原因<textarea aria-label="导入处理原因" required minLength={10} maxLength={2000} disabled={busy || retry} value={reasons[item.id] ?? ""} onChange={e => setReasons({ ...reasons, [item.id]: e.target.value })}/></label>
        <button className="collab-button" disabled={busy || retry || (!!item.dispatch?.stopRequested && ["queued", "running"].includes(item.dispatch.state))}>{item.dispatch && ["queued", "running"].includes(item.dispatch.state) ? "取消导入" : "核查原导入"}</button>
        {(!item.dispatch || item.dispatch.state === "attention") && <button className="collab-button secondary" value="cancel" disabled={busy || retry}>终止原导入</button>}
        <p className="collab-muted collab-small">取消需等待当前读取结束；已完成的导入不会撤销。核查验证已取得的代码，不会重新下载。</p>
      </form>}
    </article>)}
  </section>;
}
