"use client";
import { useEffect, useRef, useState, type RefObject } from "react";
import { EditorView } from "@codemirror/view";
import { setDiagnosticMarks } from "./editor-language";
import { collabApi } from "./api";
import { WorkspaceEditPreview } from "./WorkspaceEditPreview";
import type { CodeDiagnostic, EditPreview, LanguageRequest, LanguageResult } from "@/lib/collab/language-schema";
export function EditorLanguagePanel({ sessionId, filename, workspaceVersion, viewRef, commandRef, flush, onNavigate }: { sessionId: string; filename: string; workspaceVersion: string; viewRef: RefObject<EditorView | null>; commandRef: RefObject<(action: LanguageRequest["action"]) => void>; flush: () => Promise<void>; onNavigate: (path: string, line: number, column: number) => void }) {
  const [result, setResult] = useState<LanguageResult | null>(null), [diagnostics, setDiagnostics] = useState<CodeDiagnostic[]>([]), [diagnosticNotice, setDiagnosticNotice] = useState("");
  const [preview, setPreview] = useState<EditPreview | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [rename, setRename] = useState(false), [newName, setNewName] = useState(""), [problems, setProblems] = useState(false);
  const sequence = useRef(0), renamePosition = useRef(0), renameText = useRef("");
  useEffect(() => {
    let alive = true, last = "", running = false, retryAt = 0;
    const check = async () => {
      const view = viewRef.current;
      if (!view || running || Date.now() < retryAt) return;
      const text = view.state.doc.toString();
      if (last === text + "\0") return;
      last = text + "\0"; running = true;
      try {
        const response = await collabApi<LanguageResult>(`editors/${sessionId}/language`, { action: "diagnostics", path: filename, text }, "POST", AbortSignal.timeout(15000));
        if (alive && viewRef.current === view && view.state.doc.toString() === text) { setDiagnostics(response.diagnostics ?? []); view.dispatch({ effects: setDiagnosticMarks.of(response.diagnostics ?? []) }); setDiagnosticNotice(response.notices.join(" · ")); }
      } catch (e) { last = ""; retryAt = Date.now() + 15000; if (alive) setDiagnosticNotice(e instanceof Error ? e.message : "诊断暂不可用"); }
      finally { running = false; }
    };
    const timer = setInterval(() => void check(), 1800); void check();
    return () => { alive = false; clearInterval(timer); };
  }, [sessionId, filename, workspaceVersion, viewRef]);
  useEffect(()=>{const generationRef=sequence;return()=>{generationRef.current++;};},[sessionId,filename]);
  async function run(action: LanguageRequest["action"], confirming = false) {
    const view = viewRef.current;
    if (!view || busy) return;
    if (action === "rename" && !confirming) { const pos = view.state.selection.main.empty ? view.state.selection.main.head : view.state.selection.main.from; renamePosition.current = pos; renameText.current = view.state.doc.toString(); setNewName(view.state.wordAt(pos) ? view.state.sliceDoc(view.state.wordAt(pos)!.from, view.state.wordAt(pos)!.to) : ""); setRename(true); return; }
    const generation = ++sequence.current, text = view.state.doc.toString(), position = action === "rename" ? renamePosition.current : view.state.selection.main.empty ? view.state.selection.main.head : view.state.selection.main.from;
    setBusy(true); setError(""); setResult(null); setPreview(null);
    try {
      if (action === "rename" && text !== renameText.current) throw new Error("重命名期间文件已变化，请重新选择符号。");
      await flush();
      if (viewRef.current !== view || view.state.doc.toString() !== text) throw new Error("文件已更新，请重新执行操作。");
      const response = await collabApi<LanguageResult>(`editors/${sessionId}/language`, { action, path: filename, position, ...(action === "rename" ? { newName } : {}) }, "POST", AbortSignal.timeout(15000));
      if (sequence.current !== generation) return;
      if (viewRef.current !== view || view.state.doc.toString() !== text) throw new Error("分析期间文件已变化，请重试。");
      if (response.preview) { setPreview(response.preview); setRename(false); }
      else if (action === "definition" && response.locations?.length === 1) { const loc = response.locations[0]; onNavigate(loc.path, loc.line, loc.column); }
      else setResult(response);
    } catch (e) { if (sequence.current === generation) setError(e instanceof Error ? e.message : "语言服务暂不可用"); }
    finally { if (sequence.current === generation) setBusy(false); }
  }
  useEffect(() => { commandRef.current = action => void run(action); });
  const navigate = (line: number, column: number) => { const view = viewRef.current; if (!view) return; const row = view.state.doc.line(Math.min(line, view.state.doc.lines)), pos = Math.min(row.to, row.from + column - 1); view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) }); view.focus(); };
  return <div className="wb-language-tools">
    <div className="wb-language-bar"><span>TS / JS</span><button title="F12" disabled={busy} onClick={() => void run("definition")}>转到定义</button><button title="Shift F12" disabled={busy} onClick={() => void run("references")}>查找引用</button><button title="⌘ / Ctrl Shift O" disabled={busy} onClick={() => void run("symbols")}>文件符号</button><button title="F2" disabled={busy || !!viewRef.current?.state.readOnly} onClick={() => void run("rename")}>重命名符号</button><button title="⌘ / Ctrl ." disabled={busy || !!viewRef.current?.state.readOnly} onClick={() => void run("fixes")}>快速修复</button><button disabled={busy || !!viewRef.current?.state.readOnly} onClick={() => void run("organize")}>整理导入</button><button aria-expanded={problems} onClick={() => setProblems(!problems)}>问题 {diagnostics.length}{diagnosticNotice ? " · 提示" : ""}</button></div>
    {busy && <p role="status">正在分析共享草稿…</p>}
    {error && <p role="alert" className="collab-error">{error}</p>}
    {rename && <form className="wb-symbol-rename" onSubmit={e => { e.preventDefault(); void run("rename", true); }}><label>新符号名称<input autoFocus aria-label="新符号名称" value={newName} onChange={e => setNewName(e.target.value)} maxLength={128}/></label><button disabled={busy || !newName}>预览符号重命名</button><button type="button" onClick={() => setRename(false)}>取消</button></form>}
    {problems && <section aria-label="语言诊断" className="wb-language-results">{diagnosticNotice && <p>{diagnosticNotice}</p>}{!diagnostics.length && <p>当前文件没有语言诊断。</p>}{diagnostics.map((d, i) => <button key={i} onClick={() => navigate(d.line, d.column)}>{d.severity === "error" ? "错误" : "警告"} TS{d.code} · {d.line}:{d.column} · {d.name}</button>)}</section>}
    {result && <section aria-label="语言查询结果" className="wb-language-results"><button onClick={() => setResult(null)}>关闭结果</button>{result.notices.map(n => <p key={n}>{n}</p>)}{!result.locations?.length && !result.codeActions?.length && <p>当前位置没有匹配结果或可用修复。</p>}{result.codeActions?.map((action,i)=><button key={i} onClick={()=>{setPreview(action.preview);setResult(null);}}>{action.description} · 预览修复</button>)}{result.locations?.map((loc, i) => <button key={i} onClick={() => onNavigate(loc.path, loc.line, loc.column)}>{loc.path}:{loc.line}:{loc.column} · {loc.name}</button>)}</section>}
    {preview && <WorkspaceEditPreview key={JSON.stringify(preview)} preview={preview} sessionId={sessionId} flush={flush} onClose={() => setPreview(null)}/>}
  </div>;
}
