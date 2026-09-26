import path from "node:path";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { z } from "zod";
import { codeAnchor, replaceSourceLines, type RunSuggestion } from "../discussion-schema";
import { loadSnapshot, safeSnapshotPath, snapshotHasSecret } from "./snapshots";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
/** Called once on a newly provisioned workspace, before any Pi process is launched. */
export async function applyRunSuggestion(root: string, checkout: string, raw: RunSuggestion, restored: { id: string; manifestHash: string }) {
  const suggestion = z.object({ threadId: z.uuid(), anchor: codeAnchor, replacement: z.string().max(16000) }).strict().parse(raw);
  const a = suggestion.anchor;
  if (a.snapshotId !== restored.id || a.manifestHash !== restored.manifestHash || !safeSnapshotPath(a.path)) throw new Error("suggestion_source_unavailable");
  const saved = await loadSnapshot(root, restored.id, restored.manifestHash), entry = saved.manifest.worktree.find(f => f.path === a.path);
  if (!entry || entry.hash !== a.fileHash) throw new Error("suggestion_source_changed");
  const original = saved.blobs.get(entry.hash)!;
  if (original.length > 256 * 1024 || !isUtf8(original) || original.includes(0) || snapshotHasSecret(original)) throw new Error("suggestion_source_unavailable");
  const bytes = Buffer.from(replaceSourceLines(original.toString("utf8"), a, suggestion.replacement));
  if (bytes.length > 512 * 1024 || snapshotHasSecret(bytes)) throw new Error("suggestion_content_unavailable");
  const base = await realpath(checkout);
  let current = base;
  for (const part of a.path.split("/").slice(0,-1)) { current = path.join(current,part); const st = await lstat(current); if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("suggestion_unsafe_path"); }
  const handle = await open(path.join(base,a.path), constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat(); if (!stat.isFile() || stat.nlink !== 1 || stat.size > 256 * 1024) throw new Error("suggestion_unsafe_path");
    if (hash(await handle.readFile()) !== a.fileHash) throw new Error("suggestion_source_changed");
    let written = 0; while (written < bytes.length) { const result = await handle.write(bytes,written,bytes.length-written,written); if (!result.bytesWritten) throw new Error("suggestion_write_failed"); written += result.bytesWritten; }
    await handle.truncate(bytes.length); await handle.sync();
  } finally { await handle.close(); }
  return hash(bytes);
}
