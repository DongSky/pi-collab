import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { managedGit } from "./github-pack";
import { ReviewGit } from "../runtime/review-git";

const ZERO = "0".repeat(40), PACK_LIMIT = 64 * 1024 * 1024;
const sha = z.string().regex(/^[a-f0-9]{40}$/).refine(value => value !== ZERO);
const scope = z.object({ taskId: z.uuid(), workspaceId: z.uuid() }).strict();
export const taskPushIntent = scope.extend({ operationId: z.uuid(), repositoryId: z.uuid(), expectedOld: sha.nullable(), newSha: sha }).strict()
  .refine(value => value.expectedOld !== value.newSha);
export type TaskPushIntent = z.infer<typeof taskPushIntent>;
export function taskPushRef(raw: z.infer<typeof scope>) {
  const value = scope.parse(raw);
  return `refs/heads/pi-collab/tasks/${value.taskId.toLowerCase()}/workspaces/${value.workspaceId.toLowerCase()}`;
}
export class TaskPushError extends Error { constructor(readonly code: string) { super(`task_push_${code}`); } }
const fail = (code: string): never => { throw new TaskPushError(code); };
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const packet = (line: string) => { const bytes = Buffer.from(line); return Buffer.concat([Buffer.from((bytes.length + 4).toString(16).padStart(4, "0")), bytes]); };

/** A fixed repository transport supplied by a trusted broker. This module never
 * accepts a URL, token, refspec, force flag or shell command from a caller. */
export type TaskPushTransport = (kind: "advertise" | "receive", signal: AbortSignal, body?: Uint8Array) => Promise<Response>;
export type TaskPushAttempt = Readonly<TaskPushIntent & { ref: string; packHash: string; requestHash: string; requestBytes: number }>;
export type TaskPushOutcome =
  | { status: "not_sent"; reason: "remote_changed" | "authority_denied" | "cancelled" }
  | { status: "acknowledged"; newSha: string; responseHash: string }
  | { status: "rejected"; reason: "unpack_failed" | "ref_rejected"; responseHash: string }
  | { status: "unknown"; reason: "response_unconfirmed" };

/** Strict protocol v0 pkt-lines. Sideband, response options, trailing bytes and
 * truncated reports are not interpreted as successful writes. */
function packets(bytes: Buffer): (Buffer | null)[] {
  const result: (Buffer | null)[] = []; let offset = 0;
  while (offset < bytes.length) {
    if (result.length >= 50000 || offset + 4 > bytes.length) fail("invalid_protocol");
    const prefix = bytes.subarray(offset, offset + 4).toString("utf8");
    if (!/^[0-9a-f]{4}$/.test(prefix)) fail("invalid_protocol");
    const length = parseInt(prefix, 16); offset += 4;
    if (!length) { result.push(null); continue; }
    if (length < 4 || length > 65520 || offset + length - 4 > bytes.length) fail("invalid_protocol");
    result.push(bytes.subarray(offset, offset + length - 4)); offset += length - 4;
  }
  return result;
}
async function responseBytes(response: Response, kind: "advertisement" | "result", signal: AbortSignal) {
  try {
    const limit = kind === "advertisement" ? 4 * 1024 * 1024 : 64 * 1024;
    if (response.status !== 200 || response.headers.get("content-type")?.split(";")[0] !== `application/x-git-receive-pack-${kind}` || !response.body) fail("invalid_response");
    if (Number(response.headers.get("content-length")) > limit) fail("response_limit");
    const reader = response.body!.getReader(), chunks: Buffer[] = []; let size = 0;
    const stop = () => { void reader.cancel().catch(() => {}); }; signal.addEventListener("abort", stop, { once: true });
    try {
      for (;;) {
        if (signal.aborted) fail("cancelled");
        const next = await reader.read(); if (next.done) break;
        size += next.value.length; if (size > limit) fail("response_limit"); chunks.push(Buffer.from(next.value));
      }
      if (signal.aborted) fail("cancelled"); return Buffer.concat(chunks);
    } finally { signal.removeEventListener("abort", stop); await reader.cancel().catch(() => {}); }
  } finally { await response.body?.cancel().catch(() => {}); }
}
function advertisement(bytes: Buffer, ref: string) {
  const rows = packets(bytes);
  if (rows.length < 4 || rows[0]?.toString() !== "# service=git-receive-pack\n" || rows[1] !== null || rows.at(-1) !== null) fail("invalid_advertisement");
  const refs = new Map<string, string>(); let capabilities: string[] = [];
  for (let index = 2; index < rows.length - 1; index++) {
    const bytes = rows[index]; if (!bytes || !isUtf8(bytes)) fail("invalid_advertisement");
    const line = bytes!.toString("utf8").replace(/\n$/, "");
    const fields = line.split("\0");
    if ((index === 2 && fields.length !== 2) || (index !== 2 && fields.length !== 1)) fail("invalid_advertisement");
    if (index === 2) {
      capabilities = fields[1].split(" ").filter(Boolean);
      if (capabilities.some(value => /[\x00-\x20\x7f]/.test(value))) fail("invalid_advertisement");
    }
    const match = /^([a-f0-9]{40}) ([^\x00-\x20\x7f]+)$/.exec(fields[0]);
    if (!match || refs.has(match[2])) fail("invalid_advertisement");
    refs.set(match![2], match![1]);
  }
  if (!capabilities.includes("report-status") || capabilities.some(value => value.startsWith("object-format=") && value !== "object-format=sha1")) fail("unsupported_protocol");
  // The all-zero pseudo-ref is valid only for an entirely empty repository.
  if ([...refs].some(([name, id]) => id === ZERO && (name !== "capabilities^{}" || refs.size !== 1))) fail("invalid_advertisement");
  return refs.get(ref) ?? null;
}
function report(bytes: Buffer, ref: string, newSha: string): TaskPushOutcome {
  const rows = packets(bytes), responseHash = hash(bytes);
  if (rows.length !== 3 || !rows[0] || !rows[1] || rows[2] !== null || !isUtf8(rows[0]) || !isUtf8(rows[1])) fail("invalid_report");
  const unpack = rows[0]!.toString("utf8"), result = rows[1]!.toString("utf8");
  if (!/^unpack [^\x00\r\n]+\n$/.test(unpack)) fail("invalid_report");
  if (unpack === "unpack ok\n" && result === `ok ${ref}\n`) return { status: "acknowledged", newSha, responseHash };
  if (!result.startsWith(`ng ${ref} `) || !/^[^\x00\r\n]+\n$/.test(result)) fail("invalid_report");
  return { status: "rejected", reason: unpack === "unpack ok\n" ? "ref_rejected" : "unpack_failed", responseHash };
}

/** Internal protocol foundation, NOT a public push API. The input directory must
 * be a broker-owned, immutable and already disclosure-checked bare repository.
 * This class does not authorize membership, scan source history for secrets,
 * persist attempts, grant GitHub write credentials or settle uncertain jobs. */
export class PreparedTaskPush {
  #used = false;
  private constructor(private readonly intent: TaskPushIntent, private readonly request: Buffer, readonly attempt: TaskPushAttempt) {}
  static async prepare(directory: string, raw: TaskPushIntent, external: AbortSignal) {
    const signal = AbortSignal.any([external, AbortSignal.timeout(180000)]);
    const intent = taskPushIntent.parse(raw), ref = taskPushRef({ taskId: intent.taskId, workspaceId: intent.workspaceId });
    // Do not let grafts, alternate stores or acceleration metadata fabricate
    // ancestry. The broker must also exclude writers throughout preparation.
    await ReviewGit.open(path.dirname(directory), [path.basename(directory)], signal);
    for (const name of ["info/grafts", "shallow", "commondir"]) {
      try { await lstat(path.join(directory, name)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      fail("source_invalid");
    }
    const git = async (args: string[], input?: string, limit?: number, codes?: number[]) => managedGit(directory, ["--git-dir=.", "-c", "core.commitGraph=false", ...args], signal, { input, limit, codes });
    const text = async (args: string[]) => (await git(args)).bytes.toString("utf8").trim();
    if (await text(["rev-parse", "--is-bare-repository"]) !== "true" || await text(["rev-parse", "--is-shallow-repository"]) !== "false" || await text(["rev-parse", "--show-object-format"]) !== "sha1") fail("source_invalid");
    for (const id of [intent.newSha, ...(intent.expectedOld ? [intent.expectedOld] : [])]) if (await text(["cat-file", "-t", id]) !== "commit") fail("commit_required");
    await git(["fsck", "--strict", "--full", "--no-reflogs", intent.newSha]);
    if (intent.expectedOld && (await git(["merge-base", "--is-ancestor", intent.expectedOld, intent.newSha], undefined, undefined, [0, 1])).code !== 0) fail("non_fast_forward");
    // No thin pack: a prepared request is a self-contained immutable byte string.
    // --revs includes only the exact commit closure, never --all or mutable refs.
    const pack = (await git(["pack-objects", "--stdout", "--revs", "--no-reuse-delta", "--no-reuse-object", "--no-use-bitmap-index", "--threads=1"],
      `${intent.newSha}\n${intent.expectedOld ? `^${intent.expectedOld}\n` : ""}`, PACK_LIMIT)).bytes;
    if (pack.length < 32 || pack.subarray(0, 4).toString() !== "PACK" || ![2, 3].includes(pack.readUInt32BE(4)) || !pack.subarray(-20).equals(createHash("sha1").update(pack.subarray(0, -20)).digest())) fail("pack_invalid");
    const request = Buffer.concat([packet(`${intent.expectedOld ?? ZERO} ${intent.newSha} ${ref}\0report-status\n`), Buffer.from("0000"), pack]);
    const attempt = Object.freeze({ ...intent, ref, packHash: hash(pack), requestHash: hash(request), requestBytes: request.length });
    return new PreparedTaskPush(intent, request, attempt);
  }
  /** The gate must durably record this exact attempt and check current authority
   * BEFORE returning true. It is mandatory even after successful preflight.
   * Never call again to recover an unknown result; use observation only. */
  async execute(transport: TaskPushTransport, authorize: (attempt: TaskPushAttempt) => Promise<boolean>, external: AbortSignal): Promise<TaskPushOutcome> {
    if (this.#used) fail("attempt_consumed"); this.#used = true;
    const signal = AbortSignal.any([external, AbortSignal.timeout(180000)]);
    if (signal.aborted) return { status: "not_sent", reason: "cancelled" };
    const before = advertisement(await responseBytes(await transport("advertise", signal), "advertisement", signal), this.attempt.ref);
    if (before !== this.intent.expectedOld) return { status: "not_sent", reason: "remote_changed" };
    if (await authorize(this.attempt) !== true) return { status: "not_sent", reason: "authority_denied" };
    if (signal.aborted) return { status: "not_sent", reason: "cancelled" };
    // From this point a network failure/cancellation is not evidence of failure.
    // Exactly one receive request is possible per instance, with no retry loop.
    try { return report(await responseBytes(await transport("receive", signal, new Uint8Array(this.request)), "result", signal), this.attempt.ref, this.intent.newSha); }
    catch { return { status: "unknown", reason: "response_unconfirmed" }; }
  }
}

/** Read-only evidence. Seeing the old SHA does not prove that a late remote
 * request cannot still apply; even the desired SHA does not prove attribution.
 * This function intentionally cannot mark a durable job applied/aborted. */
export async function observeTaskPush(raw: TaskPushIntent, transport: TaskPushTransport, external: AbortSignal) {
  const intent = taskPushIntent.parse(raw), ref = taskPushRef({ taskId: intent.taskId, workspaceId: intent.workspaceId });
  const signal = AbortSignal.any([external, AbortSignal.timeout(30000)]);
  const bytes = await responseBytes(await transport("advertise", signal), "advertisement", signal), observedSha = advertisement(bytes, ref);
  return { ref, observedSha, relation: observedSha === intent.newSha ? "at_desired" as const : observedSha === intent.expectedOld ? "at_expected" as const : "changed" as const, advertisementHash: hash(bytes) };
}
