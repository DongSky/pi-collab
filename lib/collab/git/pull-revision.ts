import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ReviewGit } from "../runtime/review-git";
import { snapshotExcludedPath } from "../runtime/snapshots";
import type { GitHubGitRead } from "./github-client";
import { githubBranch, githubId } from "./github-schema";
import { gitReadRelay, managedGit } from "./github-pack";
import { taskPushBytesSensitive, taskPushTreeFiles } from "./task-push-export";

const sha = z.string().regex(/^[a-f0-9]{40}$/), hash = z.string().regex(/^[a-f0-9]{64}$/);
const PACK_LIMIT = 64 * 1024 * 1024, FILE_LIMIT = 2 * 1024 * 1024, OBJECT_LIMIT = 200000;
/** Broker-supplied observed identity only. This internal primitive grants no
 * membership, provider or publication authority and is not a web entry point. */
export const pullRevisionInput = z.object({ version: z.literal(1), revisionId: z.uuid(), changeId: z.uuid(), repositoryId: z.uuid(),
  githubRepositoryId: githubId, pullId: githubId, pullNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  observationId: z.uuid(), observationHash: hash, headSha: sha, baseSha: sha, headRef: githubBranch, baseRef: githubBranch,
}).strict();
export type PullRevisionInput = z.infer<typeof pullRevisionInput>;
const side = z.object({ oid: sha, mode: z.enum(["100644", "100755", "120000", "160000"]), size: z.number().int().nonnegative().max(FILE_LIMIT).nullable(), hash: hash.nullable() }).strict();
const file = z.object({ path: z.string().min(1).max(4096), before: side.nullable(), after: side.nullable(), omitted: z.string().nullable() }).strict();
const manifestSchema = z.object({ version: z.literal(1), policy: z.literal("pull-code-v1"), input: pullRevisionInput,
  comparison: z.literal("merge-base-to-head"), mergeBase: sha, headTree: sha, baseTree: sha, mergeBaseTree: sha,
  files: z.array(file).max(10000), diffHash: hash, objectCount: z.number().int().positive().max(OBJECT_LIMIT),
  pack: z.object({ id: sha, hash, size: z.number().int().min(32).max(PACK_LIMIT) }).strict(), configHash: hash,
}).strict();
export type PullRevisionManifest = z.infer<typeof manifestSchema>;
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const fail = (reason: string): never => { throw new Error(`pull_revision_${reason}`); };
const bounded = (signal?: AbortSignal) => AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(180000)]);
const git = (directory: string, args: string[], signal: AbortSignal, input?: Buffer | string, limit = PACK_LIMIT, codes = [0], environment?: Record<string, string>) =>
  managedGit(directory, ["--git-dir=.", "-c", "core.commitGraph=false", ...args], signal, { input, limit, codes, environment });
const text = async (directory: string, args: string[], signal: AbortSignal) => (await git(directory, args, signal)).bytes.toString("utf8").trim();
const refs = { head: "refs/heads/revision/head", base: "refs/heads/revision/base" };
async function fixedFile(file: string, limit: number) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat(); if (!before.isFile() || before.nlink !== 1 || before.size > limit) fail("artifact_invalid");
    const bytes = await handle.readFile(), after = await handle.stat();
    if (bytes.length !== before.size || bytes.length > limit || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail("artifact_changed");
    return bytes;
  } finally { await handle.close(); }
}
async function durable(file: string, bytes: string) {
  const handle = await open(file, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
async function syncTree(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await syncTree(file);
    else if (entry.isFile()) { const handle = await open(file, "r"); try { await handle.sync(); } finally { await handle.close(); } }
    else fail("unsafe_metadata");
  }
  const handle = await open(directory, "r"); try { await handle.sync(); } finally { await handle.close(); }
}
async function repository(root: string, id: string, name: "git" | "incoming.git", signal: AbortSignal) {
  const reader = await ReviewGit.open(root, ["pull-revisions", id, name], signal), directory = path.join(root, "pull-revisions", id, name);
  for (const name of ["shallow", "info/grafts", "commondir"]) {
    try { await lstat(path.join(directory, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    fail("unsafe_metadata");
  }
  if (await text(directory, ["rev-parse", "--is-bare-repository"], signal) !== "true"
    || await text(directory, ["rev-parse", "--show-object-format"], signal) !== "sha1"
    || await text(directory, ["remote"], signal) !== "") fail("unsafe_metadata");
  return { reader, directory };
}
function objectIds(raw: Buffer) {
  const ids = raw.toString("ascii").trim().split("\n");
  if (!ids.length || ids.length > OBJECT_LIMIT || ids.some(id => !sha.safeParse(id).success) || new Set(ids).size !== ids.length) fail("history_limit");
  return ids;
}
async function inspect(reader: ReviewGit, directory: string, input: PullRevisionInput, signal: AbortSignal) {
  // Full ancestry is required, never a shallow approximation or mutable ref.
  const ids = objectIds((await git(directory, ["rev-list", "--objects", "--no-object-names", input.headSha, input.baseSha, "--"], signal, undefined, 9 * 1024 * 1024)).bytes);
  const rawBase = (await git(directory, ["merge-base", "--all", input.headSha, input.baseSha], signal, undefined, 64 * 1024, [0, 1])).bytes.toString("ascii").trim();
  if (!rawBase) fail("unrelated_history");
  const bases = rawBase.split("\n"); if (bases.length !== 1) fail("ambiguous_merge_base");
  const mergeBase = sha.parse(bases[0]);
  const commitIds = [...new Set([input.headSha, input.baseSha, mergeBase])], commits = await reader.objects(commitIds, "commit", 3 * 1024 * 1024);
  const tree = (id: string) => { const match = /^tree ([a-f0-9]{40})\n/.exec(commits.get(id)!.subarray(0, 46).toString("ascii")); if (!match) fail("invalid_commit"); return match![1]; };
  const headTree = tree(input.headSha), baseTree = tree(input.baseSha), mergeBaseTree = tree(mergeBase);
  const before = await taskPushTreeFiles(reader, mergeBaseTree, () => {}, signal), after = await taskPushTreeFiles(reader, headTree, () => {}, signal);
  const files: PullRevisionManifest["files"] = [], cache = new Map<string, { size: number; hash: string; sensitive: boolean }>(); let checked = 0;
  const content = async (value: { oid: string; mode: string } | undefined) => {
    if (!value) return null;
    if (value.mode === "160000") return { ...value, size: null, hash: null };
    if (!cache.has(value.oid)) {
      const size = (await reader.sizes([value.oid])).get(value.oid)!;
      if (size.type !== "blob" || size.size > FILE_LIMIT || (checked += size.size) > PACK_LIMIT) fail("content_limit");
      const bytes = (await reader.objects([value.oid], "blob", FILE_LIMIT)).get(value.oid)!;
      cache.set(value.oid, { size: bytes.length, hash: digest(bytes), sensitive: taskPushBytesSensitive(bytes) });
    }
    const stored = cache.get(value.oid)!; return { ...value, size: stored.size, hash: stored.hash };
  };
  for (const name of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    if (signal.aborted) fail("cancelled");
    const old = before.get(name), current = after.get(name);
    if (old?.oid === current?.oid && old?.mode === current?.mode) continue;
    if (taskPushBytesSensitive(Buffer.from(name))) fail("sensitive_path");
    const a = await content(old), b = await content(current);
    const omitted = snapshotExcludedPath(name) ?? ([old, current].some(s => s && !["100644", "100755"].includes(s.mode)) ? "non_regular_file"
      : [old, current].some(s => s && cache.get(s.oid)?.sensitive) ? "secret_pattern" : null);
    files.push(file.parse({ path: name, before: a, after: b, omitted }));
  }
  const comparison = "merge-base-to-head" as const;
  // Stable across download/repack/request IDs. Target movement still changes
  // this identity even when the merge-base-to-head file changes are identical.
  const diffHash = digest(JSON.stringify({ version: 1, comparison, repositoryId: input.githubRepositoryId, pullId: input.pullId,
    headSha: input.headSha, baseSha: input.baseSha, mergeBase, headTree, baseTree, mergeBaseTree, files }));
  return { comparison, mergeBase, headTree, baseTree, mergeBaseTree, files, diffHash, objectCount: ids.length };
}

/** Captures exact observed commits using a single fixed read-only transport.
 * A failed/partial directory is never reused. No checkout, branch update in a
 * shared repo, project code execution or credential persistence occurs. */
export async function capturePullRevision(root: string, raw: PullRevisionInput, read: GitHubGitRead, external?: AbortSignal) {
  const input = pullRevisionInput.parse(raw), signal = bounded(external); root = await realpath(root);
  if (signal.aborted) fail("cancelled");
  const parent = path.join(root, "pull-revisions"); await mkdir(parent, { recursive: true, mode: 0o700 });
  if ((await lstat(parent)).isSymbolicLink()) fail("unsafe_metadata");
  const directory = path.join(parent, input.revisionId); await mkdir(directory, { mode: 0o700 });
  await managedGit(directory, ["init", "--bare", "--template=", "--object-format=sha1", "incoming.git"], signal);
  const incoming = path.join(directory, "incoming.git"), relay = await gitReadRelay(read, signal);
  try {
    await git(incoming, ["-c", "protocol.http.allow=always", "-c", "protocol.version=2", "-c", "http.followRedirects=false", "-c", "http.proxy=", "-c", "credential.helper=",
      "-c", "fetch.fsckObjects=true", "-c", "transfer.fsckObjects=true", "fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--no-auto-maintenance", "--", relay.url,
      `${input.headSha}:${refs.head}`, `${input.baseSha}:${refs.base}`], signal, undefined, 64 * 1024, [0], relay.environment).catch(error => { relay.assertHealthy(); throw error; });
    relay.assertHealthy();
  } finally { await relay.close(); }
  // The one-time local relay capability is supplied only to the fetch child;
  // no credentials are stored in config.
  await repository(root, input.revisionId, "incoming.git", signal);
  await git(incoming, ["fsck", "--strict", "--full", "--no-reflogs", "--no-dangling"], signal);
  const pack = (await git(incoming, ["pack-objects", "--stdout", "--revs", "--no-reuse-delta", "--no-reuse-object", "--no-use-bitmap-index", "--threads=1"], signal, `${input.headSha}\n${input.baseSha}\n`)).bytes;
  if (pack.length < 32 || pack.subarray(0, 4).toString() !== "PACK" || !pack.subarray(-20).equals(createHash("sha1").update(pack.subarray(0, -20)).digest())) fail("pack_invalid");
  await managedGit(directory, ["init", "--bare", "--template=", "--object-format=sha1", "git"], signal);
  const target = path.join(directory, "git"); await git(target, ["index-pack", "--strict", "--stdin"], signal, pack);
  await git(target, ["update-ref", "--no-deref", refs.head, input.headSha, "0".repeat(40)], signal);
  await git(target, ["update-ref", "--no-deref", refs.base, input.baseSha, "0".repeat(40)], signal);
  await git(target, ["symbolic-ref", "HEAD", refs.head], signal);
  await git(target, ["fsck", "--strict", "--full", "--no-reflogs", "--no-dangling"], signal);
  const { reader } = await repository(root, input.revisionId, "git", signal), evidence = await inspect(reader, target, input, signal);
  const manifest = manifestSchema.parse({ version: 1, policy: "pull-code-v1", input, ...evidence,
    pack: { id: pack.subarray(-20).toString("hex"), hash: digest(pack), size: pack.length }, configHash: digest(await fixedFile(path.join(target, "config"), 4096)) });
  await syncTree(target); if (signal.aborted) fail("cancelled");
  const bytes = JSON.stringify(manifest); await durable(path.join(directory, "manifest.json"), bytes);
  for (const dir of [directory, parent]) { const handle = await open(dir, "r"); try { await handle.sync(); } finally { await handle.close(); } }
  return { manifest, manifestHash: digest(bytes) };
}

/** The expected manifest hash must be loaded from an authorized durable
 * record. Reading an artifact never downloads again or advances a pointer. */
export async function verifyPullRevision(root: string, id: string, expectedHash: string, external?: AbortSignal) {
  z.uuid().parse(id); hash.parse(expectedHash); const signal = bounded(external); root = await realpath(root);
  const { reader, directory } = await repository(root, id, "git", signal);
  const bytes = await fixedFile(path.join(root, "pull-revisions", id, "manifest.json"), 8 * 1024 * 1024);
  if (digest(bytes) !== expectedHash) fail("manifest_changed");
  const manifest = manifestSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (manifest.input.revisionId !== id || digest(await fixedFile(path.join(directory, "config"), 4096)) !== manifest.configHash) fail("artifact_changed");
  if (await text(directory, ["symbolic-ref", "HEAD"], signal) !== refs.head
    || await text(directory, ["for-each-ref", "--format=%(refname) %(objectname)"], signal) !== `${refs.base} ${manifest.input.baseSha}\n${refs.head} ${manifest.input.headSha}`) fail("artifact_changed");
  const pack = await fixedFile(path.join(directory, "objects/pack", `pack-${manifest.pack.id}.pack`), PACK_LIMIT);
  if (pack.length !== manifest.pack.size || digest(pack) !== manifest.pack.hash) fail("artifact_changed");
  await git(directory, ["fsck", "--strict", "--full", "--no-reflogs", "--no-dangling"], signal);
  const evidence = await inspect(reader, directory, manifest.input, signal);
  for (const key of Object.keys(evidence) as (keyof typeof evidence)[]) if (JSON.stringify(manifest[key]) !== JSON.stringify(evidence[key])) fail("artifact_changed");
  return { manifest, reader };
}

export async function readPullRevisionFile(root: string, id: string, expectedHash: string, filePath: string, side: "before" | "after", external?: AbortSignal) {
  if (!["before", "after"].includes(side)) fail("file_not_found");
  const { manifest, reader } = await verifyPullRevision(root, id, expectedHash, external);
  const file = manifest.files.find(file => file.path === filePath), value = file?.[side];
  if (!file || !value) fail("file_not_found");
  if (file!.omitted || !["100644", "100755"].includes(value!.mode)) fail("file_omitted");
  const bytes = (await reader.objects([value!.oid], "blob", FILE_LIMIT)).get(value!.oid)!;
  if (bytes.length !== value!.size || digest(bytes) !== value!.hash || taskPushBytesSensitive(bytes)) fail("artifact_changed");
  return { bytes, hash: value!.hash!, mode: value!.mode, oid: value!.oid, diffHash: manifest.diffHash };
}
