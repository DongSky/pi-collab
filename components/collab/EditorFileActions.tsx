"use client";
import { useState } from "react";
import { WorkspaceEditPreview } from "./WorkspaceEditPreview";
import type { EditPreview } from "@/lib/collab/language-schema";
import { collabApi } from "./api";
export function EditorFileSearch({
  sessionId,
  canWrite,
  onOpen,
  flush,
}: {
  sessionId: string;
  canWrite: boolean;
  onOpen: (path: string, line?: number, column?: number) => void;
  flush: () => Promise<void>;
}) {
  const [replacement,setReplacement]=useState(""),[wholeWord,setWholeWord]=useState(false),[preview,setPreview]=useState<EditPreview|null>(null);
  const [query, setQuery] = useState(""),
    [sensitive, setSensitive] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [result, setResult] = useState<{
    matches: { path: string; line: number; column: number; text: string }[];
    truncated: boolean;
    skipped: number;
    version: string;
  } | null>(null);
  return (
    <details className="wb-project-search">
      <summary>搜索文件内容</summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          setError("");
          void flush()
            .then(() =>
              collabApi<NonNullable<typeof result>>(
                `editors/${sessionId}/files`,
                { query, caseSensitive: sensitive },
              ),
            )
            .then(setResult)
            .catch((e) => setError(e.message))
            .finally(() => setBusy(false));
        }}
      >
        <input
          aria-label="跨文件搜索内容"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          required
          maxLength={200}
        />
        <label>
          <input
            type="checkbox"
            checked={sensitive}
            onChange={(e) => setSensitive(e.target.checked)}
          />
          区分大小写
        </label>
        <button disabled={busy || !query}>
          {busy ? "搜索中…" : "搜索共享草稿"}
        </button>
      </form>
      {canWrite && <div className="wb-search-replace"><label>替换为<input aria-label="跨文件替换为" value={replacement} onChange={e=>setReplacement(e.target.value)} maxLength={2000}/></label><label><input type="checkbox" checked={wholeWord} onChange={e=>setWholeWord(e.target.checked)}/>替换仅匹配全词</label><button disabled={busy||!query} onClick={()=>{setBusy(true);setError("");void flush().then(()=>collabApi<EditPreview>(`editors/${sessionId}/changes`,{query,replacement,caseSensitive:sensitive,wholeWord})).then(setPreview).catch(e=>setError(e.message)).finally(()=>setBusy(false));}}>预览跨文件替换</button></div>}
      {preview&&<WorkspaceEditPreview key={JSON.stringify(preview)} preview={preview} sessionId={sessionId} flush={flush} onClose={()=>setPreview(null)}/>}
      {error && <p role="alert">{error}</p>}
      {result && (
        <>
          <small>
            草稿版本 {result.version} · {result.matches.length} 处
            {result.truncated ? "（仅前 200 处）" : ""}
            {result.skipped ? ` · 跳过 ${result.skipped} 个二进制或大文件` : ""}
          </small>
          {result.matches.map((match, i) => (
            <button
              className="wb-search-match"
              key={i}
              title={match.text}
              onClick={() => onOpen(match.path, match.line, match.column)}
            >
              <strong>
                {match.path}:{match.line}:{match.column}
              </strong>
              <span>{match.text}</span>
            </button>
          ))}
        </>
      )}
    </details>
  );
}
