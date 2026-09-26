"use client";
import { useState } from "react";
import { EditorMergeDiff } from "./EditorMergeDiff";
import { collabApi } from "./api";
import type { EditPreview } from "@/lib/collab/language-schema";
export function WorkspaceEditPreview({ preview, sessionId, flush, onClose, onApplied }: { preview: EditPreview; sessionId: string; flush: () => Promise<void>; onClose: () => void; onApplied?: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [undo, setUndo] = useState<EditPreview | null>(null), [notice, setNotice] = useState("");
  async function apply(value: EditPreview, reverting = false) {
    setBusy(true); setError("");
    try {
      await flush();
      const result = await collabApi<{ version: string; changed: number }>(`editors/${sessionId}/changes`, { version: value.version, changes: value.changes }, "PATCH");
      setUndo(reverting ? null : { label: `撤销 ${value.label}`, version: result.version, changes: value.changes.map(c => ({ path: c.path, before: c.after, after: c.before })) });
      setNotice(`${reverting ? "已撤销" : "已保存"} ${result.changed} 个文件 · 草稿版本 ${result.version}`);
      await flush(); onApplied?.();
    } catch (e) { setError(e instanceof Error ? e.message : "操作未确认，请先核对服务器版本再操作。"); }
    finally { setBusy(false); }
  }
  return <section className="wb-edit-preview" aria-label="多文件修改预览">
    <header><strong>{preview.label}</strong><button disabled={busy} onClick={onClose}>关闭预览</button></header>
    <p>草稿版本 {preview.version} · {preview.changes.length} 个文件{preview.skipped ? ` · 已跳过 ${preview.skipped} 个非文本或大文件` : ""}。确认时再次检查版本，整批保存。</p>
    {preview.changes.map(change => <details key={change.path} open={preview.changes.length === 1}><summary>{change.path}</summary><EditorMergeDiff base={change.before} value={change.after} label={change.path}/></details>)}
    {error && <p role="alert" className="collab-error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!notice && <button disabled={busy || !preview.changes.length} onClick={() => void apply(preview)}>{busy ? "正在核对并保存…" : "确认全部修改并保存"}</button>}
    {undo && <button disabled={busy} onClick={() => void apply(undo, true)}>撤销本次批量修改（检查版本）</button>}
  </section>;
}
