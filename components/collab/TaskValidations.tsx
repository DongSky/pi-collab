"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { collabApi, CollabApiError } from "./api";
import type { Snapshot } from "./TaskSnapshots";

type Profile = { id: string; repository_id: string; name: string; config: { steps: { tool: string; args: string[]; timeoutSeconds: number }[] } };
type Validation = { id: string; snapshot_id: string; profile_name: string; requested_by: string; status: string; stop_requested: boolean; manifest_hash: string; worktree_commit: string | null; error_code: string | null };
const names: Record<string, string> = { queued: "验证排队中", running: "正在执行验证", passed: "指定检查通过", failed: "检查未通过", cancelled: "验证已停止", revoked: "验证权限已变化", unknown: "验证结果待核查" };
const errors: Record<string, string> = { validation_timeout: "命令超时。", validation_nonzero_exit: "命令返回非零退出码。", validation_source_changed: "命令修改了快照中的代码，不能认证原版本。",
  validation_resolution_markers_present: "修复快照仍含整行冲突标记，未执行检查。请解决冲突；标记示例需明确转义或编码后再保存新快照。",
  validation_output_limit: "命令输出超过 1 MiB。", validation_descendants_running: "命令退出时仍有子进程运行。", validation_provisioning_failed: "无法完整准备快照或命令环境。",
  authorization_changed: "申请人的权限发生变化。", validation_lease_expired: "执行器租约过期，未自动重跑。", validation_control_lost: "执行时控制连接中断，结果未获认证。" };
export function TaskValidations({ projectId, taskId, userId, role, canRun, snapshots, repositories, requiredProfileId }: {
  projectId: string; taskId: string; userId: string; role: string; canRun: boolean; snapshots: Snapshot[]; repositories: { id: string; name: string }[]; requiredProfileId?: string;
}) {
  const [profiles, setProfiles] = useState<Profile[]>([]), [validations, setValidations] = useState<Validation[]>([]);
  const [snapshotId, setSnapshotId] = useState(""), [selectedProfileId, setProfileId] = useState("");
  const [quickCommand, setQuickCommand] = useState("npm test");
  const profileId = requiredProfileId ?? selectedProfileId;
  const [name, setName] = useState(""), [repositoryId, setRepositoryId] = useState("");
  const [steps, setSteps] = useState([{ tool: "node", args: "--test", timeoutSeconds: 60 }]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [refresh, setRefresh] = useState(0);
  const pending = useRef<{ path: string; body: unknown } | null>(null), [retry, setRetry] = useState(false);
  useEffect(() => {
    let active = true, loading = false;
    const load = async () => {
      if (loading) return; loading = true;
      try {
        const [p, v] = await Promise.all([collabApi<{ profiles: Profile[] }>(`projects/${projectId}/validation-profiles`), collabApi<{ validations: Validation[] }>(`tasks/${taskId}/validations`)]);
        if (active) { setProfiles(p.profiles); setValidations(v.validations); }
      } catch (e) {
        if (active) { setError(e instanceof Error ? e.message : "读取验证记录失败"); if (e instanceof CollabApiError && [401, 403, 404].includes(e.status)) { setProfiles([]); setValidations([]); } }
      } finally { loading = false; }
    };
    void load(); const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [projectId, taskId, refresh]);
  const selected = snapshots.find(s => s.id === snapshotId), choices = profiles.filter(p => p.repository_id === selected?.repository_id);
  async function submit(endpoint: string, body: unknown) {
    if (busy) return; setBusy(true); setError(""); pending.current ??= { path: endpoint, body };
    try { await collabApi(pending.current.path, pending.current.body); pending.current = null; setRetry(false); setRefresh(n => n + 1); }
    catch (e) {
      if (e instanceof CollabApiError && e.status < 500) pending.current = null;
      setRetry(!!pending.current); setError(e instanceof Error ? e.message : "提交失败");
    } finally { setBusy(false); }
  }
  function createProfile(event: FormEvent) {
    event.preventDefault(); void submit(`projects/${projectId}/validation-profiles`, { repositoryId, name, idempotencyKey: crypto.randomUUID(), config: { version: 1,
      steps: steps.map(step => ({ ...step, args: step.args.split("\n") })) } });
  }
  return <section className="collab-snapshots" aria-label="快照验证">
    <div className="collab-section-heading"><div><p className="collab-eyebrow">固定代码版本 · 真实命令证据</p><h2>快照验证</h2></div></div>
    <p className="collab-muted collab-small">在新的独立工作区执行指定检查；容器来源使用单独容器，本机来源使用本机进程。通过只适用于该快照和这份配置；仍需评审与组合验证。安装依赖需列为独立步骤，原工作区和个人环境不会复制。</p>
    {error && <p className="collab-error" role="alert">{error}</p>}
    {retry && <button className="collab-button" disabled={busy} onClick={() => pending.current && void submit(pending.current.path, pending.current.body)}>重试同一验证操作</button>}
    {canRun && <form className="collab-form compact" onSubmit={event => {
      event.preventDefault();
      const body = quickCommand.trim()
        ? { command: quickCommand.trim(), idempotencyKey: crypto.randomUUID() }
        : { profileId, idempotencyKey: crypto.randomUUID() };
      void submit(`snapshots/${snapshotId}/validations`, body);
    }}>
      <label>待验证快照<select aria-label="待验证快照" required value={snapshotId} disabled={busy || retry} onChange={event => { setSnapshotId(event.target.value); setProfileId(""); }}><option value="">选择快照</option>{snapshots.filter(s => s.status === "ready").map(s => <option value={s.id} key={s.id}>{s.note.slice(0, 60)} · {s.id.slice(0, 8)}</option>)}</select></label>
      <label>快速验证命令<input aria-label="快速验证命令" placeholder="例如：npm test、pytest、go test、cargo test" maxLength={500} value={quickCommand} disabled={busy || retry} onChange={e => setQuickCommand(e.target.value)} /><small className="collab-muted">直接输入命令即可运行，无需先创建配置。支持 node/npm、python/pytest、go、cargo、mvn、ruby 等。</small></label>
      <details><summary>或选择已保存的验证配置</summary>
        <label>{requiredProfileId ? "修复必跑配置" : "验证配置"}<select aria-label="验证配置" value={profileId} disabled={busy || retry || !!requiredProfileId || !!quickCommand.trim()} onChange={event => setProfileId(event.target.value)}><option value="">选择此仓库的配置</option>{choices.map(p => <option key={p.id} value={p.id}>{p.name} · {p.id.slice(0, 8)}</option>)}</select></label>
        {choices.find(p => p.id === profileId)?.config.steps.map((step, index) => <p className="collab-small collab-prewrap" key={index}>{index + 1}. {step.tool} {step.args.map(arg => JSON.stringify(arg)).join(" ")} · 超时 {step.timeoutSeconds} 秒</p>)}
      </details>
      <button className="collab-button" disabled={busy || retry || !snapshotId || (!quickCommand.trim() && !profileId)}>执行快照验证</button>
    </form>}
    {role === "maintainer" && <details><summary>创建验证配置版本</summary><form className="collab-form compact" onSubmit={createProfile}>
      <p className="collab-muted collab-small">配置保存后不修改，调整命令时创建新版本。本机命令适用于可信项目成员。</p>
      <label>配置名称<input aria-label="验证配置名称" required maxLength={120} value={name} disabled={busy || retry} onChange={e => setName(e.target.value)} /></label>
      <label>配置仓库<select aria-label="验证配置仓库" required value={repositoryId} disabled={busy || retry} onChange={e => setRepositoryId(e.target.value)}><option value="">选择仓库</option>{repositories.map(repo => <option key={repo.id} value={repo.id}>{repo.name}</option>)}</select></label>
      {steps.map((step, index) => <fieldset className="collab-validation-step" key={index}><legend>步骤 {index + 1}</legend>
        <label>工具<select aria-label={`步骤 ${index + 1} 工具`} value={step.tool} disabled={busy || retry} onChange={e => setSteps(values => values.map((value, i) => i === index ? { ...value, tool: e.target.value } : value))}>{["node", "npm", "python", "python3", "pip", "pip3", "pytest", "go", "cargo", "mvn", "gradle", "java", "ruby", "bundle", "php", "composer"].map(t => <option key={t} value={t}>{t}</option>)}</select></label>
        <label>参数（每行一个，无需引号）<textarea aria-label={`步骤 ${index + 1} 参数`} required rows={3} value={step.args} disabled={busy || retry} onChange={e => setSteps(values => values.map((value, i) => i === index ? { ...value, args: e.target.value } : value))} /></label>
        <label>超时秒数<input aria-label={`步骤 ${index + 1} 超时`} type="number" min={1} max={600} required value={step.timeoutSeconds} disabled={busy || retry} onChange={e => setSteps(values => values.map((value, i) => i === index ? { ...value, timeoutSeconds: Number(e.target.value) } : value))} /></label>
      </fieldset>)}
      <div className="collab-form-actions"><button className="collab-button" type="button" disabled={busy || retry || steps.length >= 5} onClick={() => setSteps(values => [...values, { tool: "npm", args: "test", timeoutSeconds: 60 }])}>增加步骤</button><button className="collab-button" type="button" disabled={busy || retry || steps.length <= 1} onClick={() => setSteps(values => values.slice(0, -1))}>移除末尾步骤</button><button className="collab-button" disabled={busy || retry}>保存验证配置</button></div>
    </form></details>}
    {!validations.length && <p className="collab-muted">尚无命令验证记录。</p>}
    {validations.map(v => <article key={v.id} className="collab-snapshot-card"><div className="collab-snapshot-heading"><strong role="status">{names[v.status]}</strong><span>{v.profile_name}</span></div>
      <p className="collab-small collab-muted">快照 {v.snapshot_id.slice(0, 8)} · 清单 {v.manifest_hash.slice(0, 12)}{v.worktree_commit && ` · 工作代码 ${v.worktree_commit.slice(0, 12)}`}</p>
      {v.error_code && <p className="collab-muted">{errors[v.error_code] ?? "无法确认完整检查结果，请检查验证证据。"}</p>}
      {v.status === "unknown" && <p className="collab-muted">保留验证工作区，等待本机管理员核查进程和外部影响；当前不会自动重新执行或解除占用。</p>}
      {v.stop_requested && v.status === "running" && <p role="status">停止请求已接纳，正在确认进程退出。</p>}
      {["queued", "running"].includes(v.status) && (role === "maintainer" || (canRun && v.requested_by === userId)) && <button className="collab-button" disabled={busy || retry || v.stop_requested} onClick={() => void submit(`validations/${v.id}/stop`, {})}>停止验证</button>}
      <a className="collab-text-button" href={`/api/collab/validations/${v.id}`} download={`validation-${v.id}.json`}>下载验证证据</a>
    </article>)}
    <p className="collab-muted collab-small">证据包含命令、环境指纹、退出码及有限输出的哈希；不保存原始输出。快照排除项仍不属于本次验证范围。</p>
  </section>;
}
