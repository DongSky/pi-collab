import path from "node:path";
import { isUtf8 } from "node:buffer";
import { z } from "zod";
import { zipSync } from "fflate";
import { asUser } from "./database";
import { DomainError } from "./policy";
import {
  loadSnapshot,
  safeSnapshotPath,
  snapshotExcludedPath,
  snapshotHasSecret,
} from "./runtime/snapshots";
/** Materialize the authorized snapshot plus the latest draft in one session lock. */
export async function editorFiles(userId: string, id: string) {
  z.uuid().parse(id);
  return asUser(userId, async (db) => {
    await db.query("SELECT collab.editor_lock($1,false,false)", [id]);
    const session = (
      await db.query(
        "SELECT snapshot_id,manifest_hash,version FROM collab.editor_sessions WHERE id=$1",
        [id],
      )
    ).rows[0];
    if (!session)
      throw new DomainError("not_found", "草稿不存在或不可访问。", 404);
    const snapshot = await loadSnapshot(
      process.env.PI_COLLAB_DATA_DIR ?? path.resolve(".local"),
      session.snapshot_id,
      session.manifest_hash,
    );
    const files = new Map<string, Buffer>(
      snapshot.manifest.worktree.map((f) => [
        f.path,
        snapshot.blobs.get(f.hash)!,
      ]),
    );
    const docs = (
      await db.query(
        "SELECT path,content,deleted FROM collab.editor_documents WHERE session_id=$1",
        [id],
      )
    ).rows;
    for (const doc of docs)
      if (doc.deleted) files.delete(doc.path);
      else files.set(doc.path, Buffer.from(doc.content));
    let bytes = 0;
    for (const [name, content] of files) {
      if (
        !safeSnapshotPath(name) ||
        snapshotExcludedPath(name) ||
        snapshotHasSecret(content)
      ) {
        files.delete(name);
        continue;
      }
      bytes += content.length;
    }
    if (bytes > 32 * 1024 * 1024 || files.size > 2000)
      throw new DomainError(
        "editor_export_limit",
        "草稿超过 2,000 文件或 32 MiB 的在线搜索与导出限制。请通过工作区终端处理。",
        413,
      );
    return { files, version: session.version as string };
  });
}
export async function searchEditorFiles(
  userId: string,
  id: string,
  raw: unknown,
) {
  const { query, caseSensitive } = z
    .object({
      query: z.string().min(1).max(200),
      caseSensitive: z.boolean().default(false),
    })
    .strict()
    .parse(raw);
  const { files, version } = await editorFiles(userId, id),
    matches: { path: string; line: number; column: number; text: string }[] =
      [];
  const needle = caseSensitive ? query : query.toLowerCase();
  let truncated = false,
    skipped = 0;
  for (const [path, bytes] of files) {
    if (!isUtf8(bytes) || bytes.includes(0) || bytes.length > 262144) {
      skipped++;
      continue;
    }
    const lines = bytes.toString("utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const at = (caseSensitive ? lines[i] : lines[i].toLowerCase()).indexOf(
        needle,
      );
      if (at < 0) continue;
      if (matches.length === 200) {
        truncated = true;
        break;
      }
      matches.push({
        path,
        line: i + 1,
        column: at + 1,
        text: lines[i].slice(Math.max(0, at - 80), at + 240),
      });
    }
    if (truncated) break;
  }
  return { matches, truncated, skipped, version };
}
export async function exportEditorFiles(userId: string, id: string) {
  const { files, version } = await editorFiles(userId, id);
  return { bytes: zipSync(Object.fromEntries(files), { level: 1 }), version };
}
