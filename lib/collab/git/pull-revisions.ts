import path from "node:path";
import { isUtf8 } from "node:buffer";
import { z } from "zod";
import { asUser } from "../database";
import { DomainError } from "../policy";
import { reviewDiff, reviewHash } from "../runtime/review-git";
import { codeDisplayText } from "../integration-code-schema";
import { taskPushBytesSensitive } from "./task-push-export";
import { verifyPullRevision } from "./pull-revision";
import { pullRevisionRequest, pullRevisionCancel, revisionCodeQuery, revisionFileQuery, type PullRevisionContext, type PullRevisionRecord, type RevisionCodePage, type RevisionCodeFile } from "./pull-revision-schema";
export function pullRevisionContext(userId: string, changeId: string) {
  z.uuid().parse(changeId);
  return asUser(userId, async db => (await db.query<{ result: PullRevisionContext }>("SELECT collab.pull_revision_context($1) AS result", [changeId])).rows[0].result);
}
export function requestPullRevision(userId: string, changeId: string, raw: z.input<typeof pullRevisionRequest>) {
  z.uuid().parse(changeId); const { idempotencyKey, ...payload } = pullRevisionRequest.parse(raw);
  return asUser(userId, async db => (await db.query<{ result: PullRevisionRecord & { replayed: boolean } }>("SELECT collab.request_pull_revision($1,$2,$3) AS result", [changeId, idempotencyKey, payload])).rows[0].result);
}
export function cancelPullRevision(userId: string, jobId: string, raw: z.input<typeof pullRevisionCancel>) {
  z.uuid().parse(jobId); const value = pullRevisionCancel.parse(raw);
  return asUser(userId, async db => (await db.query<{ result: PullRevisionRecord & { replayed: boolean } }>("SELECT collab.cancel_pull_revision($1,$2,$3) AS result", [jobId, value.idempotencyKey, value.reason])).rows[0].result);
}
const unavailable = () => new DomainError("pull_revision_unavailable", "固定代码版本不可用或校验失败，历史记录保留。", 409);
type Artifact = { record: PullRevisionRecord; manifestHash: string };
async function authorized<T>(userId: string, id: string, work: (artifact: Artifact, checked: Awaited<ReturnType<typeof verifyPullRevision>>, signal: AbortSignal) => Promise<T>, external?: AbortSignal) {
  z.uuid().parse(id); const signal = AbortSignal.any([external ?? new AbortController().signal, AbortSignal.timeout(30000)]);
  return asUser(userId, async db => {
    const load = async () => (await db.query<{ result: Artifact }>("SELECT collab.pull_revision_artifact($1) AS result", [id])).rows[0].result;
    const artifact = await load(); let output;
    try {
      const checked = await verifyPullRevision(process.env.PI_COLLAB_DATA_DIR ?? path.resolve(".local"), id, artifact.manifestHash, signal);
      output = await work(artifact, checked, signal);
    } catch (error) { if (error instanceof DomainError) throw error; throw unavailable(); }
    // Revoke access even if permissions changed while disk/Git work was running.
    await load(); if (signal.aborted) throw unavailable(); return output;
  });
}
export function pullRevisionCode(userId: string, id: string, raw: z.input<typeof revisionCodeQuery>, signal?: AbortSignal) {
  const query = revisionCodeQuery.parse(raw);
  return authorized<RevisionCodePage>(userId, id, async ({ record }, { manifest }) => {
    const end = query.offset + 100;
    return { record, files: manifest.files.slice(query.offset, end), total: manifest.files.length, nextOffset: end < manifest.files.length ? end : null };
  }, signal);
}
export function pullRevisionFile(userId: string, id: string, raw: z.input<typeof revisionFileQuery>, signal?: AbortSignal) {
  const query = revisionFileQuery.parse(raw);
  return authorized<RevisionCodeFile>(userId, id, async ({ record }, { manifest, reader }, deadline) => {
    if (manifest.diffHash !== query.diffHash) throw new DomainError("stale_revision", "代码差异版本不匹配。", 409);
    const file = manifest.files.find(f => f.path === query.path);
    if (!file) throw new DomainError("not_found", "文件不属于此固定代码版本。", 404);
    const output: RevisionCodeFile = { record, path: file.path, omitted: file.omitted, before: null, after: null, lines: [] };
    if (file.omitted) return output;
    const values: Record<"before" | "after", Buffer> = { before: Buffer.alloc(0), after: Buffer.alloc(0) };
    for (const side of ["before", "after"] as const) {
      const entry = file[side]; if (!entry) continue;
      const bytes = (await reader.objects([entry.oid], "blob", 2 * 1024 * 1024)).get(entry.oid)!;
      if (bytes.length !== entry.size || reviewHash(bytes) !== entry.hash || taskPushBytesSensitive(bytes)) throw unavailable();
      if (bytes.length > 256 * 1024 || !isUtf8(bytes) || bytes.includes(0) || bytes.toString("utf8").split("\n").length > 8000) {
        return { ...output, before: null, after: null, omitted: "non_text_or_large" };
      }
      values[side] = bytes; output[side] = codeDisplayText(bytes.toString("utf8"));
    }
    output.lines = (await reviewDiff(values.before, values.after, deadline)).map(line => ({ ...line, text: codeDisplayText(line.text) }));
    return output;
  }, signal);
}
