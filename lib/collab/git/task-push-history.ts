import { isUtf8 } from "node:buffer";
import { z } from "zod";
import { ReviewGit, reviewDiff, reviewHash } from "../runtime/review-git";
import { snapshotExcludedPath } from "../runtime/snapshots";
import { codeDisplayText } from "../integration-code-schema";
import { DomainError } from "../policy";
import { taskPushRef } from "./task-push-protocol";
import { taskPushTreeFiles, taskPushBytesSensitive, verifyTaskPushExport, type TaskPushExportManifest } from "./task-push-export";
import { pushHistoryQuery, pushHistoryDownloadQuery, type PushHistory, type PushHistoryCommit, type PushHistoryChange,
  type PushHistoryContent, type PushHistoryIdentity, type PushHistorySide } from "./push-preview-schema";

const TEXT_LIMIT = 256 * 1024, FILE_LIMIT = 2 * 1024 * 1024;
const unavailable = () => new DomainError("task_push_history_unavailable", "原推送导出不可用、已损坏或超出读取限制，请重新生成预览。", 409);
const missing = () => new DomainError("task_push_history_not_found", "此提交或文件不属于固定的出站历史。", 404);
const same = (a: PushHistorySide | undefined, b: PushHistorySide | undefined) => a?.oid === b?.oid && a?.mode === b?.mode;

/** Internal read-only reader. The expected hash MUST come from the authorized
 * SQL record, never from the query string or the artifact's own contents. */
export class TaskPushHistoryReader {
  readonly identity: PushHistoryIdentity;
  private constructor(private readonly manifest: TaskPushExportManifest, private readonly reader: ReviewGit,
    manifestHash: string, private readonly signal: AbortSignal) {
    const { input } = manifest;
    this.identity = { previewId: input.exportId, manifestHash, runId: input.source.identity.runId,
      repositoryId: input.intent.repositoryId, taskId: input.intent.taskId, workspaceId: input.source.workspaceId,
      head: input.intent.newSha, baseline: input.remoteBaseline.sha, expectedOld: input.intent.expectedOld,
      ref: taskPushRef({ taskId: input.intent.taskId, workspaceId: input.intent.workspaceId }), policy: manifest.policy };
  }
  static async open(root: string, exportId: string, authoritativeHash: string, signal: AbortSignal) {
    const { manifest } = await verifyTaskPushExport(root, exportId, authoritativeHash, signal);
    return new TaskPushHistoryReader(manifest, await ReviewGit.open(root, ["task-push-exports", exportId, "git"], signal), authoritativeHash, signal);
  }
  private version(hash: string) {
    if (this.signal.aborted) throw unavailable();
    if (hash !== this.identity.manifestHash) throw new DomainError("task_push_history_stale", "出站历史版本不匹配，请重新打开原预览。", 409);
  }
  confirmationCommits() {
    this.version(this.identity.manifestHash);
    // open() has independently checked every recorded object's exact bytes.
    return this.manifest.commits.map(commit => {
      const object = this.manifest.objects.find(item => item.oid === commit.oid && item.type === "commit");
      if (!object) throw unavailable();
      return { oid: commit.oid, hash: object.hash, changedPaths: commit.changedPaths };
    }).sort((a, b) => a.oid.localeCompare(b.oid));
  }
  private record(commit: string) {
    const value = this.manifest.commits.find(item => item.oid === commit); if (!value) throw missing(); return value;
  }
  private async commitBytes(commit: string) {
    const record = this.record(commit), bytes = (await this.reader.objects([commit], "commit", 1024 * 1024)).get(commit)!;
    const expected = this.manifest.objects.find(item => item.type === "commit" && item.oid === commit);
    if (!expected || expected.hash !== reviewHash(bytes) || expected.size !== bytes.length || taskPushBytesSensitive(bytes) || !isUtf8(bytes)) throw unavailable();
    const end = bytes.indexOf("\n\n"); if (end < 0) throw unavailable();
    const lines = bytes.subarray(0, end).toString("utf8").split("\n");
    if (lines[0] !== `tree ${record.tree}` || JSON.stringify(lines.filter(line => line.startsWith("parent ")).map(line => line.slice(7))) !== JSON.stringify(record.parents)) throw unavailable();
    return bytes;
  }
  private async metadata(commit: string): Promise<PushHistoryCommit> {
    const bytes = await this.commitBytes(commit), raw = bytes.toString("utf8"), omitted = bytes.length > TEXT_LIMIT || raw.split("\n").length > 8000;
    const text = omitted ? null : codeDisplayText(raw);
    return { ...structuredClone(this.record(commit)), size: bytes.length, hash: reviewHash(bytes), text, escapedControls: text !== null && text !== raw, omitted };
  }
  private async changes(commit: string) {
    const record = this.record(commit); await this.commitBytes(commit);
    const base = (await this.reader.objects([this.identity.baseline], "commit", 1024 * 1024)).get(this.identity.baseline)!;
    const tree = /^tree ([a-f0-9]{40})\n/.exec(base.subarray(0, 46).toString("ascii")); if (!tree) throw unavailable();
    const before = await taskPushTreeFiles(this.reader, tree[1], () => {}, this.signal);
    const after = await taskPushTreeFiles(this.reader, record.tree, () => {}, this.signal), files: PushHistoryChange[] = [];
    for (const name of [...new Set([...before.keys(), ...after.keys()])].sort()) {
      const old = before.get(name), current = after.get(name); if (same(old, current)) continue;
      // A sensitive historical filename must not leak through listing or error
      // messages just because its contents were already on the remote baseline.
      if (taskPushBytesSensitive(Buffer.from(name))) throw unavailable();
      const omitted = snapshotExcludedPath(name) ?? ([old, current].some(item => item && !["100644", "100755"].includes(item.mode)) ? "non_regular_file" : null);
      files.push({ path: name, kind: !old ? "added" : !current ? "deleted" : "modified", before: old ?? null, after: current ?? null, omitted });
    }
    if (files.length !== record.changedPaths) throw unavailable(); return files;
  }
  private async change(commit: string, path: string) {
    const file = (await this.changes(commit)).find(item => item.path === path); if (!file) throw missing(); return file;
  }
  private async content(side: PushHistorySide): Promise<{ value: PushHistoryContent; bytes: Buffer | null; sensitive: boolean }> {
    const size = (await this.reader.sizes([side.oid])).get(side.oid)!; if (size.type !== "blob") throw unavailable();
    const value: PushHistoryContent = { ...side, size: size.size, hash: null, text: null, encoding: "large", escapedControls: false,
      downloadable: false, lineEndings: { lf: 0, crlf: 0 }, trailingNewline: false };
    if (size.size > FILE_LIMIT) return { value, bytes: null, sensitive: false };
    const bytes = (await this.reader.objects([side.oid], "blob", FILE_LIMIT)).get(side.oid)!;
    if (taskPushBytesSensitive(bytes)) return { value, bytes: null, sensitive: true };
    value.hash = reviewHash(bytes); value.downloadable = true; value.trailingNewline = bytes.at(-1) === 10;
    for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) { value.lineEndings.lf++; if (i > 0 && bytes[i - 1] === 13) value.lineEndings.crlf++; }
    if (!isUtf8(bytes)) value.encoding = "unsupported";
    else if (bytes.includes(0)) value.encoding = "binary";
    else {
      const raw = bytes.toString("utf8");
      if (bytes.length <= TEXT_LIMIT && raw.split("\n").length <= 8000) { value.encoding = "utf8"; value.text = codeDisplayText(raw); value.escapedControls = value.text !== raw; }
    }
    return { value, bytes, sensitive: false };
  }
  async read(raw: unknown): Promise<PushHistory> {
    const query = pushHistoryQuery.parse(raw); this.version(query.manifestHash);
    const identity = structuredClone(this.identity);
    if (query.kind === "commits") {
      const total = this.manifest.commits.length, end = query.offset + 50, commits: PushHistoryCommit[] = [];
      for (const item of this.manifest.commits.slice(query.offset, end)) commits.push(await this.metadata(item.oid));
      return { kind: "commits", identity, total, commits, nextOffset: end < total ? end : null };
    }
    if (query.kind === "changes") {
      const files = await this.changes(query.commit), end = query.offset + 100;
      return { kind: "changes", identity, commit: query.commit, comparison: "remote-baseline", files: files.slice(query.offset, end), total: files.length, nextOffset: end < files.length ? end : null };
    }
    const file = await this.change(query.commit, query.path), fileHash = reviewHash(JSON.stringify({ identity, commit: query.commit, file }));
    const response: Extract<PushHistory, { kind: "file" }> = { kind: "file", identity, commit: query.commit, file, fileHash,
      before: null, after: null, omitted: file.omitted, lines: [] };
    if (file.omitted) return response;
    const before = file.before ? await this.content(file.before) : null, after = file.after ? await this.content(file.after) : null;
    if (before?.sensitive || after?.sensitive) return { ...response, omitted: "secret_pattern" };
    response.before = before?.value ?? null; response.after = after?.value ?? null;
    if ([before, after].some(item => item && item.value.text === null)) response.omitted = "non_text_or_large";
    else response.lines = (await reviewDiff(before?.bytes ?? Buffer.alloc(0), after?.bytes ?? Buffer.alloc(0), this.signal)).map(line => ({ ...line, text: codeDisplayText(line.text) }));
    return response;
  }
  async download(raw: z.input<typeof pushHistoryDownloadQuery>) {
    const query = pushHistoryDownloadQuery.parse(raw); this.version(query.manifestHash);
    let bytes: Buffer, oid: string;
    if (query.kind === "commit") { oid = query.commit; bytes = await this.commitBytes(oid); }
    else {
      const file = await this.change(query.commit, query.path), side = file[query.side];
      if (!side || file.omitted) throw missing();
      // Do not offer a raw-byte bypass for a file whose review was redacted.
      const before = file.before ? await this.content(file.before) : null, after = file.after ? await this.content(file.after) : null;
      const selected = query.side === "before" ? before : after;
      if (before?.sensitive || after?.sensitive || !selected?.bytes) throw unavailable(); bytes = selected.bytes; oid = side.oid;
    }
    if (this.signal.aborted) throw unavailable();
    return { identity: structuredClone(this.identity), filename: `${query.kind}-${oid}.bin`, size: bytes.length, hash: reviewHash(bytes), bytesBase64: bytes.toString("base64") };
  }
}
