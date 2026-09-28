import { createHash, randomUUID } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { realpathSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PoolClient } from "pg";
import { mergeEditorText } from "./editor-merge";
import { safeSnapshotPath, snapshotExcludedPath } from "./runtime/snapshots";
import { DomainError } from "./policy";
import type { EditorWriteback } from "./editor-schema";
import { getAllowedFileRoots } from "../file-access";
import { isPathWithinRoots } from "../path-security";

const sha256hex = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

export type WritebackConflict = { base: string; local: string | null; remote: string | null; merged: string };
export type WritebackOutcome =
 | { status: "in-sync" | "written" | "merged" | "deleted"; bytes: Buffer | null }
 | { status: "conflict"; conflict: WritebackConflict }
 | { status: "error"; message: string };

export type WritebackInput = {
 /** Realpath-resolved absolute local directory the project is bound to. */
 bindingPath: string;
 /** Snapshot-relative POSIX document path (already editor-validated, re-checked here). */
 docPath: string;
 /** Saved shared-draft content; null when the document was deleted. */
 newContent: string | null;
 /** Document original_text: import-time content, the common ancestor for first write-back. */
 originalText: string;
 /** Exact bytes write-back last wrote to this path; null when never written. */
 lastWritten: Buffer | null;
};

const invalidPath = () => new DomainError("editor_content_unavailable", "此文件包含受限路径，无法回写到本地目录。", 400);

/**
 * Resolve the on-disk target for a snapshot-relative document path.
 * The nearest existing ancestor is symlink-resolved and must stay inside the
 * binding, so a planted symlink can neither redirect the write elsewhere nor
 * escape through a symlinked file at the target itself.
 */
export function resolveBoundFilePath(bindingPath: string, docPath: string): string {
 if (!safeSnapshotPath(docPath) || snapshotExcludedPath(docPath)) throw invalidPath();
 const bindingReal = realpathSync(bindingPath);
 const target = path.resolve(bindingReal, docPath);
 let probe = target;
 for (;;) {
  let real: string;
  try { real = realpathSync(probe); }
  catch {
   const parent = path.dirname(probe);
   if (parent === probe) throw invalidPath();
   probe = parent; continue;
  }
  if (real !== bindingReal && !real.startsWith(bindingReal + path.sep)) throw invalidPath();
  return target;
 }
}

async function writeTarget(target: string, content: Buffer, existing: Buffer | null): Promise<void> {
 let mode: number | undefined;
 if (existing !== null) { try { mode = (await stat(target)).mode & 0o7777; } catch { mode = undefined; } }
 await mkdir(path.dirname(target), { recursive: true });
 const tmp = path.join(path.dirname(target), `.pi-writeback-${randomUUID()}.tmp`);
 try {
  if (mode === undefined) await writeFile(tmp, content);
  else await writeFile(tmp, content, { mode });
  await rename(tmp, target);
 } catch (error) { await rm(tmp, { force: true }); throw error; }
}

function conflictOf(base: string, local: string | null, remote: Buffer | null): WritebackOutcome {
 return { status: "conflict", conflict: { base, local, remote: remote === null ? null : remote.toString("utf8"), merged: "" } };
}

async function mergeAndWrite(target: string, disk: Buffer, base: string, local: string): Promise<WritebackOutcome> {
 if (!isUtf8(disk)) return conflictOf(base, local, disk);
 const remote = disk.toString("utf8");
 const merged = await mergeEditorText(base, local, remote);
 if (merged.conflicted) return { status: "conflict", conflict: { base, local, remote, merged: merged.text } };
 const bytes = Buffer.from(merged.text, "utf8");
 await writeTarget(target, bytes, disk);
 return { status: "merged", bytes };
}

async function writebackDelete(target: string, disk: Buffer | null, input: WritebackInput): Promise<WritebackOutcome> {
 if (disk === null) return { status: "deleted", bytes: null };
 const written = input.lastWritten, original = input.originalText;
 // Only remove a local file we previously wrote, or one still identical to the
 // import-time content; anything else may hold external work worth keeping.
 if ((written !== null && sha256hex(disk) === sha256hex(written)) || (written === null && original !== "" && sha256hex(disk) === sha256hex(original))) {
  await rm(target);
  return { status: "deleted", bytes: null };
 }
 return conflictOf(written === null ? original : written.toString("utf8"), null, disk);
}

async function writebackSave(target: string, disk: Buffer | null, input: WritebackInput, content: string): Promise<WritebackOutcome> {
 const next = Buffer.from(content, "utf8");
 if (disk !== null && sha256hex(disk) === sha256hex(next)) return { status: "in-sync", bytes: next };
 const written = input.lastWritten;
 if (written !== null) {
  if (disk === null) return conflictOf(written.toString("utf8"), content, null); // deleted outside the editor
  if (sha256hex(disk) === sha256hex(written)) {
   if (sha256hex(next) === sha256hex(written)) return { status: "in-sync", bytes: next };
   await writeTarget(target, next, disk);
   return { status: "written", bytes: next };
  }
  // External modification since our last write: three-way merge with the last
  // written bytes as the common ancestor, reusing the editor merge semantics.
  return mergeAndWrite(target, disk, written.toString("utf8"), content);
 }
 // First write-back for this path: the import-time content is the common
 // ancestor of the draft lineage and whatever sits on disk now.
 if (disk === null || sha256hex(disk) === sha256hex(input.originalText)) {
  await writeTarget(target, next, disk);
  return { status: "written", bytes: next };
 }
 return mergeAndWrite(target, disk, input.originalText, content);
}

/**
 * Write one saved document back to the bound local directory.
 * Pure filesystem + merge logic: never throws for expected failures, reports
 * them as {status:"error"|"conflict"} so a save is never failed by write-back.
 */
export async function performWriteback(input: WritebackInput): Promise<WritebackOutcome> {
 let target: string;
 try { target = resolveBoundFilePath(input.bindingPath, input.docPath); }
 catch (error) { return { status: "error", message: error instanceof Error ? error.message : "本地路径校验失败" }; }
 let disk: Buffer | null;
 try { disk = await readFile(target); }
 catch (error) {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") disk = null;
  else return { status: "error", message: `读取本地文件失败：${error instanceof Error ? error.message : "未知错误"}` };
 }
 try {
  if (input.newContent === null) return await writebackDelete(target, disk, input);
  return await writebackSave(target, disk, input, input.newContent);
 } catch (error) {
  return { status: "error", message: error instanceof Error ? error.message : "回写本地文件失败" };
 }
}

/** Force-write bytes to the bound path regardless of disk state (explicit user resolution). */
export async function forceWriteback(bindingPath: string, docPath: string, content: Buffer | null): Promise<void> {
 const target = resolveBoundFilePath(bindingPath, docPath);
 if (content === null) { await rm(target, { force: true }); return; }
 let existing: Buffer | null = null;
 try { existing = await readFile(target); } catch { existing = null; }
 await writeTarget(target, content, existing);
}

/**
 * Move a document's local backing file along with a rename (unbound project).
 * The local file keeps its directory and takes the new document's basename;
 * the exact on-disk bytes (including any external modifications) become the
 * new baseline. Never throws for expected failures.
 */
export async function moveDocumentLocalFile(db: PoolClient, newDocId: string, source: { local_path: string; content: string }, newDocPath: string): Promise<EditorWriteback> {
 try {
  const oldLocal = source.local_path;
  const newLocal = path.join(path.dirname(oldLocal), path.basename(newDocPath));
  const parentReal = realpathSync(path.dirname(newLocal));
  if (!isPathWithinRoots(parentReal, await getAllowedFileRoots()))
   return { status: "error", message: "本地路径不在允许访问的目录范围内。" };
  try {
   if ((await stat(newLocal)).isDirectory()) return { status: "error", message: "本地已存在同名目录，文件未重命名。" };
   return { status: "error", message: "本地已存在同名文件，文件未重命名；请先处理该文件。" };
  } catch (error) {
   if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let bytes: Buffer;
  try {
   await rename(oldLocal, newLocal);
   bytes = await readFile(newLocal);
  } catch (error) {
   if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
   // The local file was deleted outside the editor: recreate at the new name.
   bytes = Buffer.from(source.content, "utf8");
   await forceWriteback(path.dirname(newLocal), path.basename(newLocal), bytes);
  }
  await db.query("SELECT collab.set_document_local_path($1,$2)", [newDocId, newLocal]);
  await db.query("SELECT collab.record_document_writeback($1,$2,$3)", [newDocId, sha256hex(bytes), bytes]);
  return { status: "written", scope: "document", localPath: newLocal };
 } catch (error) {
  return { status: "error", message: error instanceof Error ? error.message : "本地文件重命名失败" };
 }
}

type SavedDocument = { id: string; path: string; content: string; original_text: string | null; local_path?: string | null };

/**
 * Run one saved document back to local disk and map the outcome to an
 * EditorWriteback, recording the new baseline. Never throws for expected
 * failures; write-back never fails the save itself.
 *
 * Resolution order:
 * 1. the current user's project binding (agents run as the user, so an agent
 *    acting for a user inherits that user's binding automatically);
 * 2. the document's own local_path (unbound projects: existing local file);
 * 3. pure shared draft -> "needs-local-path" so the UI can offer save-as.
 */
async function finishOutcome(
 outcome: WritebackOutcome,
 record: (bytes: Buffer) => Promise<void>,
 clear: () => Promise<void>,
): Promise<{ bytes: Buffer | null } | { conflict: WritebackConflict } | { error: string }> {
 if (outcome.status === "error") return { error: outcome.message };
 if (outcome.status === "conflict") return { conflict: outcome.conflict };
 if (outcome.status === "deleted") { await clear(); return { bytes: null }; }
 await record(outcome.bytes!);
 return { bytes: outcome.bytes };
}

/**
 * Database glue for the save path: loads the binding (or per-document path) +
 * baseline, runs the write-back, and records the new baseline. Returns an
 * EditorWriteback for the sync response; write-back never throws.
 */
export async function runDocumentWriteback(db: PoolClient, projectId: string, doc: SavedDocument, opts: { deleted: boolean }): Promise<EditorWriteback> {
 try {
  // 1. Per-user project binding.
  const binding = (await db.query(
   `SELECT id, local_path AS "localPath" FROM collab.project_local_bindings WHERE project_id=$1 AND owner_user_id = collab.actor()`,
   [projectId])).rows[0] as { id: string; localPath: string } | undefined;
  if (binding) {
   const state = (await db.query("SELECT written_content AS \"written\" FROM collab.local_writeback_state WHERE binding_id=$1 AND path=$2", [binding.id, doc.path])).rows[0] as { written: Buffer | null } | undefined;
   const outcome = await performWriteback({
    bindingPath: binding.localPath, docPath: doc.path,
    newContent: opts.deleted ? null : doc.content,
    originalText: doc.original_text ?? "",
    lastWritten: state?.written ?? null,
   });
   const done = await finishOutcome(outcome,
    bytes => db.query("SELECT collab.record_local_writeback($1,$2,$3,$4)", [binding.id, doc.path, sha256hex(bytes), bytes]).then(() => {}),
    () => db.query("SELECT collab.clear_local_writeback($1,$2)", [binding.id, doc.path]).then(() => {}));
   if ("error" in done) return { status: "error", message: done.error };
   if ("conflict" in done) return { status: "conflict", scope: "binding", localPath: binding.localPath, path: doc.path, conflict: done.conflict };
   return { status: outcome.status as "in-sync" | "written" | "merged" | "deleted", scope: "binding", localPath: binding.localPath, path: doc.path };
  }
  // 2. Per-document local path (unbound project, existing local file).
  // The target must stay inside the app's allowed file roots, the same
  // boundary the file browser and save-as dialog enforce.
  const docLocal = doc.local_path ?? null;
  if (docLocal) {
   const dir = path.dirname(docLocal);
   if (!path.isAbsolute(docLocal) || !isPathWithinRoots(dir, await getAllowedFileRoots()))
    return { status: "error", message: "本地路径不在允许访问的目录范围内。" };
   const state = (await db.query("SELECT written_content AS \"written\" FROM collab.document_writeback_state WHERE document_id=$1", [doc.id])).rows[0] as { written: Buffer | null } | undefined;
   const outcome = await performWriteback({
    bindingPath: dir, docPath: path.basename(docLocal),
    newContent: opts.deleted ? null : doc.content,
    originalText: doc.original_text ?? "",
    lastWritten: state?.written ?? null,
   });
   const done = await finishOutcome(outcome,
    bytes => db.query("SELECT collab.record_document_writeback($1,$2,$3)", [doc.id, sha256hex(bytes), bytes]).then(() => {}),
    () => db.query("SELECT collab.clear_document_writeback($1)", [doc.id]).then(() => {}));
   if ("error" in done) return { status: "error", message: done.error };
   if ("conflict" in done) return { status: "conflict", scope: "document", localPath: docLocal, conflict: done.conflict };
   return { status: outcome.status as "in-sync" | "written" | "merged" | "deleted", scope: "document", localPath: docLocal };
  }
  // 3. Pure shared draft: a deleted draft has no local file; a live one can
  // be saved-as to local from the UI.
  if (opts.deleted) return { status: "unbound" };
  return { status: "needs-local-path" };
 } catch (error) {
  return { status: "error", message: error instanceof Error ? error.message : "本地回写失败" };
 }
}
