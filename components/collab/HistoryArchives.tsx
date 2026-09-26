"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { archiveBranch, archiveImport, archiveManifest, parseHistoryArchive, type ArchiveFile, type ArchiveTree } from "@/lib/collab/history-archive-format";
import { collabApi } from "./api";
type Row = { id: string; title: string; owner_id: string; owner_name: string; shared: boolean; file_count: number; byte_count: string };
type Manifest = ReturnType<typeof archiveManifest>;
type Opened = { id: string; title: string; contentHash: string; files: (Manifest[number] & { index: number; sha256: string })[] };
const size = (n: number | string) => `${(Number(n) / 1024).toFixed(1)} KiB`;
export function HistoryArchives({ projectId, userId, canWrite }: { projectId: string; userId: string; canWrite: boolean }) {
  const base = `projects/${projectId}/history-archives`;
  const [rows, setRows] = useState<Row[]>([]), [files, setFiles] = useState<ArchiveFile[]>([]), [title, setTitle] = useState("完整会话归档"), [shared, setShared] = useState(false), [reviewed, setReviewed] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false), [opened, setOpened] = useState<Opened | null>(null), [file, setFile] = useState<(ArchiveFile & { sha256: string }) | null>(null), [tree, setTree] = useState<ArchiveTree | null>(null), [leaf, setLeaf] = useState(""), [limit, setLimit] = useState(50), [remove, setRemove] = useState<Row | null>(null);
  const preview = useMemo(() => files.length ? archiveManifest(files) : [], [files]);
  const branch = useMemo(() => tree ? archiveBranch(tree, leaf) : [], [tree, leaf]);
  const load = useCallback(async () => setRows((await collabApi<{ archives: Row[] }>(base)).archives), [base]);
  useEffect(() => { void load().catch(e => setError(e.message)); }, [load]);
  async function act(work: () => Promise<void>) { setBusy(true); setError(""); setNotice(""); try { await work(); } catch (e) { setError(e instanceof Error ? e.message : "归档操作失败"); } finally { setBusy(false); } }
  async function openFile(id: string, index: number) {
    const selected = await collabApi<ArchiveFile & { sha256: string }>(`${base}/${id}/files/${index}`), parsed = parseHistoryArchive(selected.source);
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(selected.source)))].map(v => v.toString(16).padStart(2, "0")).join("");
    if (digest !== selected.sha256) throw new Error("归档文件校验失败，请重新读取。");
    setFile(selected); setTree(parsed); setLeaf(parsed.nodes.at(-1)?.id ?? ""); setLimit(50);
  }
  async function download() {
    if (!opened || !file) return;
    // Re-authorize at download time rather than exporting a revoked cached view.
    const index = opened.files.find(f => f.name === file.name)!.index;
    const current = await collabApi<ArchiveFile & { sha256: string }>(`${base}/${opened.id}/files/${index}`);
    const url = URL.createObjectURL(new Blob([new TextEncoder().encode(current.source)], { type: "application/x-ndjson;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = current.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice("已导出原始 UTF-8 文件；可在自己的 Pi 环境中检查或打开。");
  }
  return <section aria-label="完整会话归档"><h2>完整会话归档</h2>
    <p>保留 Pi 原始条目、分支、工具记录、系统内容与来源元数据；可以同时选择 fork 相关文件。历史身份与执行结果未经本平台核验，归档不会创建运行或执行工具。</p>
    {error && <p role="alert" className="collab-error">{error}</p>}{notice && <p role="status">{notice}</p>}
    {canWrite && <div className="collab-form"><label>选择完整 Pi 归档文件<input type="file" accept=".jsonl" multiple disabled={busy} onChange={e => { const selected = Array.from(e.target.files ?? []); setFiles([]); setReviewed(false); if (selected.length) void act(async () => {
      if (selected.length > 20 || selected.some(f => f.size > 5 * 1024 * 1024) || selected.reduce((n, f) => n + f.size, 0) > 10 * 1024 * 1024) throw new Error("最多 20 个文件，单个 5 MiB，合计 10 MiB。");
      const source = await Promise.all(selected.map(async f => ({ name: f.name, source: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await f.arrayBuffer()) })));
      archiveImport.parse({ title, shared, reviewed: true, files: source }); archiveManifest(source); setFiles(source);
    }); }} /></label>
      {files.length > 0 && <><label>完整归档名称<input value={title} maxLength={200} onChange={e => setTitle(e.target.value)} /></label>
        <p>已选择 {files.length} 个源文件 · {size(files.reduce((n, f) => n + new TextEncoder().encode(f.source).length, 0))}。每位成员每项目最多 50 组或 100 MiB，项目总额 1 GiB。</p>
        {preview.map((f, i) => <details key={f.name}><summary>{f.name} · {f.entryCount} 个条目 · {f.branchCount} 个分支端点</summary><p>{f.parentFile ? `声明的父文件：${f.parentFile}` : f.missingParent ? "声明的父会话未包含在本组中。" : "没有声明父会话。"}</p><label>原始文件内容<textarea readOnly rows={8} value={files[i].source} /></label></details>)}
        <label><input type="checkbox" checked={shared} onChange={e => { setShared(e.target.checked); setReviewed(false); }} />将完整归档共享给此项目当前及未来有权限的成员（默认仅自己）</label>
        <label><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)} />我已检查全部原始内容，包括工具输出、系统内容、路径和图片数据，并确认可见范围</label>
        <button className="collab-button" disabled={busy || !reviewed || !title.trim()} onClick={() => void act(async () => { const result = await collabApi<{ id: string; replayed: boolean }>(base, { title, shared, reviewed, files }); setFiles([]); setReviewed(false); await load(); setNotice(result.replayed ? "相同文件与可见范围已归档，返回原记录。" : "完整会话已归档，原始条目和分支关系已保留。"); })}>保存完整归档</button>
      </>}
    </div>}
    <h3>已保存的完整归档</h3><p className="collab-small">最近 100 组；列表仅显示你有权查看的归档。</p>
    {rows.map(row => <div className="collab-dependency" key={row.id}><button className="collab-text-button" disabled={busy} onClick={() => void act(async () => { setOpened(null); setFile(null); setTree(null); const info = await collabApi<Opened>(`${base}/${row.id}`); await openFile(row.id, 0); setOpened(info); })}>{row.title}</button><small>{row.file_count} 个文件 · {size(row.byte_count)} · {row.shared ? "项目共享" : "仅自己"} · {row.owner_name} 导入</small>{row.owner_id === userId && <button className="collab-text-button" disabled={busy} onClick={() => setRemove(row)}>删除完整归档</button>}</div>)}
    {!rows.length && <p>还没有可见的完整归档。</p>}
    {remove && <div className="collab-form"><p>永久删除「{remove.title}」的全部归档文件？审计保留记录标识。</p><button className="collab-button" disabled={busy} onClick={() => void act(async () => { await collabApi(`${base}/${remove.id}`, {}, "DELETE"); if (opened?.id === remove.id) { setOpened(null); setTree(null); setFile(null); } setRemove(null); await load(); setNotice("完整归档已删除。"); })}>确认删除完整归档</button><button className="collab-button" disabled={busy} onClick={() => setRemove(null)}>保留归档</button></div>}
    {opened && tree && file && <article aria-label="归档分支浏览"><h3>{opened.title}</h3>
      <label>归档内会话<select aria-label="归档内会话" disabled={busy} value={file.name} onChange={e => { const index = opened.files.find(f => f.name === e.target.value)!.index; void act(() => openFile(opened.id, index)); }}>{opened.files.map(f => <option key={f.name} value={f.name}>{f.name} · {f.branchCount} 个分支</option>)}</select></label>
      {opened.files.find(f => f.name === file.name)?.parentFile && <p>声明的父文件：{opened.files.find(f => f.name === file.name)!.parentFile}</p>}
      {opened.files.find(f => f.name === file.name)?.missingParent && <p>父会话未导入，当前文件仍完整保留。</p>}
      <p className="collab-git-identity">原始 session ID：{String(tree.header.id)}<br />文件 SHA-256：{file.sha256}</p>
      <button className="collab-button" disabled={busy} onClick={() => void act(download)}>导出当前原始 JSONL</button>
      <details><summary>原始会话标头</summary><pre style={{ maxHeight: 240, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(tree.header, null, 2)}</pre></details>
      {tree.legacy && <p>版本 1 没有原始条目 ID，按原行号展示线性历史；导出不添加 ID。</p>}
      <label>查看历史分支<select aria-label="查看历史分支" value={leaf} disabled={!tree.nodes.length} onChange={e => { setLeaf(e.target.value); setLimit(50); }}>{tree.leaves.map(id => { const n = tree.nodes.find(v => v.id === id)!; return <option key={id} value={id}>{id} · {n.role || n.type} · {n.text.slice(0, 60)}</option>; })}</select></label>
      <p>当前分支 {branch.length} 个条目；原文件共 {tree.nodes.length} 个条目。压缩摘要与上下文修改作为历史事件展示，不重放模型上下文。</p>
      {branch.slice(0, limit).map(n => <article className="collab-result-card" key={n.id}><strong>{n.role ? `历史 ${n.role}` : n.type} · {n.id}</strong><p className="collab-small">父条目：{n.parentId ?? "根"} · 原文件第 {n.line} 行</p>{n.text && <p className="collab-prewrap">{n.text}</p>}<details><summary>查看原始条目</summary><pre style={{ maxHeight: 300, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(n.raw, null, 2)}</pre></details></article>)}
      {branch.length > limit && <button className="collab-button" onClick={() => setLimit(limit + 50)}>继续显示 50 个条目</button>}
    </article>}
  </section>;
}
