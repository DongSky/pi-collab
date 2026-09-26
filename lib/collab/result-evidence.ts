import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import path from "node:path";
import { asUser } from "./database";
import { uuid } from "./projects";
import { DomainError } from "./policy";
import { loadSnapshot, snapshotExcludedPath, snapshotHasSecret } from "./runtime/snapshots";
import { ReviewGit, reviewDiff, reviewHash } from "./runtime/review-git";
import { codeDisplayText, type CodeLine } from "./integration-code-schema";
import type { PoolClient } from "pg";
import type { ValidationEvidence } from "./runtime/validation";

type Metadata = {
  revert?: { promotion_id: string; target_sha: string; old_sha: string; new_sha: string } | null;
  result: { id: string; version: number; taskId: string; projectId: string; sourceRunId: string; snapshotId: string; validationId: string; manifestHash: string; worktreeCommit: string; note: string };
  task: { id: string; title: string; description: string; acceptance: string; version: number; status: string };
  state: { currentResult: boolean; dependencyState: string; withdrawal: null | { reason: string }; repositoryBaseSha: string };
  repository: { id: string; name: string; provider: string };
  validation: { id: string; status: string; manifestHash: string; evidence: ValidationEvidence };
  integrations: { id: string; status: string; reviews: unknown[]; reviewState: unknown }[];
  discussions: { id: string; title: string; messages: unknown[] }[];
  github: { scope: string; revisions: unknown[] }; gitlab: unknown[]; toolSummary: unknown[];
};
const unavailable = () => new DomainError("evidence_unavailable", "固定成果文件缺失或校验失败，无法汇集完整证据。", 409);
const limit = () => new DomainError("evidence_limit", "证据超出本次导出上限，请使用单项证据入口；不会生成截断的完整证据包。", 413);
async function metadata(db: PoolClient, resultId: string): Promise<Metadata> {
  const value: Metadata = (await db.query("SELECT collab.result_evidence_metadata($1) AS data", [resultId])).rows[0].data;
  value.revert = (await db.query("SELECT promotion_id,target_sha,old_sha,new_sha FROM collab.revert_tasks WHERE task_id=$1", [value.result.taskId])).rows[0] ?? null;
  return value;
}
export async function resultEvidenceStatus(userId: string, resultId: string) {
  uuid.parse(resultId);
  return asUser(userId, async db => {
    const value = await metadata(db, resultId);
    return { state: value.state, metadataHash: reviewHash(JSON.stringify(value)) };
  });
}
type CodeChange = { path: string; kind: string; before: { oid: string; mode: string } | null; after: { oid: string; mode: string; sha256: string; size: number } | null; beforeSha256: string | null; omitted: string | null; lines: CodeLine[] };
// Known secret patterns are removed from prose as well as code. Hashes still
// identify the original evidence; redaction locations make the omission explicit.
function redact<T>(value: T): { value: T; redactions: string[] } {
  const redactions: string[] = [];
  const walk = (node: unknown, location: string): unknown => {
    if (typeof node === "string" && snapshotHasSecret(Buffer.from(node))) { redactions.push(location); return "[REDACTED: secret_pattern]"; }
    if (Array.isArray(node)) return node.map((item, i) => walk(item, `${location}/${i}`));
    if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([key, item]) => [key, walk(item, `${location}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`)]));
    return node;
  };
  return { value: walk(value, "") as T, redactions };
}
const slots = globalThis as typeof globalThis & { __piEvidenceReaders?: number };
export async function resultEvidence(userId: string, resultId: string, external?: AbortSignal) {
  uuid.parse(resultId);
  if ((slots.__piEvidenceReaders ?? 0) >= 2) throw new DomainError("evidence_busy", "证据正在汇集，请稍后重试。", 429);
  slots.__piEvidenceReaders = (slots.__piEvidenceReaders ?? 0) + 1;
  try {
    return await asUser(userId, async db => {
      const initial = await metadata(db, resultId), metadataHash = reviewHash(JSON.stringify(initial));
      const signal = external ? AbortSignal.any([external, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000);
      const root = process.env.PI_COLLAB_DATA_DIR ?? path.resolve(".local");
      let code, captured;
      try {
        const saved = await loadSnapshot(root, initial.result.snapshotId, initial.result.manifestHash), m = saved.manifest;
        if (m.id !== initial.result.snapshotId || m.runId !== initial.result.sourceRunId || m.repositoryId !== initial.repository.id || m.worktreeCommit !== initial.result.worktreeCommit || initial.validation.evidence.manifestHash !== initial.result.manifestHash || initial.validation.evidence.worktreeCommit !== m.worktreeCommit || initial.validation.evidence.snapshotId !== m.id) throw unavailable();
        const git = await ReviewGit.open(root, ["repositories", m.repositoryId, "git"], signal), before = await git.tree(m.baseSha);
        const after = new Map(m.worktree.map(entry => [entry.path, { oid: createHash("sha1").update(`blob ${entry.size}\0`).update(saved.blobs.get(entry.hash)!).digest("hex"), mode: entry.mode, sha256: entry.hash, size: entry.size }]));
        const excluded = [...m.excluded, ...[...before.excluded].map(([file, reason]) => ({ path: file, reason }))];
        const changes: CodeChange[] = [];
        for (const name of [...new Set([...before.files.keys(), ...after.keys()])].sort()) {
          const old = before.files.get(name) ?? null, next = after.get(name) ?? null;
          if (old?.oid === next?.oid && old?.mode === next?.mode) continue;
          const omitted = snapshotExcludedPath(name) ?? excluded.find(e => name === e.path || name.startsWith(e.path + "/"))?.reason ?? null;
          changes.push({ path: name, kind: !old ? "added" : !next ? "deleted" : "modified", before: old, after: next, beforeSha256: null, omitted, lines: [] });
        }
        if (changes.filter(change => !change.omitted).length > 128) throw limit();
        const sizes = await git.sizes(changes.filter(change => !change.omitted && change.before).map(change => change.before!.oid));
        let diffBytes = 0;
        for (const change of changes) {
          if (signal.aborted) throw unavailable();
          if (change.omitted) continue;
          if ((change.before && (sizes.get(change.before.oid)?.size ?? Infinity) > 256 * 1024) || (change.after?.size ?? 0) > 256 * 1024) { change.omitted = "large_file"; continue; }
          const old = change.before ? (await git.objects([change.before.oid], "blob", 256 * 1024)).get(change.before.oid)! : Buffer.alloc(0);
          const next = change.after ? saved.blobs.get(change.after.sha256)! : Buffer.alloc(0);
          if (snapshotHasSecret(old) || snapshotHasSecret(next)) { change.omitted = "secret_pattern"; continue; }
          change.beforeSha256 = change.before ? reviewHash(old) : null;
          if (![old, next].every(bytes => isUtf8(bytes) && !bytes.includes(0) && bytes.toString("utf8").split("\n").length <= 8000)) { change.omitted = "non_text_or_large"; continue; }
          change.lines = (await reviewDiff(old, next, signal)).map(line => ({ ...line, text: codeDisplayText(line.text) }));
          diffBytes += Buffer.byteLength(JSON.stringify(change)); if (diffBytes > 4 * 1024 * 1024) throw limit();
        }
        code = { baseSha: m.baseSha, sourceHead: m.sourceHead, worktreeCommit: m.worktreeCommit, manifestHash: initial.result.manifestHash, changes, excluded, omissions: m.omissions };
        captured = { title: m.context.title, description: m.context.description, acceptance: m.context.acceptance, dependencies: m.dependencies, contracts: m.contracts, resolution: m.resolution };
      } catch (error) { if (error instanceof DomainError) throw error; throw unavailable(); }
      // READ COMMITTED rechecks authorization AND all mutable observations after
      // file IO. A downloaded package is a dated record, never a live approval.
      const fresh = await metadata(db, resultId);
      if (reviewHash(JSON.stringify(fresh)) !== metadataHash) throw new DomainError("evidence_changed", "汇集期间记录发生变化，请重新汇集当前证据。", 409);
      const cleaned = redact({ observedAt: new Date().toISOString(), metadataHash, ...fresh, captured, code,
        authority: "Historical evidence only. Validation is produced by the platform executor; discussion and publication notes are human/agent statements. Every approval applies only to its recorded revision. Recheck live authority before merge.",
        limits: ["No private reasoning, raw session, credentials or raw tool/validation output included.", "Binary/large/excluded/secret-pattern code is identified but not represented as reviewed text.", "GitHub entries are task history and do not imply approval of this result.", "A downloaded record cannot receive later revocations. Reopen the authorized result to check current state."] });
      const payload = { ...cleaned.value, redactions: cleaned.redactions };
      const bytes = JSON.stringify(payload); if (Buffer.byteLength(bytes) > 8 * 1024 * 1024) throw limit();
      return { format: "pi-collab-evidence/v1" as const, sha256: reviewHash(bytes), payload };
    });
  } finally { slots.__piEvidenceReaders!--; }
}
export type ResultEvidenceBundle = Awaited<ReturnType<typeof resultEvidence>>;
