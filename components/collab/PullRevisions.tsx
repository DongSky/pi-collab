"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { pullRevisionRequest, pullRevisionCancel, type PullRevisionContext } from "@/lib/collab/git/pull-revision-schema";
import type { RevisionCodePage, RevisionCodeFile } from "@/lib/collab/git/pull-revision-schema";
import { CodeDiscussions } from "./CodeDiscussions";
import { PullRelease } from "./PullRelease";
import { PullChecks } from "./PullChecks";
import { collabApi, CollabApiError } from "./api";
const pendingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("read"), body: pullRevisionRequest }).strict(),
  z.object({ kind: z.literal("cancel"), jobId: z.uuid(), body: pullRevisionCancel }).strict(),
]);
type Pending = z.infer<typeof pendingSchema>;
const statuses = { queued: "等待固定代码下载", running: "正在下载并校验固定代码", ready: "固定 PR 代码已就绪", failed: "固定代码下载失败，历史记录保留", cancelled: "固定代码下载已取消" };
function Code({ id }: { id: string }) {
  const [page, setPage] = useState<RevisionCodePage | null>(null), [file, setFile] = useState<RevisionCodeFile | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [comment,setComment]=useState<{side:"before"|"after";line:number}|null>(null);
  const sequence = useRef(0);
  useEffect(() => () => { sequence.current++; }, [id]);
  async function load(offset = 0, name?: string) {
    const current = ++sequence.current; setBusy(true); setError(""); setFile(null); setComment(null);
    try {
      const route = "pull-revisions/" + id + "/code";
      if (name && page?.record.diffHash) {
        const result = await collabApi<RevisionCodeFile>(route + "/file?" + new URLSearchParams({ path: name, diffHash: page.record.diffHash }));
        if (current === sequence.current) setFile(result);
      } else {
        const result = await collabApi<RevisionCodePage>(route + "?offset=" + offset);
        if (current === sequence.current) setPage(previous => offset && previous ? { ...result, files: [...previous.files, ...result.files] } : result);
      }
    } catch (e) { if (current === sequence.current) { setPage(null); setError(e instanceof Error ? e.message : "代码读取失败"); } }
    finally { if (current === sequence.current) setBusy(false); }
  }
  return <details className="collab-form compact" aria-label="固定 PR 代码差异"><summary>查看固定 PR 代码差异</summary>
    <button className="collab-button" disabled={busy} onClick={() => void load()}>读取固定 PR 文件列表</button>
    {error && <p role="alert" className="collab-error">{error}</p>}
    {page && <><p className="collab-small collab-git-identity">{page.record.current ? "对应最近成功的本地观察" : "历史版本 · 之后已有观察或关联变化"}<br/>共同基线 {page.record.mergeBase}<br/>差异 SHA-256 {page.record.diffHash}<br/>共 {page.total} 个改动路径</p>
      {page.files.map(f => <button className="collab-button secondary" key={f.path} disabled={busy} onClick={() => void load(0, f.path)}>{f.omitted ? "已排除" : !f.before ? "新增" : !f.after ? "删除" : "修改"} · {f.path}</button>)}
      {page.nextOffset !== null && <button className="collab-button" disabled={busy} onClick={() => void load(page.nextOffset!)}>加载更多 PR 文件</button>}
    </>}
    {file && <section aria-label={"PR 代码文件 " + file.path} className="collab-code-browser"><p className="collab-git-identity">{file.path}</p>
      {file.omitted ? <p>未显示内容：{file.omitted}。此路径未完成代码审阅。</p> : <pre aria-label="PR 逐行代码差异" style={{ overflowX: "auto", maxWidth: "100%" }}>{file.lines.map((line, i) => <div key={i}>{line.before!==null&&<button type="button" className="collab-text-button" aria-label={`评论旧侧第 ${line.before} 行`} onClick={()=>setComment({side:"before",line:line.before!})}>{line.before}</button>} {line.after!==null&&<button type="button" className="collab-text-button" aria-label={`评论新侧第 ${line.after} 行`} onClick={()=>setComment({side:"after",line:line.after!})}>{line.after}</button>} {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}{line.text}</div>)}</pre>}
      {comment&&!file.omitted&&<CodeDiscussions key={`${file.path}:${comment.side}:${comment.line}`} kind="pull" sourceId={id} diffHash={file.record.diffHash!} path={file.path} side={comment.side} line={comment.line}/>}
    </section>}
  </details>;
}
export function PullRevisions({ changeId, userId }: { changeId: string; userId: string }) {
  const [context, setContext] = useState<PullRevisionContext | null>(null), [pending, setPending] = useState<Pending | null>(null);
  const [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [reason, setReason] = useState("");
  const alive = useRef(true), writing = useRef(false), sequence = useRef(0), key = "pi-collab:pull-revision:" + userId + ":" + changeId;
  const route = "pull-changes/" + changeId + "/revisions";
  const refresh = useCallback(async () => {
    const current = ++sequence.current;
    try { const value = await collabApi<PullRevisionContext>(route); if (alive.current && current === sequence.current) setContext(value); }
    catch (e) { if (alive.current && current === sequence.current) { setContext(null); setError(e instanceof Error ? e.message : "无法读取 PR 固定代码记录"); } }
  }, [route]);
  useEffect(() => {
    alive.current = true;
    try { const saved = sessionStorage.getItem(key); setPending(saved ? pendingSchema.parse(JSON.parse(saved)) : null); }
    catch { setError("无法恢复原代码下载编号，请核对已有记录。"); }
    setLoaded(true); void refresh();
    const visible = () => { if (!document.hidden) void refresh(); }, timer = setInterval(visible, 3000);
    window.addEventListener("online", visible); document.addEventListener("visibilitychange", visible);
    return () => { alive.current = false; clearInterval(timer); window.removeEventListener("online", visible); document.removeEventListener("visibilitychange", visible); };
  }, [key, refresh]);
  async function submit(value: Pending) {
    if (writing.current || !loaded || !context?.canCancel) return;
    const parsed = pendingSchema.safeParse(pending ?? value);
    if (!parsed.success) { setError("请核对代码版本或取消原因。"); return; }
    const fixed = parsed.data;
    try { sessionStorage.setItem(key, JSON.stringify(fixed)); }
    catch { setError("无法保留原请求编号，尚未提交。请允许本窗口会话存储。"); return; }
    writing.current = true; setBusy(true); setPending(fixed); setError("");
    try {
      await collabApi(fixed.kind === "read" ? route : "pull-revisions/" + fixed.jobId + "/cancel", fixed.body);
      sessionStorage.removeItem(key); if (alive.current) { setPending(null); setReason(""); }
    } catch (e) {
      if (e instanceof CollabApiError && e.status < 500) { sessionStorage.removeItem(key); if (alive.current) setPending(null); }
      if (alive.current) setError(e instanceof Error ? e.message : "响应未知，请重试原代码下载请求");
    } finally { writing.current = false; setBusy(false); if (alive.current) await refresh(); }
  }
  const active = context?.jobs.some(j => ["queued", "running"].includes(j.status));
  return <details className="collab-form compact" aria-label="PR 固定代码版本"><summary>PR 固定代码版本</summary>
    <p className="collab-small">先读取 PR 状态，再下载该观察的 head/base 提交。按共同基线到 head 比较；不会执行项目代码，也不会合并。页面只读取本地记录，下载由明确点击触发。</p>
    {error && <p role="alert" className="collab-error">{error}</p>}
    <button className="collab-button secondary" onClick={() => void refresh()}>刷新已有 PR 代码记录</button>
    {pending && <><p>原下载操作响应未确认，已保留相同编号及版本。</p><button className="collab-button" disabled={busy || !context?.canCancel} onClick={() => void submit(pending)}>重试同一 PR 代码操作</button></>}
    {context?.canRequest && !pending && <button className="collab-button" disabled={!loaded || busy || active} onClick={() => void submit({ kind: "read", body: {
      idempotencyKey: crypto.randomUUID(), expectedTaskVersion: context.taskVersion, expectedObservationVersion: context.observationVersion,
    } })}>下载观察对应的固定代码</button>}
    {context && !context.canRequest && context.observationVersion === "0" && <p>尚无成功的 PR 状态读取，请先读取 GitHub PR 状态。</p>}
    <p className="collab-small">最近 20 项代码下载任务。固定差异不代表 CI 或评审通过；秘密路径、链接、非文本和超限内容需另外核对。</p>
    {context?.jobs.map(job => <article key={job.jobId} className="collab-form compact" data-pull-revision={job.jobId}>
      <p role="status">{statuses[job.status]}</p>
      <p className="collab-small collab-git-identity">请求成员 {job.actorName}<br/>代码版本 {job.jobId} · 观察 v{job.observationVersion}<br/>head {job.headSha}<br/>base {job.baseSha}</p>
      {!job.current && <p>此代码版本不再对应最近成功的本地观察；历史内容保持不变。</p>}
      {job.failure && <details><summary>代码下载诊断</summary><p className="collab-small">{job.failure}</p></details>}
      {job.status === "ready" && <><Code id={job.jobId}/><PullChecks revisionId={job.jobId} userId={userId}/><PullRelease revisionId={job.jobId} userId={userId}/></>}
      {job.stopRequested && <p>已记录取消请求。</p>}
      {context.canCancel && !pending && ["queued", "running"].includes(job.status) && !job.stopRequested && <form className="collab-form compact" onSubmit={e => {
        e.preventDefault(); void submit({ kind: "cancel", jobId: job.jobId, body: { idempotencyKey: crypto.randomUUID(), reason } });
      }}>
        <label>代码下载取消原因<textarea aria-label="代码下载取消原因" required minLength={10} maxLength={2000} value={reason} onChange={e => setReason(e.target.value)}/></label>
        <button className="collab-button secondary" disabled={busy}>取消此次代码下载</button>
      </form>}
    </article>)}
  </details>;
}
