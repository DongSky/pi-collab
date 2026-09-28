"use client";
import { useEffect, useState } from "react";
import { collabApi, CollabApiError } from "./api";

type Binding = { id: string; projectId: string; localPath: string; createdAt: string; updatedAt: string } | null;

/**
 * Project-scoped local directory binding ("direct-link" mode).
 * Saves still go to the shared draft first; when bound, syncDocument mirrors
 * the saved content into the chosen server-side directory with the same
 * three-way merge, instead of requiring the branch-based delivery flow.
 * Imported folder copies stay isolated until a project is bound here.
 */
export function LocalBindingPanel({ projectId, canManage }: { projectId: string; canManage: boolean }) {
 const [binding, setBinding] = useState<Binding | null>(null);
 const [path, setPath] = useState("");
 const [busy, setBusy] = useState(false);
 const [error, setError] = useState("");
 const [open, setOpen] = useState(false);

 const load = async (id: string) => {
  try { setError(""); setBinding((await collabApi<{ binding: Binding }>(`projects/${id}/local-binding`)).binding); }
  catch (e) { if (e instanceof CollabApiError && e.status !== 403) setError(e.message); }
 };
 useEffect(() => { setPath(""); setOpen(false); void load(projectId); }, [projectId]);

 const save = async () => {
  setBusy(true); setError("");
  try { const result = await collabApi<{ binding: Binding }>(`projects/${projectId}/local-binding`, { localPath: path }, "PUT"); setBinding(result.binding); setPath(""); }
  catch (e) { setError(e instanceof Error ? e.message : "关联失败"); }
  finally { setBusy(false); }
 };
 const unbind = async () => {
  setBusy(true); setError("");
  try { await collabApi(`projects/${projectId}/local-binding`, undefined, "DELETE"); setBinding(null); }
  catch (e) { setError(e instanceof Error ? e.message : "解绑失败"); }
  finally { setBusy(false); }
 };

 return <details className="wb-local-binding" open={open} onToggle={e => setOpen((e.target as HTMLDetailsElement).open)}>
  <summary>本地目录关联{ binding ? <span className="collab-muted collab-small"> · 已回写</span> : null}</summary>
  <div className="wb-local-binding-body">
   <p className="collab-muted collab-small">保存后自动写回你指定的本机目录（服务端可访问的路径），遇到外部修改会三方合并而不是覆盖。关联仅对当前用户生效，代表你运行的 Agent 自动继承。未关联时保持现有协作副本流程：保存到共享草稿，通过 Git 分支交付；单个文件也可通过编辑器「另存为到本地」关联本机文件。</p>
   {binding ? <p role="status">已关联 <code>{binding.localPath}</code></p> : <p className="collab-muted" role="status">未关联本地目录</p>}
   {error && <p className="collab-error" role="alert">{error}</p>}
   {canManage && (binding
    ? <button type="button" className="collab-text-button" onClick={() => void unbind()} disabled={busy}>解除关联</button>
    : <form className="collab-form compact" onSubmit={e => { e.preventDefault(); void save(); }}>
      <label>本机目录绝对路径<input aria-label="本机目录绝对路径" value={path} onChange={e => setPath(e.target.value)} placeholder="/home/user/my-project" required maxLength={4096} disabled={busy} /></label>
      <button type="submit" className="collab-button" disabled={busy || !path.trim()}>{busy ? "关联中…" : "关联并启用回写"}</button>
     </form>)}
  </div>
 </details>;
}
