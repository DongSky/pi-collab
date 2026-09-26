import path from "node:path";
import { isUtf8 } from "node:buffer";
import * as Y from "yjs";
import { z } from "zod";
import { editorFiles } from "./editor-files";
import { asUser } from "./database";
import { validateEditorPath, validateEditorText } from "./editor";
import { loadSnapshot } from "./runtime/snapshots";
import { DomainError } from "./policy";
import { analyzeCode } from "./language-service";
import { batchEdit, languageRequest, replaceRequest, type EditPreview } from "./language-schema";

export async function languageQuery(userId: string, id: string, raw: unknown) {
  const input = languageRequest.parse(raw);
  validateEditorPath(input.path);
  if (input.text !== undefined) validateEditorText(input.text);
  const { files, version } = await editorFiles(userId, id), texts = new Map<string, string>();
  let skipped = 0;
  for (const [name, bytes] of files) {
    if (bytes.length > 262144 || bytes.includes(0) || !isUtf8(bytes)) { skipped++; continue; }
    texts.set(name, bytes.toString("utf8"));
  }
  const result = analyzeCode(texts, version, input);
  result.skipped += skipped;
  if (skipped) result.notices.push(`跳过 ${skipped} 个二进制或大文件。`);
  return result;
}
export async function previewReplace(userId: string, id: string, raw: unknown): Promise<EditPreview> {
  const input = replaceRequest.parse(raw), { files, version } = await editorFiles(userId, id);
  const changes: EditPreview["changes"] = [];
  let skipped = 0;
  const escaped = input.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(input.wholeWord ? `(?<![\\p{L}\\p{N}_$])${escaped}(?![\\p{L}\\p{N}_$])` : escaped, input.caseSensitive ? "gu" : "giu");
  for (const [name, bytes] of files) {
    if (input.paths && !input.paths.includes(name)) continue;
    if (bytes.length > 262144 || bytes.includes(0) || !isUtf8(bytes)) { skipped++; continue; }
    const before = bytes.toString("utf8"), after = before.replace(pattern, () => input.replacement);
    if (before !== after) { validateEditorText(after); changes.push({ path: name, before, after }); }
  }
  if (changes.length > 40) throw new DomainError("edit_limit", "一次替换最多 40 个文件，请缩小搜索内容或文件范围。", 413);
  return { version, changes, label: `跨文件替换「${input.query}」`, skipped };
}
/** One session lock and transaction: all checked files change, or none do. */
export async function applyEditorChanges(userId: string, id: string, raw: unknown) {
  z.uuid().parse(id);
  const input = batchEdit.parse(raw);
  if (new Set(input.changes.map(c => c.path)).size !== input.changes.length) throw new DomainError("duplicate_path", "修改中存在重复路径。");
  for (const change of input.changes) { validateEditorPath(change.path); validateEditorText(change.before); validateEditorText(change.after); }
  return asUser(userId, async db => {
    await db.query("SELECT collab.editor_lock($1,true,false)", [id]);
    const session = (await db.query("SELECT * FROM collab.editor_sessions WHERE id=$1", [id])).rows[0];
    if (session.version !== input.version) throw new DomainError("stale_edit", "草稿已被修改，本次操作未写入任何文件。请重新预览并核对 Diff。", 409);
    const saved = await loadSnapshot(process.env.PI_COLLAB_DATA_DIR ?? path.resolve(".local"), session.snapshot_id, session.manifest_hash);
    const docs = (await db.query("SELECT * FROM collab.editor_documents WHERE session_id=$1", [id])).rows;
    for (const change of input.changes) {
      const existing = docs.find(d => d.path === change.path), entry = saved.manifest.worktree.find(f => f.path === change.path);
      const original = entry ? saved.blobs.get(entry.hash)!.toString("utf8") : undefined;
      const before = existing ? existing.deleted ? undefined : existing.content : original;
      if (before !== change.before) throw new DomainError("stale_edit", `${change.path} 的基线已变化，整批操作已取消。请重新预览。`, 409);
      if (change.before === change.after) continue;
      const doc = new Y.Doc();
      try {
        if (existing) Y.applyUpdate(doc, existing.y_state);
        else doc.getText("code").insert(0, before);
        const text = doc.getText("code");
        // Preserve unchanged text identities, selections, and remote Yjs cursors.
        let start = 0, end = 0;
        while (start < before.length && start < change.after.length && before[start] === change.after[start]) start++;
        while (end < before.length - start && end < change.after.length - start && before[before.length - end - 1] === change.after[change.after.length - end - 1]) end++;
        const split = (value: string, at: number) => at > 0 && at < value.length && /[\uD800-\uDBFF]/.test(value[at - 1]) && /[\uDC00-\uDFFF]/.test(value[at]);
        if (split(before, start) || split(change.after, start)) start--;
        if (split(before, before.length - end) || split(change.after, change.after.length - end)) end--;
        doc.transact(() => { text.delete(start, before.length - start - end); text.insert(start, change.after.slice(start, change.after.length - end)); });
        const state = Buffer.from(Y.encodeStateAsUpdate(doc));
        if (state.length > 1048576) throw new DomainError("edit_limit", "编辑状态过大，整批操作已取消。", 413);
        await db.query("SELECT collab.save_editor_document($1,$2,$3,$4,$5,$6,$7,false)", [id, change.path, existing?.base_hash ?? entry?.hash ?? null, existing?.original_text ?? original ?? "", change.after, state, existing?.revision ?? 0]);
      } finally { doc.destroy(); }
    }
    const version = (await db.query("SELECT version FROM collab.editor_sessions WHERE id=$1", [id])).rows[0].version as string;
    return { version, changed: input.changes.filter(c => c.before !== c.after).length };
  });
}
