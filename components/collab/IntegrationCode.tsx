"use client";
import { useEffect, useRef, useState } from "react";
import { CodeDiscussions } from "./CodeDiscussions";
import { collabApi } from "./api";
import { codeDisplayText, type CodeContent, type IntegrationCodePage, type IntegrationCodeFile } from "@/lib/collab/integration-code-schema";

const kinds: Record<string,string> = { added: "新增", deleted: "删除", modified: "修改", conflict: "冲突", excluded: "未展示" };
const omissions: Record<string,string> = { private_path: "秘密路径", generated: "生成目录", secret_pattern: "内容命中秘密规则", large_file: "超过快照文件限制", symlink: "符号链接", submodule: "子模块", special_file: "特殊文件", non_text_or_large: "包含二进制、不支持编码或超限内容，无法显示完整文本差异" };
function Side({ label, value }: { label: string; value: CodeContent | null }) {
  return <section className="collab-code-side" aria-label={label}><h4>{label}</h4>
    {!value ? <p className="collab-muted collab-small">此版本不存在该文件。</p> : <>
      <p className="collab-muted collab-small">{value.oid.slice(0,12)} · {value.mode === "unknown" ? "权限模式未记录" : value.mode} · {value.size} 字节 · {value.lineEndings.toUpperCase()}</p>
      {value.sha256 && <details><summary>内容 SHA-256</summary><code className="collab-prewrap">{value.sha256}</code></details>}
      {value.text === null ? <p className="collab-muted">{value.encoding === "large" ? "内容超过展示限制" : "二进制或不支持的文本编码"}</p> : <pre tabIndex={0} className="collab-code-text">{value.text || "（空文件）"}</pre>}
      {value.escapedControls && <p className="collab-muted collab-small">不可见控制字符已用 ⟦U+…⟧ 显示；内容 hash 对应原始字节。</p>}
    </>}
  </section>;
}
export function IntegrationCode({ id, inputState }: { id: string; inputState: string }) {
  const [page, setPage] = useState<IntegrationCodePage | null>(null), [file, setFile] = useState<IntegrationCodeFile | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [comment,setComment]=useState<{side:"before"|"after";line:number}|null>(null);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, [id]);
  async function load(more = false) {
    if (busy) return; setBusy(true); setError(""); const current = ++generation.current;
    try {
      const query = more && page ? `?offset=${page.nextOffset}&diffHash=${page.diffHash}` : "";
      const data = await collabApi<IntegrationCodePage>(`integrations/${id}/code${query}`);
      if (generation.current === current) { setPage(old => more && old ? { ...data, files: [...old.files,...data.files] } : data); if (!more) setFile(null); }
    } catch (e) { if (generation.current === current) { setError(e instanceof Error ? e.message : "读取代码失败"); setPage(null); setFile(null); } }
    finally { if (generation.current === current) setBusy(false); }
  }
  async function select(path: string) {
    if (busy || !page) return; setBusy(true); setError(""); setFile(null); setComment(null); const current = ++generation.current;
    try {
      const data = await collabApi<IntegrationCodeFile>(`integrations/${id}/code/file?${new URLSearchParams({ path, diffHash: page.diffHash })}`);
      if (generation.current === current) setFile(data);
    } catch (e) { if (generation.current === current) setError(e instanceof Error ? e.message : "读取文件失败"); }
    finally { if (generation.current === current) setBusy(false); }
  }
  return <details className="collab-code-browser"><summary>查看固定代码差异与冲突</summary>
    <p className="collab-muted collab-small">读取保存的固定版本；不会打开或修改正在运行的 AI 工作目录。文本每侧最多 256 KiB、8,000 行；不可见控制字符用 ⟦U+…⟧ 表示。</p>
    {inputState !== "current" && <p role="status" className="collab-error">这是已失效候选的历史代码，不能沿用旧批准。</p>}
    <button className="collab-button" disabled={busy} onClick={() => void load()}>{page ? "重新核对代码证据" : "读取代码文件列表"}</button>
    {busy && <p role="status" className="collab-muted">正在校验固定代码…</p>}
    {error && <p role="alert" className="collab-error">{error}</p>}
    {page && <>
      <p className="collab-muted collab-small collab-prewrap">目标 {page.identity.targetSha.slice(0,12)} · Git 候选 {page.identity.candidateCommit?.slice(0,12) ?? "组合未完成"}<br/>受检代码 {page.identity.worktreeCommit?.slice(0,12) ?? "尚未检查"} · 差异 {page.diffHash.slice(0,16)}</p>
      {page.identity.conflictResultId && <p className="collab-muted collab-small">仅展示本次来源成果的冲突及排除项；完整组合尚未形成。ours 是已组合侧，theirs 是本次来源侧。</p>}
      <p className="collab-small">文件与排除项 {page.files.length}/{page.total}。排除项可能包含未变化的路径，不计为已验证修改。</p>
      <ul className="collab-code-files">{page.files.map(entry => <li key={entry.path}><button disabled={busy} className="collab-text-button" aria-pressed={file?.file.path === entry.path} onClick={() => void select(entry.path)}>{kinds[entry.kind]} · {codeDisplayText(entry.path)}{entry.reason && ` · ${omissions[entry.reason] ?? entry.reason}`}</button></li>)}</ul>
      {page.nextOffset !== null && <button className="collab-button" disabled={busy} onClick={() => void load(true)}>读取下一页代码文件</button>}
      {file && <div className="collab-code-detail" aria-label={`代码文件 ${codeDisplayText(file.file.path)}`}>
        <h4>{codeDisplayText(file.file.path)}</h4><p className="collab-muted collab-small collab-prewrap">文件证据 {file.fileHash.slice(0,16)}</p>
        {file.omitted && <p role="status" className="collab-muted">未完整展示：{omissions[file.omitted] ?? file.omitted}。这不代表没有变化。</p>}
        {(!file.omitted || file.omitted === "non_text_or_large") && <>
          {file.file.kind !== "conflict" && !file.omitted && <div className="collab-code-diff" tabIndex={0} aria-label="逐行代码差异">
            {!file.lines.length && <p className="collab-muted collab-small">文本字节相同或为空；请核对新增、删除和权限模式。</p>}
            {file.lines.map((line,index) => <div className={`collab-code-line ${line.kind}`} key={index}><span>{line.before!==null&&<button type="button" className="collab-text-button" aria-label={`评论旧侧第 ${line.before} 行`} onClick={()=>setComment({side:"before",line:line.before!})}>{line.before}</button>}</span><span>{line.after!==null&&<button type="button" className="collab-text-button" aria-label={`评论新侧第 ${line.after} 行`} onClick={()=>setComment({side:"after",line:line.after!})}>{line.after}</button>}</span><code>{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}{line.text}</code></div>)}
          </div>}
          <details open={file.file.kind === "conflict"}><summary>{file.file.kind === "conflict" ? "冲突三方原始版本" : "查看两侧完整文本"}</summary><div className="collab-code-sides">
            {file.file.kind === "conflict" && <Side label="base（共同基线）" value={file.base}/>}
            <Side label={file.file.kind === "conflict" ? "ours（已组合侧）" : "目标基线"} value={file.before}/>
            <Side label={file.file.kind === "conflict" ? "theirs（本次来源侧）" : "候选受检代码"} value={file.after}/>
          </div></details>
        </>}
        {comment&&!file.omitted&&<CodeDiscussions key={`${file.file.path}:${comment.side}:${comment.line}`} kind="integration" sourceId={id} diffHash={file.diffHash} path={file.file.path} side={comment.side} line={comment.line}/>}
      </div>}
    </>}
  </details>;
}
