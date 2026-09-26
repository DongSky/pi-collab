import path from "node:path";
import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { asUser } from "./database";
import { uuid } from "./projects";
import { DomainError } from "./policy";
import type { IntegrationEvidence } from "./integration-schema";
import { codeSha, codeQuery, codeFileQuery, codeDisplayText, type CodeEntry, type CodeContent, type CodeSide, type IntegrationCodeIdentity, type IntegrationCodePage, type IntegrationCodeFile } from "./integration-code-schema";
import { loadSnapshot, readSnapshotManifest, safeSnapshotPath, snapshotExcludedPath, snapshotHasSecret } from "./runtime/snapshots";
import { ReviewGit, reviewHash, reviewDiff } from "./runtime/review-git";

const FILE_LIMIT = 256 * 1024;
const unavailable = () => new DomainError("integration_code_unavailable", "固定代码证据不可用、超出读取限制或校验失败。", 409);
const missing = () => new DomainError("not_found", "代码记录不存在或不可访问。", 404);
type Row = { id: string; repository_id: string; input_hash: string; target_sha: string; status: string; evidence: IntegrationEvidence | null; input_state: string; review_state: { revisionHash: string | null } };
const blobOid = (bytes: Buffer) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

async function prepare(root: string, row: Row, signal: AbortSignal) {
  const e = row.evidence;
  if (!e || e.integrationId !== row.id || e.repositoryId !== row.repository_id || e.inputHash !== row.input_hash || e.targetSha !== row.target_sha || (!e.snapshot && !e.conflict)) throw unavailable();
  uuid.parse(row.id); uuid.parse(row.repository_id); codeSha.parse(row.target_sha);
  const identity: IntegrationCodeIdentity = { integrationId: row.id, repositoryId: row.repository_id, inputHash: row.input_hash, targetSha: row.target_sha, candidateCommit: e.candidateCommit, manifestHash: e.snapshot?.manifestHash ?? null, worktreeCommit: e.snapshot?.worktreeCommit ?? null, conflictResultId: e.conflict?.resultId ?? null };
  const entries: CodeEntry[] = [], excluded = new Map<string, string>();
  const omit = (file: string, reason: string) => { excluded.set(file, reason); if (excluded.size > 5000) throw unavailable(); };
  const privateGit = await ReviewGit.open(root, ["workspaces", row.id, "checkout", ".git"], signal);
  let baseGit: ReviewGit | null = null; const afterBlobs = new Map<string, Buffer>();
  if (e.conflict) {
    if (e.conflict.files.length > 256 || !e.sources.some(s => s.resultId === e.conflict!.resultId)) throw unavailable();
    for (const source of e.sources) {
      const { manifest } = await readSnapshotManifest(root, source.snapshotId, source.manifestHash);
      if (manifest.repositoryId !== row.repository_id || manifest.worktreeCommit !== source.worktreeCommit) throw unavailable();
      for (const item of manifest.excluded) omit(item.path, item.reason);
    }
    for (const file of e.conflict.files) {
      if (!safeSnapshotPath(file.path)) throw unavailable();
      const side = (id: string | null): CodeSide => id ? { oid: codeSha.parse(id), mode: "unknown" } : null;
      entries.push({ path: file.path, kind: "conflict", base: side(file.base), before: side(file.ours), after: side(file.theirs) });
    }
  } else {
    if (!e.candidateCommit || !e.snapshot || e.snapshot.id !== row.id) throw unavailable();
    const saved = await loadSnapshot(root, row.id, e.snapshot.manifestHash), m = saved.manifest;
    if (m.repositoryId !== row.repository_id || m.baseSha !== row.target_sha || m.sourceHead !== e.candidateCommit || m.worktreeCommit !== e.snapshot.worktreeCommit) throw unavailable();
    for (const item of m.excluded) omit(item.path, item.reason);
    baseGit = await ReviewGit.open(root, ["repositories", row.repository_id, "git"], signal);
    const before = await baseGit.tree(row.target_sha), candidate = await privateGit.tree(codeSha.parse(e.candidateCommit));
    for (const [file, reason] of [...before.excluded, ...candidate.excluded]) omit(file, reason);
    const after = new Map<string, NonNullable<CodeSide>>();
    for (const entry of m.worktree) {
      const bytes = saved.blobs.get(entry.hash)!; const oid = blobOid(bytes);
      if (candidate.files.get(entry.path)?.oid !== oid || candidate.files.get(entry.path)?.mode !== entry.mode) throw unavailable();
      after.set(entry.path, { oid, mode: entry.mode }); afterBlobs.set(oid, bytes);
    }
    for (const file of candidate.files.keys()) if (!after.has(file) && ![...excluded.keys()].some(prefix => file === prefix || file.startsWith(`${prefix}/`))) throw unavailable();
    for (const file of [...new Set([...before.files.keys(), ...after.keys()])].sort()) {
      const old = before.files.get(file) ?? null, current = after.get(file) ?? null;
      if (old?.oid === current?.oid && old?.mode === current?.mode) continue;
      entries.push({ path: file, kind: !old ? "added" : !current ? "deleted" : "modified", before: old, after: current });
    }
  }
  for (const entry of entries) {
    const omitted = snapshotExcludedPath(entry.path) ?? [...excluded].find(([prefix]) => entry.path === prefix || entry.path.startsWith(`${prefix}/`))?.[1];
    if (omitted) { entry.kind = "excluded"; entry.reason = omitted; }
  }
  const names = new Set(entries.map(entry => entry.path));
  for (const [file, reason] of excluded) if (!names.has(file)) { entries.push({ path: file, kind: "excluded", reason, before: null, after: null }); if (entries.length > 5000) throw unavailable(); }
  entries.sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (entries.length > 5000 || new Set(entries.map(entry => entry.path)).size !== entries.length || signal.aborted) throw unavailable();
  const diffHash = reviewHash(JSON.stringify({ version: 1, identity, files: entries }));
  return { identity, entries, diffHash, privateGit, baseGit, afterBlobs };
}

const gate = Symbol.for("pi-collab:code-readers");
const slots = globalThis as typeof globalThis & { [gate]?: { active: number } };
async function authorized<T extends { inputState: string }>(userId: string, id: string, operation: (row: Row, prepared: Awaited<ReturnType<typeof prepare>>, signal: AbortSignal) => Promise<T>, external?: AbortSignal) {
  uuid.parse(id);
  const capacity = slots[gate] ??= { active: 0 };
  if (capacity.active >= 2) throw new DomainError("code_reader_busy", "代码证据正在读取，请稍后重试。", 429);
  capacity.active++;
  try {
    return await asUser(userId, async db => {
      const row = (await db.query<Row>("SELECT id,repository_id,input_hash,target_sha,status,evidence,collab.integration_state(id) AS input_state,collab.integration_review_state(id) AS review_state FROM collab.integrations WHERE id=$1", [id])).rows[0];
      if (!row) throw missing();
      const deadline = AbortSignal.timeout(20000), signal = external ? AbortSignal.any([deadline,external]) : deadline;
      let output: T;
      try { output = await operation(row, await prepare(process.env.PI_COLLAB_DATA_DIR ?? path.resolve(".local"), row, signal), signal); }
      catch (error) { if (error instanceof DomainError) throw error; throw unavailable(); }
      // Filesystem work may take time. Check RLS again before returning any bytes.
      const fresh = (await db.query("SELECT collab.integration_state(id) AS input_state FROM collab.integrations WHERE id=$1", [id])).rows[0];
      if (!fresh) throw missing();
      return { ...output, inputState: fresh.input_state };
    });
  } finally { capacity.active--; }
}
export function integrationCode(userId: string, id: string, raw: unknown, signal?: AbortSignal) {
  const query = codeQuery.parse(raw);
  return authorized<IntegrationCodePage>(userId, id, async (row, data) => {
    if (query.diffHash && query.diffHash !== data.diffHash) throw new DomainError("code_revision_mismatch", "代码证据版本不匹配，请重新读取文件列表。", 409);
    const end = query.offset + 100;
    return { identity: data.identity, diffHash: data.diffHash, files: data.entries.slice(query.offset, end), total: data.entries.length, nextOffset: end < data.entries.length ? end : null, inputState: row.input_state, integrationStatus: row.status, reviewRevision: row.review_state.revisionHash };
  }, signal);
}
export function integrationCodeFile(userId: string, id: string, raw: unknown, signal?: AbortSignal) {
  const query = codeFileQuery.parse(raw);
  return authorized<IntegrationCodeFile>(userId, id, async (row, data, signal) => {
    if (query.diffHash !== data.diffHash) throw new DomainError("code_revision_mismatch", "代码证据版本不匹配，请重新读取文件列表。", 409);
    const file = data.entries.find(entry => entry.path === query.path); if (!file) throw missing();
    const response: IntegrationCodeFile = { identity: data.identity, diffHash: data.diffHash, fileHash: reviewHash(JSON.stringify({ diffHash: data.diffHash, file })), file, inputState: row.input_state, before: null, after: null, base: null, omitted: file.reason ?? null, lines: [] };
    if (file.kind === "excluded") return response;
    const values = new Map<"before" | "after" | "base", Buffer>();
    for (const side of ["before", "after", "base"] as const) {
      const ref = file[side]; if (!ref) continue;
      const reader = file.kind === "conflict" ? data.privateGit : side === "before" ? data.baseGit! : data.privateGit;
      const size = (await reader.sizes([ref.oid])).get(ref.oid)!; if (size.type !== "blob") throw unavailable();
      const content: CodeContent = { ...ref, size: size.size, sha256: null, text: null, encoding: "large", lineEndings: "none", escapedControls: false }; response[side] = content;
      if (size.size > FILE_LIMIT) continue;
      const bytes = file.kind !== "conflict" && side === "after" ? data.afterBlobs.get(ref.oid)! : (await reader.objects([ref.oid], "blob", FILE_LIMIT)).get(ref.oid)!;
      if (bytes.length !== size.size || blobOid(bytes) !== ref.oid) throw unavailable();
      if (snapshotHasSecret(bytes)) return { ...response, before: null, after: null, base: null, omitted: "secret_pattern", lines: [] };
      values.set(side, bytes); content.sha256 = reviewHash(bytes);
      if (!isUtf8(bytes)) { content.encoding = "unsupported"; continue; }
      if (bytes.includes(0)) { content.encoding = "binary"; continue; }
      const text = bytes.toString("utf8");
      if (text.split("\n").length > 8000) { content.encoding = "large"; continue; }
      const crlf = (text.match(/\r\n/g) ?? []).length, lf = (text.match(/\n/g) ?? []).length;
      content.lineEndings = lf === 0 ? "none" : crlf === 0 ? "lf" : crlf === lf ? "crlf" : "mixed";
      content.encoding = "utf8"; content.text = codeDisplayText(text); content.escapedControls = content.text !== text;
    }
    if ([response.before,response.after,response.base].some(c => c && c.text === null)) response.omitted = "non_text_or_large";
    else if (file.kind !== "conflict") response.lines = (await reviewDiff(values.get("before") ?? Buffer.alloc(0), values.get("after") ?? Buffer.alloc(0), signal)).map(line => ({ ...line, text: codeDisplayText(line.text) }));
    return response;
  }, signal);
}
