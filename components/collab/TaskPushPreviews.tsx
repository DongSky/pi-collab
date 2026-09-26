"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { codeDisplayText } from "@/lib/collab/integration-code-schema";
import { pushPreviewRequest, pushPreviewCancel, type PushPreviewRecord, type PushPreviewDetail, type PushHistoryPage,
  type PushHistoryChanges, type PushHistoryFile } from "@/lib/collab/git/push-preview-schema";
import type { WorkspaceGitState, WorkspaceGitPreview } from "@/lib/collab/git/workspace-preview";
import { collabApi, CollabApiError } from "./api";
import { TaskPushConfirmation } from "./TaskPushConfirmation";

const pendingSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("prepare"), body: pushPreviewRequest }).strict(),
  z.object({ type: z.literal("cancel"), previewId: z.uuid(), body: pushPreviewCancel }).strict(),
]);
type Pending = z.infer<typeof pendingSchema>;
const labels = { queued: "等待生成预览", running: "正在生成出站历史", ready: "出站历史已固定", failed: "预览未完成", cancelled: "预览已取消" };
const failure = (code: string | null) => code?.includes("authority") ? "成员权限、任务或仓库关联已经变化，请重新检查。"
  : code?.includes("secret") || code?.includes("excluded") ? "新增历史含排除或疑似敏感内容，请检查全部本地提交后重新生成。"
    : "原请求不会自动重做。请核对源提交、远端关联及导出限制，再明确生成新的预览。";

export function TaskPushPreviews({ runId, userId }: { runId: string; userId: string }) {
  const [records, setRecords] = useState<PushPreviewRecord[]>([]), [state, setState] = useState<WorkspaceGitState | null>(null);
  const [selected, setSelected] = useState<PushPreviewDetail | null>(null), [pending, setPending] = useState<Pending | null>(null);
  const [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const alive = useRef(true), reads = useRef(0), updates = useRef(0), submitting = useRef(false);
  const retire = useCallback(() => { reads.current++; updates.current++; }, []);
  const storageKey = `pi-collab:push-preview-request:${userId}:${runId}`;
  const refresh = useCallback(async () => {
    const ticket = ++updates.current;
    try {
      const [items, current] = await Promise.all([collabApi<{ previews: PushPreviewRecord[] }>(`runs/${runId}/push-previews`), collabApi<WorkspaceGitState>(`runs/${runId}/git`)]);
      if (alive.current && ticket === updates.current) { setRecords(items.previews); setState(current); }
    } catch (e) {
      if (alive.current && ticket === updates.current) { reads.current++; setRecords([]); setState(null); setSelected(null); setError(e instanceof Error ? e.message : "无法读取推送预览"); }
    }
  }, [runId]);
  useEffect(() => {
    alive.current = true;
    try { const raw = sessionStorage.getItem(storageKey); setPending(raw ? pendingSchema.parse(JSON.parse(raw)) : null); }
    catch { setError("无法恢复本窗口原请求，请先检查已有预览记录。"); }
    setLoaded(true); void refresh();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 3000);
    return () => { alive.current = false; retire(); clearInterval(timer); };
  }, [storageKey, refresh, retire]);
  async function submit(value: Pending) {
    if (submitting.current || !state?.canWrite || !loaded) return;
    const fixed = pending ?? pendingSchema.parse(value);
    try { sessionStorage.setItem(storageKey, JSON.stringify(fixed)); }
    catch { setError("无法保存原请求编号，尚未发送，请允许本窗口会话存储后重试。"); return; }
    submitting.current = true; reads.current++; setPending(fixed); setBusy(true); setError("");
    try {
      await collabApi(fixed.type === "prepare" ? `runs/${runId}/push-previews` : `push-previews/${fixed.previewId}/cancel`, fixed.body);
      sessionStorage.removeItem(storageKey); if (alive.current) setPending(null);
    } catch (e) {
      if (e instanceof CollabApiError && e.status < 500) { sessionStorage.removeItem(storageKey); if (alive.current) setPending(null); }
      if (alive.current) setError(e instanceof Error ? e.message : "尚未确认响应，请重试同一预览请求");
    } finally { submitting.current = false; setBusy(false); if (alive.current) await refresh(); }
  }
  async function prepare() {
    if (busy || pending || !state?.canWrite || !state.available || state.occupied) return;
    const ticket = ++reads.current; setBusy(true); setError("");
    try {
      const source = await collabApi<WorkspaceGitPreview>(`runs/${runId}/git/preview`);
      if (!alive.current || ticket !== reads.current) return;
      await submit({ type: "prepare", body: { idempotencyKey: crypto.randomUUID(), revision: source.revision, head: source.head, expectedRunRevision: source.runRevision } });
    } catch (e) { if (alive.current && ticket === reads.current) setError(e instanceof Error ? e.message : "无法读取源提交"); }
    finally { setBusy(false); }
  }
  async function open(id: string) {
    const ticket = ++reads.current; setSelected(null); setBusy(true); setError("");
    try { const value = await collabApi<PushPreviewDetail>(`push-previews/${id}`); if (alive.current && ticket === reads.current) setSelected(value); }
    catch (e) { if (alive.current && ticket === reads.current) setError(e instanceof Error ? e.message : "读取原预览失败"); }
    finally { setBusy(false); }
  }
  return <section className="collab-workspace-git" aria-label="任务推送预览">
    <div className="collab-section-heading"><div><p className="collab-eyebrow">固定出站历史 · 逐提交审阅</p><h2>任务推送预览</h2></div><button className="collab-text-button" onClick={() => void refresh()}>刷新推送预览</button></div>
    <p className="collab-small collab-muted">从已停止的工作区生成全部新增提交的固定副本，包含中间提交与合并支线。保留未提交草稿。可审阅、下载并保存完整确认，确认后须单独请求发送。</p>
    {error && <p role="alert" className="collab-error">{error}</p>}
    {pending && <div className="collab-form compact"><p>上次预览请求尚未确认，本窗口已保留原编号与内容。</p><button className="collab-button" disabled={busy || !state?.canWrite} onClick={() => void submit(pending)}>重试同一预览请求</button></div>}
    {state?.canWrite && <button className="collab-button" disabled={busy || !!pending || !loaded || !state.available || state.occupied} onClick={() => void prepare()}>生成推送预览</button>}
    {state?.occupied && <p className="collab-muted collab-small">工作区已有操作占用，待其完成后才能生成新预览。</p>}
    <h3>最近 50 项预览</h3>
    {!records.length && <p className="collab-muted">尚无推送预览。生成预览需要有效的 GitHub 仓库关联。</p>}
    {records.map(item => <article key={item.jobId} className="collab-snapshot-card" aria-label={`推送预览 ${item.jobId}`}>
      <p role="status">{labels[item.status]}{item.stopRequested && ["queued", "running"].includes(item.status) ? " · 已请求取消" : ""}</p>
      <p className="collab-small collab-git-identity">{item.jobId}<br/>源提交 {item.head}<br/>{new Date(item.createdAt).toLocaleString()}{item.commitCount !== null && ` · ${item.commitCount} 个新增提交`}</p>
      {item.failure && <p className="collab-muted collab-small">{failure(item.failure)}</p>}
      {item.status === "ready" && <button className="collab-button" disabled={busy} onClick={() => void open(item.jobId)}>审阅全部出站历史</button>}
      {state?.canWrite && ["queued", "running"].includes(item.status) && <form className="collab-form compact" onSubmit={e => { e.preventDefault(); void submit({ type: "cancel", previewId: item.jobId, body: { idempotencyKey: crypto.randomUUID(), reason: reasons[item.jobId] ?? "" } }); }}>
        <label>取消原因<textarea aria-label="推送预览取消原因" required minLength={10} maxLength={2000} disabled={busy || !!pending} value={reasons[item.jobId] ?? ""} onChange={e => setReasons({ ...reasons, [item.jobId]: e.target.value })}/></label>
        <button className="collab-button" disabled={busy || !!pending || item.stopRequested}>取消生成预览</button>
      </form>}
    </article>)}
    {selected?.status === "ready" && selected.manifestHash && <PushHistoryView key={`${selected.jobId}:${selected.manifestHash}`} preview={selected} userId={userId} />}
  </section>;
}

function PushHistoryView({ preview, userId }: { preview: PushPreviewDetail; userId: string }) {
  const [history, setHistory] = useState<PushHistoryPage | null>(null), [changes, setChanges] = useState<PushHistoryChanges | null>(null);
  const [file, setFile] = useState<PushHistoryFile | null>(null), [reviewed, setReviewed] = useState<string[]>([]);
  const [metadataSeen, setMetadataSeen] = useState<string[]>([]), [commitsReviewed, setCommitsReviewed] = useState<string[]>([]), [externalReviews, setExternalReviews] = useState<string[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [retry, setRetry] = useState(0);
  const alive = useRef(true), ticket = useRef(0), requests = useRef<AbortController | null>(null);
  const retire = useCallback(() => { ticket.current++; }, []);
  const base = `push-previews/${preview.jobId}`;
  const read = useCallback(async <T,>(parameters: Record<string, string>, endpoint = "history", external?: AbortSignal): Promise<T> => {
    const signal = external ?? requests.current?.signal;
    // Readers share a bounded server pool. Strict Mode and concurrent members
    // may briefly exhaust it; only these side-effect-free GETs retry a 429.
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      try { return await collabApi<T>(`${base}/${endpoint}?${new URLSearchParams({ manifestHash: preview.manifestHash!, ...parameters })}`, undefined, undefined, signal); }
      catch (e) {
        if (!(e instanceof CollabApiError) || e.status !== 429 || attempt >= 5) throw e;
        await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
  }, [base, preview.manifestHash]);
  useEffect(() => {
    alive.current = true; const current = ++ticket.current, controller = new AbortController(); requests.current = controller;
    void read<PushHistoryPage>({ kind: "commits" }, "history", controller.signal).then(value => { if (alive.current && ticket.current === current) setHistory(value); }).catch(e => { if (alive.current && ticket.current === current) setError(e instanceof Error ? e.message : "无法读取出站历史"); });
    return () => { alive.current = false; controller.abort(); retire(); };
  }, [read, retire, retry]);
  async function act(work: () => Promise<void>) {
    if (busy) return; setBusy(true); setError("");
    try { await work(); }
    catch (e) {
      if (alive.current) { setError(e instanceof Error ? e.message : "读取失败"); if (e instanceof CollabApiError && [401, 403, 404, 409].includes(e.status)) { setHistory(null); setChanges(null); setFile(null); setReviewed([]); setMetadataSeen([]); setCommitsReviewed([]); setExternalReviews([]); } }
    } finally { setBusy(false); }
  }
  async function download(parameters: Record<string, string>) {
    await act(async () => {
      const result = await read<{ filename: string; bytesBase64: string; hash: string; size: number }>(parameters, "download");
      if (!alive.current) return;
      const bytes = Uint8Array.from(atob(result.bytesBase64), char => char.charCodeAt(0));
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).map(value => value.toString(16).padStart(2, "0")).join("");
      if (bytes.length !== result.size || hash !== result.hash) throw new Error("下载字节校验失败，请重新读取。");
      if (!alive.current) return;
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" })), link = document.createElement("a");
      link.href = url; link.download = result.filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      if (parameters.kind === "commit") setMetadataSeen(old => [...new Set([...old, parameters.commit])]);
    });
  }
  const fileKey = file ? `${file.commit}:${file.fileHash}` : "";
  const reviewedFiles = (commit: string) => reviewed.filter(key => key.startsWith(`${commit}:`)).length;
  const complete = !!history && history.commits.length === history.total && history.commits.every(commit => commitsReviewed.includes(commit.oid)
    && metadataSeen.includes(commit.oid) && reviewedFiles(commit.oid) === commit.changedPaths);
  return <article className="collab-git-code" aria-label="完整出站历史">
    <h3>固定出站历史</h3>
    <p className="collab-small collab-git-identity">仓库 {preview.binding.ownerLogin}/{preview.binding.name} · {preview.binding.visibility}<br/>导出 {preview.manifestHash}</p>
    {error && <p className="collab-error" role="alert">{error}</p>}
    {error && !history && <button className="collab-button" disabled={busy} onClick={() => { setError(""); setRetry(value => value + 1); }}>重新读取出站历史</button>}
    {history && <>
      <p className="collab-small collab-git-identity">目标 {history.identity.ref}<br/>远端任务旧提交 {history.identity.expectedOld ?? "尚不存在"}<br/>本次新提交 {history.identity.head}<br/>已核验远端默认基线 {history.identity.baseline}</p>
      <p className="collab-muted collab-small">每个提交均与此次远端默认基线比较，包含所有新增历史；不是只看最终提交，也不是各提交与第一父节点的差异。未提交草稿不在此导出中。</p>
      <h4>新增提交：已加载 {history.commits.length} / {history.total}</h4>
      {history.commits.map(commit => <article className="collab-snapshot-card" key={commit.oid} aria-label={`出站提交 ${commit.oid}`}>
        <p className="collab-small collab-git-identity">{commit.oid}<br/>父提交 {commit.parents.join(" · ")}<br/>{commit.changedPaths} 个变更路径 · {commit.size} 字节 · SHA-256 {commit.hash}</p>
        {commit.text !== null ? <details onToggle={e => { if (e.currentTarget.open) setMetadataSeen(old => [...new Set([...old, commit.oid])]); }}><summary>完整提交元数据与说明</summary><pre>{commit.text}</pre></details> : <p className="collab-muted">提交元数据超出文本展示限制，请下载完整原始字节核对。</p>}
        <button className="collab-text-button" disabled={busy} onClick={() => void download({ kind: "commit", commit: commit.oid })}>下载提交原始字节</button>
        <button className="collab-button" disabled={busy} onClick={() => void act(async () => { const value = await read<PushHistoryChanges>({ kind: "changes", commit: commit.oid }); if (alive.current) { setChanges(value); setFile(null); } })}>查看本提交全部变更</button>
        <label className="collab-git-check"><input type="checkbox" aria-label={`确认提交 ${commit.oid}`} disabled={busy || !metadataSeen.includes(commit.oid) || reviewedFiles(commit.oid) !== commit.changedPaths}
          checked={commitsReviewed.includes(commit.oid)} onChange={e => setCommitsReviewed(old => e.target.checked ? [...new Set([...old, commit.oid])] : old.filter(id => id !== commit.oid))}/>已核对此提交说明、父关系与全部 {commit.changedPaths} 个文件版本（已标记 {reviewedFiles(commit.oid)}）</label>
      </article>)}
      {history.nextOffset !== null && <button className="collab-button" disabled={busy} onClick={() => void act(async () => { const next = await read<PushHistoryPage>({ kind: "commits", offset: String(history.nextOffset) }); if (alive.current) setHistory({ ...next, commits: [...history.commits, ...next.commits] }); })}>加载更多出站提交</button>}
    </>}
    {changes && <div aria-label="出站提交变更">
      <h4>提交 {changes.commit.slice(0, 12)} · 已加载 {changes.files.length} / {changes.total} 个路径</h4>
      {!changes.total && <p className="collab-muted">此版本相对远端默认基线没有文件变化；仍须核对提交说明及父关系。</p>}
      {changes.files.map(item => <div className="collab-git-file-row" key={item.path}><button className="collab-text-button" disabled={busy} onClick={() => void act(async () => { const value = await read<PushHistoryFile>({ kind: "file", commit: changes.commit, path: item.path }); if (alive.current) setFile(value); })}>{codeDisplayText(item.path)} · {item.kind === "added" ? "新增" : item.kind === "deleted" ? "删除" : "修改"}</button>{item.omitted && <span className="collab-muted collab-small">排除内容，只提供变更标识</span>}</div>)}
      {changes.nextOffset !== null && <button className="collab-button" disabled={busy} onClick={() => void act(async () => { const next = await read<PushHistoryChanges>({ kind: "changes", commit: changes.commit, offset: String(changes.nextOffset) }); if (alive.current) setChanges({ ...next, files: [...changes.files, ...next.files] }); })}>加载更多变更路径</button>}
    </div>}
    {file && <article aria-label="出站文件内容"><h4>{codeDisplayText(file.file.path)}</h4>
      <p className="collab-small collab-git-identity">提交 {file.commit}<br/>文件审阅版本 {file.fileHash}</p>
      {file.omitted && <p className="collab-muted">部分内容因排除策略、敏感内容、编码或大小限制未在页面展示。可下载项须核对完整原始字节；无法下载的内容不能视为已完整展示。</p>}
      <div className="collab-git-columns">{(["before", "after"] as const).map(side => <div key={side}><strong>{side === "before" ? "远端默认基线版本" : "此提交版本"}</strong>
        {file[side] ? <><p className="collab-small collab-git-identity">模式 {file[side].mode} · {file[side].size} 字节<br/>SHA-256 {file[side].hash ?? "超出读取限制"}{file[side].hash && <><br/>LF 字节 {file[side].lineEndings.lf} / CRLF 字节对 {file[side].lineEndings.crlf} · {file[side].trailingNewline ? "有末尾换行" : "无末尾换行"}</>}</p>
          {file[side].text !== null && <details><summary>完整文本</summary><pre>{file[side].text}</pre></details>}
          {file[side].downloadable && <button className="collab-text-button" disabled={busy} onClick={() => void download({ kind: "file", commit: file.commit, path: file.file.path, side })}>{side === "before" ? "下载旧版本字节" : "下载此版本字节"}</button>}</> : <p className="collab-muted">{file.omitted ? "内容已遮蔽或此侧不存在" : "此侧不存在"}</p>}
      </div>)}</div>
      {!!file.lines.length && <pre>{file.lines.map((line, i) => <span key={i} className={`collab-git-line ${line.kind}`}>{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}{line.text}{"\n"}</span>)}</pre>}
      {file.omitted && <label className="collab-git-check"><input type="checkbox" aria-label="确认外部核对或排除范围" disabled={busy} checked={externalReviews.includes(fileKey)} onChange={e => {
        setExternalReviews(old => e.target.checked ? [...new Set([...old, fileKey])] : old.filter(key => key !== fileKey));
        if (!e.target.checked) setReviewed(old => old.filter(key => key !== fileKey));
      }}/>已另行核对可下载的完整原始字节；无法读取的旧内容只确认其删除、排除或展示限制，不声称已查看该内容</label>}
      <label className="collab-git-check"><input type="checkbox" aria-label="本窗口已核对此文件版本" disabled={busy || (!!file.omitted && !externalReviews.includes(fileKey))} checked={reviewed.includes(fileKey)} onChange={e => setReviewed(old => e.target.checked ? [...new Set([...old, fileKey])] : old.filter(key => key !== fileKey))}/>本窗口已核对此文件版本及上述展示限制</label>
    </article>}
    <p className="collab-muted collab-small">本窗口已标记 {reviewed.length} 个文件版本。标记仅帮助审阅，切换预览或刷新后清除，不构成推送授权。</p>
    <TaskPushConfirmation previewId={preview.jobId} userId={userId} manifestHash={preview.manifestHash!} complete={complete} />
  </article>;
}
