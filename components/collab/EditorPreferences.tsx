"use client";
import { useSyncExternalStore } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { indentUnit } from "@codemirror/language";
const key = "pi-collab:editor-preferences:v1", event = "pi-collab:editor-preferences";
export type EditorPreferencesValue = { fontSize: number; tabSize: number; wrap: boolean; useTabs: boolean };
const defaults: EditorPreferencesValue = { fontSize: 14, tabSize: 2, wrap: true, useTabs: false };
function snapshot() { try { return localStorage.getItem(key) ?? ""; } catch { return ""; } }
function subscribe(notify: () => void) { window.addEventListener("storage", notify); window.addEventListener(event, notify); return () => { window.removeEventListener("storage", notify); window.removeEventListener(event, notify); }; }
export function useEditorPreferences() {
  const raw = useSyncExternalStore(subscribe, snapshot, () => "");
  let value = defaults;
  try { const p = JSON.parse(raw); value = { fontSize: [12,14,16,18,20].includes(p.fontSize) ? p.fontSize : 14, tabSize: [2,4,8].includes(p.tabSize) ? p.tabSize : 2, wrap: p.wrap !== false, useTabs: p.useTabs === true }; } catch { /* first visit */ }
  const save = (next: EditorPreferencesValue) => { localStorage.setItem(key, JSON.stringify(next)); window.dispatchEvent(new Event(event)); };
  return { value, save };
}
export function preferenceExtensions(value: EditorPreferencesValue): Extension[] {
  return [EditorState.tabSize.of(value.tabSize), indentUnit.of(value.useTabs ? "\t" : " ".repeat(value.tabSize)), ...(value.wrap ? [EditorView.lineWrapping] : []), EditorView.editorAttributes.of({ style: `font-size:${value.fontSize}px` })];
}
export function EditorPreferences({ value, onChange }: { value: EditorPreferencesValue; onChange: (value: EditorPreferencesValue) => void }) {
  return <details className="wb-editor-preferences"><summary>编辑器偏好</summary><div><label>字号<select aria-label="编辑器字号" value={value.fontSize} onChange={e => onChange({ ...value, fontSize: Number(e.target.value) })}>{[12,14,16,18,20].map(n => <option key={n} value={n}>{n}px</option>)}</select></label><label>缩进宽度<select aria-label="编辑器缩进宽度" value={value.tabSize} onChange={e => onChange({ ...value, tabSize: Number(e.target.value) })}>{[2,4,8].map(n => <option key={n} value={n}>{n}</option>)}</select></label><label><input type="checkbox" checked={value.wrap} onChange={e => onChange({ ...value, wrap: e.target.checked })}/>自动折行</label><label><input type="checkbox" checked={value.useTabs} onChange={e => onChange({ ...value, useTabs: e.target.checked })}/>使用 Tab 缩进</label><small>保存于当前浏览器，各成员独立设置。</small></div></details>;
}
