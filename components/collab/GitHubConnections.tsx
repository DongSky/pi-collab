"use client";
import { useEffect, useRef, useState } from "react";
import { collabApi, CollabApiError } from "./api";

type Installation = { credential_present: boolean; id: string; app_id: string; installation_id: string; account_id: string; account_login: string; app_slug: string; public_key_fingerprint: string; enabled: boolean; version: string; verified_at: string; webhook?: { version: string; enabled: boolean; lastReceivedAt: string | null } };
export interface GitHubBindingSummary { repositoryId: string; owner: string; name: string; url: string; targetSha: string; defaultBranch: string; verifiedAt: string; state: "observed" | "disabled"; }
export function GitHubRepositoryInfo({ binding, localSha }: { binding: GitHubBindingSummary | null | undefined; localSha: string }) {
  if (!binding) return null;
  return <section className="collab-form compact" aria-label="GitHub 仓库关联">
    <strong>GitHub · <a href={binding.url} target="_blank" rel="noreferrer">{binding.owner}/{binding.name}</a></strong>
    <p className="collab-small">稳定仓库编号 {binding.repositoryId} · 默认分支 {binding.defaultBranch}</p>
    <p role="status">{binding.state === "disabled" ? "安装关联已停用" : "已保存远端读取核验记录"}</p>
    <p className="collab-small" style={{ overflowWrap: "anywhere" }}>远端基线（核验时）{binding.targetSha}<br/>当前本地基线 {localSha}</p>
    <p className="collab-muted collab-small">核验于 {new Date(binding.verifiedAt).toLocaleString()}。这是当时的读取结果；远端可能已经变化。本地成果与推进不代表远程发布。具备项目维护权限的团队管理员可在下方导入新仓库；维护者可发起同步，仅在可快进时更新公共基线；任务分支推送和草稿 PR 需分别明确确认，固定代码版本支持独立团队评审与受保护合并。停用关联保留本机副本与任务。</p>
  </section>;
}

type SyncEntry = { failure: string | null; id: string; repositoryId: string; name: string; status: string; classification: string | null; outcome: string | null; branch: string; oldSha: string; remoteSha: string | null; createdAt: string; dispatch: { state: string; mode: string; stopRequested: boolean } | null };
type SyncRepository = { id: string; name: string; base_sha: string; default_branch: string; github?: GitHubBindingSummary | null };
export function GitHubSyncs({ projectId, repository, canManage }: { projectId: string; repository?: SyncRepository; canManage: boolean }) {
  const [items, setItems] = useState<SyncEntry[]>([]), [error, setError] = useState(""), [actionError, setActionError] = useState("");
  const [reason, setReason] = useState(""), [acknowledged, setAcknowledged] = useState(""), [reasons, setReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false), [retry, setRetry] = useState(false), [generation, setGeneration] = useState(0);
  const pending = useRef<{ url: string; body: Record<string, unknown> } | null>(null);
  const revision = repository ? `${repository.id}:${repository.default_branch}:${repository.base_sha}` : "";
  useEffect(() => {
    let active = true, latest = 0;
    const load = async () => { const request = ++latest; try { const result = await collabApi<{ syncs: SyncEntry[] }>(`projects/${projectId}/github-syncs`); if (active && request === latest) { setItems(result.syncs); setError(""); } }
      catch (e) { if (active && request === latest) { setItems([]); setError(e instanceof Error ? e.message : "读取仓库同步记录失败"); } } };
    void load(); const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [projectId, generation]);
  async function submit(url: string, body: Record<string, unknown>) {
    if (busy) return; pending.current ??= { url, body }; setBusy(true); setActionError("");
    try { await collabApi(pending.current.url, pending.current.body); pending.current = null; setRetry(false); setAcknowledged(""); }
    catch (e) { if (e instanceof CollabApiError && e.status < 500) pending.current = null; setRetry(!!pending.current); setActionError(e instanceof Error ? e.message : "提交 Git 同步操作失败"); }
    finally { setBusy(false); setGeneration(n => n + 1); }
  }
  const canSync = canManage && repository?.github?.state === "observed";
  if (!items.length && !error && !canSync) return null;
  const labels: Record<string, string> = { pending: "等待同步", fetching: "获取中或待核查", applying: "更新中或待核查", blocked: "基线不一致，等待维护者核查", failed: "同步未完成", equal: "已与核验时的远端一致", fast_forward: "已快进至远端提交", local_ahead: "本地领先，已保留本地成果", diverged: "双方分叉，已保留本地成果", branch_changed: "远端默认分支已改变，未切换本地分支", aborted: "同步已终止，未更新公共基线" };
  return <section className="collab-form compact" aria-label="GitHub 仓库同步"><strong>GitHub 仓库同步</strong>
    {error && <p role="alert" className="collab-error">{error}</p>}
    {actionError && <p role="alert" className="collab-error">{actionError}</p>}
    {canManage && retry && <button className="collab-button" disabled={busy} onClick={() => pending.current && void submit(pending.current.url, pending.current.body)}>重试同一同步操作</button>}
    <p className="collab-muted collab-small">同步仅在可快进时更新公共基线；现有 AI 工作区保留原版本，新任务使用新基线。分叉或本地领先需要维护者另行整合。未确认的同步持续占用目标分支，核查确认后才能释放。</p>
    {canSync && <form className="collab-form compact" aria-label="发起仓库同步" onSubmit={e => { e.preventDefault(); if (acknowledged !== revision) return; void submit(`repositories/${repository.id}/github-syncs`, { expectedSha: repository.base_sha, expectedBranch: repository.default_branch, acknowledge: true, reason, idempotencyKey: crypto.randomUUID() }); }}>
      <strong>{repository.name} · {repository.default_branch}</strong><p className="collab-small" style={{ overflowWrap: "anywhere" }}>当前基线 {repository.base_sha}</p>
      <label>同步原因<textarea aria-label="同步原因" required minLength={10} maxLength={2000} disabled={busy || retry} value={reason} onChange={e => setReason(e.target.value)}/></label>
      <label className="collab-checkbox"><input type="checkbox" required disabled={busy || retry} checked={acknowledged === revision} onChange={e => setAcknowledged(e.target.checked ? revision : "")}/>允许将此公共基线安全快进至核验的远端提交</label>
      <button className="collab-button" disabled={busy || retry || acknowledged !== revision}>获取远端并安全快进</button>
    </form>}
    <p className="collab-small">最近 20 次同步</p>
    {items.map(item => <article key={item.id} className="collab-snapshot-card" aria-label={`仓库同步 ${item.name}`}><strong>{item.name} · {item.branch}</strong>
      <p role="status">{item.failure === "github_sync_cancelled" ? "已取消，公共基线未更新" : item.dispatch?.state === "attention" ? "执行已中断，等待维护者核查" : item.dispatch?.mode === "reconcile" && ["queued", "running"].includes(item.dispatch.state) ? "原操作核查中" : item.dispatch?.stopRequested && !item.outcome && item.status !== "failed" ? "已请求取消，等待确认" : labels[item.outcome ?? item.status] ?? "等待核查"}</p>
      <p className="collab-small" style={{ overflowWrap: "anywhere" }}>同步前 {item.oldSha}<br/>核验远端 {item.remoteSha ?? "尚未核验"}<br/>记录 {item.id} · {new Date(item.createdAt).toLocaleString()}</p>
      {canManage && !["completed", "failed"].includes(item.status) && <form className="collab-form compact" onSubmit={e => { e.preventDefault(); const action = item.dispatch && ["queued", "running"].includes(item.dispatch.state) ? "cancel" : "reconcile"; void submit(`github-syncs/${item.id}/actions`, { action, reason: reasons[item.id] ?? "", idempotencyKey: crypto.randomUUID() }); }}>
        <label>处理原因<textarea aria-label="同步处理原因" required minLength={10} maxLength={2000} disabled={busy || retry} value={reasons[item.id] ?? ""} onChange={e => setReasons({ ...reasons, [item.id]: e.target.value })}/></label>
        <button className="collab-button" disabled={busy || retry || (!!item.dispatch?.stopRequested && ["queued", "running"].includes(item.dispatch.state))}>{item.dispatch && ["queued", "running"].includes(item.dispatch.state) ? "取消同步" : "核查原同步"}</button>
        <p className="collab-muted collab-small">取消可能需等待当前读取结束。核查只确认已有结果或终止未执行的更新，不会再次推进分支。</p>
      </form>}
    </article>)}
  </section>;
}
export function GitHubConnections({ organizationId }: { organizationId: string }) {
  const [items, setItems] = useState<Installation[]>([]), [error, setError] = useState(""), [busy, setBusy] = useState(false), [retry, setRetry] = useState(false), [refresh, setRefresh] = useState(0);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const pending = useRef<{ id: string; action: "disable" | "remove-credential"; body: { expectedVersion: string; reason: string; idempotencyKey: string } } | null>(null);
  useEffect(() => {
    let active = true, latest = 0;
    const load = async () => { const request = ++latest; try { const data = await collabApi<{ installations: Installation[] }>(`organizations/${organizationId}/github-installations`); if (active && request === latest) setItems(data.installations); }
      catch (e) { if (active && request === latest) { setItems([]); setError(e instanceof Error ? e.message : "读取 GitHub 安装失败"); } } };
    void load(); const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [organizationId, refresh]);
  async function disable(id: string, body: { expectedVersion: string; reason: string; idempotencyKey: string }, action: "disable" | "remove-credential" = "disable") {
    if (busy) return; pending.current ??= { id, body, action }; setBusy(true); setError("");
    try { await collabApi(`github-installations/${pending.current.id}/${pending.current.action}`, pending.current.body); pending.current = null; setRetry(false); setRefresh(n => n + 1); }
    catch (e) { if (e instanceof CollabApiError && e.status < 500) pending.current = null; setRetry(!!pending.current); setRefresh(n => n + 1); setError(e instanceof Error ? e.message : "停用 GitHub 安装失败"); }
    finally { setBusy(false); }
  }
  return <section className="collab-settings-section" aria-label="GitHub 安装管理"><h2>GitHub 安装管理</h2>
    <p className="collab-muted">本机管理员可登记团队的 GitHub App 安装并核验仓库关联。私钥和短期令牌不进入浏览器或 AI。此处显示最多 100 个安装，核验记录不授予远程写入权限。</p>
    {error && <p role="alert" className="collab-error">{error}</p>}
    {retry && <button className="collab-button" disabled={busy} onClick={() => pending.current && void disable(pending.current.id, pending.current.body)}>重试同一 GitHub 操作</button>}
    {!items.length && <p className="collab-muted">尚未登记 GitHub 安装。</p>}
    {items.map(item => <article className="collab-snapshot-card" key={item.id} aria-label={`GitHub 安装 ${item.id}`}>
      <strong>{item.app_slug} · {item.account_login}</strong><p role="status">{item.enabled ? "本机关联已启用 · 远端权限需逐次核验" : "安装关联已停用"}</p>
      <p className="collab-small">App {item.app_id} · Installation {item.installation_id} · 账户 {item.account_id} · 本机版本 {item.version}</p>
      <p className="collab-small">签名事件接收：{item.webhook?.enabled ? "已配置" : "未启用"} · 配置版本 {item.webhook?.version ?? "0"}{item.webhook?.lastReceivedAt && <><br/>最近有效通知 {new Date(item.webhook.lastReceivedAt).toLocaleString()}</>}</p>
      <p className="collab-muted collab-small">由本机管理员通过 github:webhook 命令配置或轮换验证密钥；验证密钥不进入浏览器。请为 GitHub App 配置 push、pull_request、check_run 和 check_suite 事件。</p>
      <p className="collab-muted collab-small" style={{ overflowWrap: "anywhere" }}>公钥指纹 {item.public_key_fingerprint}<br/>核验于 {new Date(item.verified_at).toLocaleString()}</p>
      <p className="collab-small">本机 App 私钥：{item.credential_present ? "已加密保存" : "已删除"}。轮换或刷新权限可由本机管理员运行 github:import rotate-key / refresh；使用 --enable 可重新核验并启用关联。</p>
      {item.credential_present && <form className="collab-form compact" onSubmit={e=>{e.preventDefault();void disable(item.id,{expectedVersion:item.version,reason:reasons[item.id]??"",idempotencyKey:crypto.randomUUID()},"remove-credential");}}>
        <label>凭据删除原因<textarea aria-label="GitHub 凭据删除原因" required minLength={10} maxLength={2000} disabled={busy||retry} value={reasons[item.id]??""} onChange={e=>setReasons({...reasons,[item.id]:e.target.value})}/></label>
        <label><input type="checkbox" required disabled={busy||retry}/>确认删除本机加密私钥并停用关联；恢复需重新提供私钥，不卸载远端 App</label><button className="collab-button secondary" disabled={busy||retry}>删除本机 GitHub 凭据</button>
      </form>}
      {item.enabled && <form className="collab-form compact" onSubmit={e => { e.preventDefault(); void disable(item.id, { expectedVersion: item.version, reason: reasons[item.id] ?? "", idempotencyKey: crypto.randomUUID() }); }}>
        <p className="collab-muted collab-small">停用将使该安装关联的仓库远端授权失效，本机代码与历史保留。此操作不卸载 GitHub 网站上的 App。</p>
        <label>GitHub 停用原因<textarea aria-label="GitHub 停用原因" required minLength={10} maxLength={2000} disabled={busy || retry} value={reasons[item.id] ?? ""} onChange={e => setReasons({ ...reasons, [item.id]: e.target.value })}/></label>
        <button className="collab-button" disabled={busy || retry}>停用 GitHub 安装关联</button>
      </form>}
    </article>)}
  </section>;
}
