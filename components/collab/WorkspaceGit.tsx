"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { workspaceGitInput, workspaceGitActionInput, type WorkspaceGitInput, type WorkspaceStageSelection } from "@/lib/collab/git/workspace-schema";
import type { WorkspaceGitState, WorkspaceGitPreview, WorkspaceGitFile } from "@/lib/collab/git/workspace-preview";
import { collabApi, CollabApiError } from "./api";

const pendingSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("write"), body: workspaceGitInput }).strict(),
  z.object({ type: z.literal("action"), jobId: z.uuid(), body: workspaceGitActionInput }).strict(),
]);
type Pending = z.infer<typeof pendingSchema>;
const labels = { queued: "等待 Git 服务", running: "Git 操作处理中", attention: "结果待核查 · 工作区仍占用", applied: "操作已应用", aborted: "操作未应用" };
const failureText = (code: string | null) => code?.includes("stale") || code?.includes("hunk") ? "代码版本或片段已经变化，请重新读取差异。"
  : code?.includes("authority") ? "原请求的成员权限或任务版本已经变化。"
    : "请检查原操作记录与工作区状态。未知结果不会自动重试。";

export function WorkspaceGit({ runId, userId }: { runId: string; userId: string }) {
  const [state, setState] = useState<WorkspaceGitState | null>(null), [preview, setPreview] = useState<WorkspaceGitPreview | null>(null);
  const [file, setFile] = useState<WorkspaceGitFile | null>(null), [selections, setSelections] = useState<WorkspaceStageSelection[]>([]);
  const [reviewed, setReviewed] = useState<string[]>([]), [message, setMessage] = useState("");
  const [ackSelection, setAckSelection] = useState(false), [ackCommit, setAckCommit] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null), [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [reasons, setReasons] = useState<Record<string, string>>({});
  const alive = useRef(true), epoch = useRef(0), latest = useRef(0), submitting = useRef(false);
  const storageKey = `pi-collab:git-request:${userId}:${runId}`;
  const retireReads = useCallback(() => { epoch.current++; latest.current++; }, []);
  const invalidate = useCallback(() => {
    epoch.current++; setPreview(null); setFile(null); setSelections([]); setReviewed([]); setAckSelection(false); setAckCommit(false);
  }, []);
  const refresh = useCallback(async () => {
    const id = ++latest.current;
    try {
      const next = await collabApi<WorkspaceGitState>(`runs/${runId}/git`);
      if (!alive.current || id !== latest.current) return;
      setState(next);
      if (!next.available || next.occupied) invalidate();
    } catch (e) {
      if (alive.current && id === latest.current) { setState(null); invalidate(); setError(e instanceof Error ? e.message : "无法读取 Git 状态"); }
    }
  }, [runId, invalidate]);
  useEffect(() => {
    alive.current = true;
    try { const raw = sessionStorage.getItem(storageKey); setPending(raw ? pendingSchema.parse(JSON.parse(raw)) : null); }
    catch { setError("无法读取本窗口的原请求。请先核查下方持久记录，再重新操作。"); }
    setLoaded(true); void refresh();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 3000);
    return () => { alive.current = false; retireReads(); clearInterval(timer); };
  }, [storageKey, refresh, retireReads]);
  async function readPreview() {
    const ticket = ++epoch.current; setBusy(true); setError(""); setNotice("");
    setPreview(null); setFile(null); setSelections([]); setReviewed([]); setAckSelection(false); setAckCommit(false);
    try { const value = await collabApi<WorkspaceGitPreview>(`runs/${runId}/git/preview`); if (alive.current && epoch.current === ticket) setPreview(value); }
    catch (e) { if (alive.current && epoch.current === ticket) setError(e instanceof Error ? e.message : "读取差异失败"); }
    finally { setBusy(false); }
  }
  async function readFile(layer: "staged" | "working", path: string) {
    if (!preview || busy) return; const ticket = epoch.current; setBusy(true); setError(""); setFile(null);
    try {
      const query = new URLSearchParams({ revision: preview.revision, layer, path });
      const value = await collabApi<WorkspaceGitFile>(`runs/${runId}/git/file?${query}`);
      if (alive.current && epoch.current === ticket) setFile(value);
    } catch (e) {
      if (alive.current && epoch.current === ticket) {
        if (e instanceof CollabApiError && [401, 403, 404, 409].includes(e.status)) invalidate();
        setError(e instanceof Error ? e.message : "读取文件失败");
      }
    } finally { setBusy(false); }
  }
  async function submit(value: Pending) {
    if (submitting.current || !state?.canWrite || !loaded) return;
    const fixed = pending ?? pendingSchema.parse(value);
    // Persist the exact retry payload before sending. Reloading cannot replace
    // an uncertain request with a fresh ID or changed selection/message.
    try { sessionStorage.setItem(storageKey, JSON.stringify(fixed)); }
    catch { setError("无法保存原请求编号，尚未发送。请允许本窗口会话存储后重试。"); return; }
    submitting.current = true; setPending(fixed); setBusy(true); setError(""); setNotice("");
    try {
      await collabApi(fixed.type === "write" ? `runs/${runId}/git` : `workspace-git/${fixed.jobId}/actions`, fixed.body);
      sessionStorage.removeItem(storageKey);
      if (alive.current) { setPending(null); invalidate(); setNotice("请求已接纳。请等待下方操作记录确认，然后重新读取差异。"); }
    } catch (e) {
      if (e instanceof CollabApiError && e.status < 500) {
        sessionStorage.removeItem(storageKey); if (alive.current) { setPending(null); invalidate(); }
      }
      if (alive.current) setError(e instanceof Error ? e.message : "响应尚未确认，请重试同一 Git 请求");
    } finally { submitting.current = false; setBusy(false); if (alive.current) await refresh(); }
  }
  const canWrite = !!state?.canWrite && !!preview?.canWrite && !state.occupied && state.available && state.runRevision === preview.runRevision;
  const disabled = busy || !!pending || !loaded || !canWrite;
  function select(path: string, direction: "stage" | "unstage", hunks: "file" | string[]) {
    setAckSelection(false); setAckCommit(false);
    setSelections(previous => [...previous.filter(item => item.path !== path), ...(hunks !== "file" && !hunks.length ? [] : [{ path, direction, hunks }])]);
  }
  const staged = preview?.files.filter(item => item.staged) ?? [], allReviewed = staged.length > 0 && staged.every(item => reviewed.includes(item.path));
  const write = (data: { kind: "stage"; selections: WorkspaceStageSelection[] } | { kind: "commit"; message: string }) => {
    if (!preview) return;
    const body: WorkspaceGitInput = { ...data, revision: preview.revision, expectedRunRevision: preview.runRevision, acknowledge: true, idempotencyKey: crypto.randomUUID() };
    void submit({ type: "write", body });
  };
  return <section className="collab-workspace-git" aria-label="工作区 Git">
    <div className="collab-section-heading"><div><p className="collab-eyebrow">检查草稿 · 选择暂存 · 确认提交</p><h2>工作区 Git</h2></div><button className="collab-text-button" onClick={() => void refresh()}>刷新 Git 记录</button></div>
    <p className="collab-small collab-muted">运行停止后检查本次独立工作区。暂存保留未选择的草稿；提交仅包含已暂存内容。这里创建本地任务分支提交。已关联 GitHub 的仓库可在“任务推送预览”中审阅并另行确认发送。</p>
    {error && <p role="alert" className="collab-error">{error}</p>}{notice && <p role="status" className="collab-muted">{notice}</p>}
    {pending && <div className="collab-form compact"><p>上次请求尚未确认。本窗口已保留原编号与内容，刷新后仍可重试。</p><button className="collab-button" disabled={busy || !state?.canWrite} onClick={() => void submit(pending)}>重试同一 Git 请求</button></div>}
    {state && !state.available && <p className="collab-muted">需要已停止且尚未归档的工作区。</p>}
    {state?.occupied && <p role="status" className="collab-muted">工作区已被原 Git 操作占用，确认退出前不能开始另一项写入。</p>}
    <button className="collab-button" disabled={busy || !!pending || !state?.available || state.occupied} onClick={() => void readPreview()}>读取 Git 差异</button>
    {preview && <>
      <p className="collab-small collab-git-identity">分支 {preview.branch}<br/>HEAD {preview.head}<br/>暂存树 {preview.indexTree}<br/>检查版本 {preview.revision}</p>
      <p className="collab-muted collab-small">按原始字节暂存，不执行 Git filter、换行或编码转换。工作文件、索引或 HEAD 变化后，旧选择失效。</p>
      <div className="collab-git-columns">{(["working", "staged"] as const).map(layer => <div key={layer}><h3>{layer === "working" ? "工作文件" : "已暂存内容"}</h3>
        {preview.files.filter(item => item[layer]).map(item => {
          const direction = layer === "working" ? "stage" : "unstage", selection = selections.find(s => s.path === item.path && s.direction === direction);
          return <div className="collab-git-file-row" key={item.path}>
            <button className="collab-text-button" disabled={busy || item.excluded} onClick={() => void readFile(layer, item.path)} aria-label={`${layer === "working" ? "工作文件" : "暂存文件"} ${item.path}`}>{item.path}{layer === "staged" && reviewed.includes(item.path) ? " · 已核对" : ""}</button>
            {item.excluded && <span className="collab-muted collab-small">内容已排除，阻止提交；可恢复 HEAD 中的索引引用。</span>}
            {state?.canWrite && <label className="collab-git-check"><input type="checkbox" aria-label={`${direction === "stage" ? "暂存整文件" : "取消暂存整文件"} ${item.path}`} disabled={disabled} checked={selection?.hunks === "file"} onChange={e => select(item.path, direction, e.target.checked ? "file" : [])}/>{direction === "stage" ? "整文件暂存" : "整文件取消暂存"}</label>}
            {selection && selection.hunks !== "file" && <small>已选 {selection.hunks.length} 个片段</small>}
          </div>;
        })}
        {!preview.files.some(item => item[layer]) && <p className="collab-muted collab-small">没有变更</p>}
      </div>)}</div>
      {!!preview.exclusions.length && <details><summary>排除清单（{preview.exclusions.length} 项）</summary>{preview.exclusions.map((item, i) => <p className="collab-small" key={`${item.path}:${i}`}>{item.path} · {item.reason}</p>)}</details>}
      {file && <article className="collab-git-code" aria-label={`Git 文件 ${file.path}`}>
        <h3>{file.layer === "working" ? "索引 → 工作文件" : "HEAD → 索引"} · {file.path}</h3>
        {file.omitted && <p className="collab-muted">此文件包含二进制、非 UTF-8 编码或超出文本展示限制的内容。下面只显示可展示内容及字节摘要，不代表已检查全部内容；不能按片段选择。</p>}
        <div className="collab-git-columns">{(["before", "after"] as const).map(side => <div key={side}><strong>{side === "before" ? "变更前" : "变更后"}</strong>
          {file[side] ? <><p className="collab-small collab-git-identity">模式 {file[side].mode} · {file[side].size} 字节<br/>SHA-256 {file[side].hash}<br/>LF {file[side].lineEndings.lf} / CRLF {file[side].lineEndings.crlf} · {file[side].trailingNewline ? "有末尾换行" : "无末尾换行"}</p><details><summary>{side === "before" ? "查看完整旧文本" : "查看完整新文本"}</summary>{file[side].text !== null ? <pre>{file[side].text}</pre> : <p className="collab-muted">无法完整展示文本，请按字节摘要在外部核对。</p>}</details></> : <p className="collab-muted">此侧不存在</p>}
        </div>)}</div>
        {!!file.hunks.length && <p className="collab-small collab-muted">全部差异片段（{file.hunks.length}）；特殊控制字符以 U+ 标记显示。</p>}
        {file.hunks.map((hunk, i) => {
          const direction = file.layer === "working" ? "stage" : "unstage", current = selections.find(item => item.path === file.path && item.direction === direction), chosen = current?.hunks;
          return <div key={hunk.id}>{file.partial && state?.canWrite && <label className="collab-git-check"><input type="checkbox" aria-label={`${direction === "stage" ? "暂存" : "取消暂存"}片段 ${i + 1}`} disabled={disabled} checked={chosen === "file" || !!chosen?.includes(hunk.id)} onChange={e => select(file.path, direction, e.target.checked ? [...(chosen === "file" ? [] : chosen ?? []), hunk.id] : (chosen === "file" ? file.hunks.map(h => h.id) : chosen ?? []).filter(id => id !== hunk.id))}/>{direction === "stage" ? "暂存" : "取消暂存"}片段 {i + 1}</label>}<pre>{hunk.lines.map((line, j) => <span key={j} className={`collab-git-line ${line.kind}`}>{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}{line.text}{"\n"}</span>)}</pre></div>;
        })}
        {file.layer === "staged" && <label className="collab-git-check"><input type="checkbox" aria-label={`已核对暂存文件 ${file.path}`} checked={reviewed.includes(file.path)} disabled={busy || !!pending} onChange={e => { setReviewed(previous => e.target.checked ? [...new Set([...previous, file.path])] : previous.filter(path => path !== file.path)); setAckCommit(false); }}/>{file.omitted ? "我已在外部核对该文件的完整内容及上述字节摘要" : "我已核对该文件的完整暂存差异、模式与换行"}</label>}
      </article>}
      {state?.canWrite && <div className="collab-git-columns">
        <form className="collab-form compact" onSubmit={e => { e.preventDefault(); if (!disabled && ackSelection && selections.length) write({ kind: "stage", selections }); }}>
          <h3>应用暂存选择</h3><p className="collab-small">已选择 {selections.length} 个文件；每次最多 200 个。</p>
          {selections.map(item => <p className="collab-small" key={item.path}>{item.path} · {item.direction === "stage" ? "暂存" : "取消暂存"} · {item.hunks === "file" ? "整文件" : `${item.hunks.length} 个片段`}</p>)}
          <label className="collab-git-check"><input type="checkbox" aria-label="确认本次暂存选择" checked={ackSelection} disabled={disabled || !selections.length} onChange={e => setAckSelection(e.target.checked)}/>确认上述选择及原始字节暂存规则</label>
          <button className="collab-button" disabled={disabled || !ackSelection || !selections.length || selections.length > 200}>应用暂存选择</button>
        </form>
        <form className="collab-form compact" onSubmit={e => { e.preventDefault(); if (!disabled && ackCommit && allReviewed && !preview.commitBlockedPaths.length && !selections.length) write({ kind: "commit", message }); }}>
          <h3>确认本地提交</h3><p className="collab-small">已核对 {reviewed.length} / {staged.length} 个暂存文件。提交作者使用当前登录成员，记录 AI 工作区来源；时间以接纳记录为准，无签名声明。</p>
          {!!preview.commitBlockedPaths.length && <p className="collab-error">存在被排除的暂存内容，请先取消其暂存后重新检查。</p>}
          <label>提交说明<textarea aria-label="Git 提交说明" required maxLength={8000} rows={3} disabled={disabled} value={message} onChange={e => { setMessage(e.target.value); setAckCommit(false); }}/></label>
          <label className="collab-git-check"><input type="checkbox" aria-label="确认全部暂存内容与提交说明" checked={ackCommit} disabled={disabled || !allReviewed || !message.trim() || !!selections.length || !!preview.commitBlockedPaths.length} onChange={e => setAckCommit(e.target.checked)}/>确认全部暂存内容与提交说明</label>
          <button className="collab-button primary" disabled={disabled || !ackCommit || !allReviewed || !message.trim() || !!selections.length || !!preview.commitBlockedPaths.length}>提交已暂存内容</button>
        </form>
      </div>}
    </>}
    <h3>最近 50 项 Git 操作</h3>
    {state?.operations.map(item => <article className="collab-snapshot-card" key={item.jobId} aria-label={`Git 操作 ${item.jobId}`}>
      <strong>{item.kind === "commit" ? "本地提交" : "暂存选择"}</strong><p role="status">{item.mode === "reconcile" && ["queued", "running"].includes(item.status) ? "原操作核查中" : labels[item.status]}{item.stopRequested && ["queued", "running"].includes(item.status) ? " · 已请求取消" : ""}</p>
      <p className="collab-small collab-git-identity">{item.jobId} · {new Date(item.createdAt).toLocaleString()}{item.effect?.commit && <><br/>提交 {item.effect.commit}</>}</p>
      {item.failure && <p className="collab-muted collab-small">{failureText(item.failure)}</p>}
      {state.canWrite && !["applied", "aborted"].includes(item.status) && <form className="collab-form compact" onSubmit={e => {
        e.preventDefault(); void submit({ type: "action", jobId: item.jobId, body: { action: item.status === "attention" ? "reconcile" : "cancel", reason: reasons[item.jobId] ?? "", idempotencyKey: crypto.randomUUID() } });
      }}><label>处理原因<textarea aria-label="Git 操作处理原因" required minLength={10} maxLength={2000} disabled={busy || !!pending} value={reasons[item.jobId] ?? ""} onChange={e => setReasons({ ...reasons, [item.jobId]: e.target.value })}/></label>
        <button className="collab-button" disabled={busy || !!pending || (item.stopRequested && item.status !== "attention")}>{item.status === "attention" ? "核查原 Git 操作" : "取消 Git 操作"}</button>
        <p className="collab-small collab-muted">取消不撤回已经应用的修改。核查观察原结果，不重复提交；证据不足或锁残留时仍保留占用。</p>
      </form>}
    </article>)}
  </section>;
}
