import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { runnerEnvironment } from "./workspace";
import { nativeBootId } from "./receipts";
import { ReviewGit, reviewHash } from "./review-git";
import { sourceSchema, commitIdentitySchema, workspaceStageSelection, workspaceGitObjectId, type GitEntry, type WorkspaceGitLock } from "./workspace-git-view";

const sha = z.string().regex(/^[a-f0-9]{40}$/), hash = z.string().regex(/^[a-f0-9]{64}$/);
export const operationRequestSchema = z.object({
  version: z.literal(1), operationId: z.uuid(), source: sourceSchema, revision: hash, planHash: hash,
  kind: z.enum(["stage", "commit"]), selections: z.array(workspaceStageSelection).min(1).max(200).nullable(), identity: commitIdentitySchema.nullable(),
  head: sha, indexHash: hash, afterIndexHash: hash.nullable(), commit: sha.nullable(),
}).strict().refine(r => r.kind === "stage" ? r.selections !== null && r.identity === null && r.afterIndexHash !== null && r.commit === null
  : r.selections === null && r.identity?.operationId === r.operationId && r.commit !== null && r.afterIndexHash === null);
export type WorkspaceGitRequest = z.infer<typeof operationRequestSchema>;
const attemptSchema = z.object({ id: z.uuid(), pid: z.number().int().min(2), bootId: z.string().min(16).max(128), mode: z.enum(["execute", "recover"]) }).strict();
const lockSchema = z.object({ name: z.string().max(128), dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/) }).strict();
export const operationStateSchema = z.object({
  version: z.literal(1), request: operationRequestSchema,
  phase: z.enum(["reserved", "running", "prepared", "authorized", "applied", "aborted"]),
  attempt: attemptSchema.nullable(), locks: z.array(lockSchema).max(3), released: z.boolean(), reason: z.string().max(100).nullable(),
}).strict();
export type WorkspaceGitOperationState = z.infer<typeof operationStateSchema>;
export type WorkspaceGitControl = { oid: string; state: WorkspaceGitOperationState };
export const controlRef = "refs/heads/operations";
export function fail(code: string): never { throw new Error(`workspace_git_operation_${code}`); }
export const terminal = (state: WorkspaceGitOperationState) => state.phase === "applied" || state.phase === "aborted";
export const zero = "0".repeat(40);

export async function command(cwd: string, args: string[], input?: Buffer | string, codes = [0], signal = AbortSignal.timeout(30000)) {
  return new Promise<{ code: number; bytes: Buffer }>((resolve, reject) => {
    if (signal.aborted) { reject(new Error("workspace_git_operation_cancelled")); return; }
    const child = spawn("git", ["--no-pager", "--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.attributesFile=/dev/null", "-c", "protocol.allow=never", "-c", "core.fsync=committed", "-c", "core.fsyncMethod=fsync", ...args], {
      cwd, env: { ...runnerEnvironment("/nonexistent", "/nonexistent"), GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_CEILING_DIRECTORIES: cwd }, stdio: "pipe",
    });
    const chunks: Buffer[] = []; let size = 0, failed = false;
    const stop = () => { failed = true; child.kill("SIGKILL"); };
    signal.addEventListener("abort", stop, { once: true }); const timer = setTimeout(stop, 30000);
    child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 8 * 1024 * 1024) stop(); else chunks.push(chunk); });
    child.stderr.resume(); child.stdin.on("error", () => {}); child.stdin.end(input);
    child.once("error", () => { failed = true; });
    child.once("close", code => { clearTimeout(timer); signal.removeEventListener("abort", stop); if (failed || code === null || !codes.includes(code)) reject(new Error("workspace_git_operation_git_failed")); else resolve({ code, bytes: Buffer.concat(chunks) }); });
  });
}
export async function regular(file: string, limit = 8 * 1024 * 1024) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat(); if (!before.isFile() || before.nlink !== 1 || before.size > limit) fail("unsafe_file");
    const bytes = await handle.readFile(), after = await handle.stat();
    if (bytes.length > limit || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail("changed_file");
    return bytes;
  } finally { await handle.close(); }
}
export async function directory(file: string) { const info = await lstat(file); if (!info.isDirectory() || info.isSymbolicLink()) fail("unsafe_path"); }
export async function locations(rawRoot: string, workspaceId: string) {
  z.uuid().parse(workspaceId); const root = await realpath(rawRoot);
  let checkout = root;
  for (const segment of ["workspaces", workspaceId, "checkout"]) { checkout = path.join(checkout, segment); await directory(checkout); }
  await directory(path.join(checkout, ".git"));
  return { root, checkout, control: path.join(root, "workspace-git-control", `${workspaceId}.git`) };
}
/** Mutation must not operate through shared writable metadata/object hardlinks. */
export async function exclusiveGit(checkout: string) {
  let count = 0;
  const walk = async (dir: string) => {
    for (const name of await readdir(dir)) {
      if (++count > 50000) fail("limit");
      const file = path.join(dir, name), stat = await lstat(file);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) fail("shared_metadata");
      if (stat.isDirectory()) await walk(file);
    }
  };
  await walk(path.join(checkout, ".git"));
}
export async function ensureControl(root: string, workspaceId: string) {
  const where = await locations(root, workspaceId), parent = path.dirname(where.control);
  await mkdir(parent, { recursive: true, mode: 0o700 }); await directory(parent);
  try { await directory(where.control); return where; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temp = path.join(parent, `${workspaceId}.${randomUUID()}.init`);
  try {
    await command(parent, ["init", "--bare", "--template=", "--object-format=sha1", temp]);
    await command(temp, ["hash-object", "-w", "-t", "tree", "--stdin"], "");
    try { await rename(temp, where.control); await syncDir(parent); }
    catch (error) { if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; await directory(where.control); }
    return where;
  } finally { await rm(temp, { recursive: true, force: true }); }
}
export async function readControl(root: string, workspaceId: string): Promise<WorkspaceGitControl | null> {
  const where = await locations(root, workspaceId), reader = await ReviewGit.open(where.root, ["workspace-git-control", `${workspaceId}.git`], AbortSignal.timeout(30000));
  const result = await command(where.control, ["show-ref", "--verify", "--hash", controlRef], undefined, [0, 1, 128]);
  if (result.code === 1 || result.code === 128) {
    // --quiet distinguishes absence from corrupt refs without trusting stderr.
    if ((await command(where.control, ["show-ref", "--verify", "--quiet", controlRef], undefined, [0, 1])).code === 1) return null;
    fail("invalid_control");
  }
  const oid = sha.parse(result.bytes.toString().trim()), bytes = (await reader.objects([oid], "commit", 4 * 1024 * 1024)).get(oid)!;
  const separator = bytes.indexOf("\n\n"); if (separator < 0) fail("invalid_control");
  const state = operationStateSchema.parse(JSON.parse(bytes.subarray(separator + 2).toString("utf8")));
  if (state.request.source.workspaceId !== workspaceId) fail("invalid_control");
  return { oid, state };
}
/** One-ref CAS: a delayed completion/cleanup can never overwrite a newer owner. */
export async function transition(root: string, workspaceId: string, expected: string | null, raw: WorkspaceGitOperationState) {
  const state = operationStateSchema.parse(raw), where = await locations(root, workspaceId);
  if (state.request.source.workspaceId !== workspaceId) fail("invalid_control");
  const bytes = Buffer.from(`tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n${expected ? `parent ${sha.parse(expected)}\n` : ""}author pi-collab <platform@pi-collab.invalid> 946684800 +0000\ncommitter pi-collab <platform@pi-collab.invalid> 946684800 +0000\n\n${JSON.stringify(state)}\n`);
  if (bytes.length > 4 * 1024 * 1024) fail("limit");
  const oid = workspaceGitObjectId("commit", bytes);
  if ((await command(where.control, ["hash-object", "-w", "-t", "commit", "--stdin"], bytes)).bytes.toString().trim() !== oid) fail("invalid_control");
  await command(where.control, ["update-ref", "--no-deref", controlRef, oid, expected ?? zero]);
  return { oid, state };
}
/** A permanent ID allocation may precede a failed ownership CAS. Such IDs are
 * deliberately consumed; they can never reopen an older operation later. */
export async function allocateOperation(root: string, workspaceId: string, request: WorkspaceGitRequest) {
  const where = await locations(root, workspaceId), bytes = Buffer.from(JSON.stringify(operationRequestSchema.parse(request)));
  const oid = workspaceGitObjectId("blob", bytes);
  if ((await command(where.control, ["hash-object", "-w", "--stdin"], bytes)).bytes.toString().trim() !== oid) fail("invalid_control");
  await command(where.control, ["update-ref", "--no-deref", `refs/requests/${request.operationId}`, oid, zero]);
}
export async function exited(state: WorkspaceGitOperationState) {
  if (!state.attempt) return state.phase === "reserved" || state.phase === "aborted";
  if (state.attempt.bootId !== await nativeBootId()) return false;
  for (const pid of [state.attempt.pid, -state.attempt.pid]) {
    try { process.kill(pid, 0); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false; }
  }
  return true;
}
export async function lockIdentity(checkout: string, name: string): Promise<WorkspaceGitLock> {
  const info = await lstat(path.join(checkout, ".git", name), { bigint: true });
  if (!info.isFile() || info.nlink !== BigInt(1)) fail("unsafe_lock");
  return { name, dev: String(info.dev), ino: String(info.ino) };
}
export async function matchingLock(checkout: string, lock: WorkspaceGitLock) {
  try { return JSON.stringify(await lockIdentity(checkout, lock.name)) === JSON.stringify(lock); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
export async function syncDir(dir: string) { const handle = await open(dir, "r"); try { await handle.sync(); } finally { await handle.close(); } }
export function encodeIndex(entries: GitEntry[]) {
  const header = Buffer.alloc(12); header.write("DIRC"); header.writeUInt32BE(2, 4); header.writeUInt32BE(entries.length, 8);
  const records = [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))).map(entry => {
    const name = Buffer.from(entry.path), record = Buffer.alloc(Math.ceil((62 + name.length + 1) / 8) * 8);
    record.writeUInt32BE(parseInt(entry.mode, 8), 24); Buffer.from(entry.oid, "hex").copy(record, 40); record.writeUInt16BE(Math.min(name.length, 0xfff), 60); name.copy(record, 62); return record;
  });
  const data = Buffer.concat([header, ...records]); return Buffer.concat([data, createHash("sha1").update(data).digest()]);
}
export { reviewHash, nativeBootId };
