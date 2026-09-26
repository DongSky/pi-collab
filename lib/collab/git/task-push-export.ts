import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, readdir } from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { z } from "zod";
import { ReviewGit } from "../runtime/review-git";
import { inspectWorkspaceGit } from "../runtime/workspace-git-view";
import { safeSnapshotPath, snapshotExcludedPath, snapshotHasSecret } from "../runtime/snapshots";
import { sourceSchema } from "./workspace-schema";
import { managedGit } from "./github-pack";
import { PreparedTaskPush, taskPushIntent } from "./task-push-protocol";

const sha = z.string().regex(/^[a-f0-9]{40}$/), hash = z.string().regex(/^[a-f0-9]{64}$/);
const MAX_COMMITS = 1000, MAX_BASE_COMMITS = 200000, MAX_OBJECTS = 20000, MAX_FILES = 5000, MAX_BYTES = 64 * 1024 * 1024;
export const taskPushExportInput = z.object({ version: z.literal(1), exportId: z.uuid(), source: sourceSchema,
  revision: hash, intent: taskPushIntent,
  // Must come from current authenticated provider/binding evidence, not from
  // a client, mutable repository HEAD or local promotion baseline.
  remoteBaseline: z.object({ sha, observationHash: hash, captureId: z.uuid().optional() }).strict(),
}).strict().refine(value => value.source.workspaceId === value.intent.workspaceId
  && (!value.remoteBaseline.captureId || value.remoteBaseline.captureId === value.exportId));
export type TaskPushExportInput = z.infer<typeof taskPushExportInput>;
const objectRecord = z.object({ oid: sha, type: z.enum(["commit", "tree", "blob"]), size: z.number().int().min(0).max(MAX_BYTES), hash }).strict();
const manifestSchema = z.object({ version: z.literal(1), policy: z.literal("task-history-v1"), input: taskPushExportInput,
  receiptHash: hash, ref: z.string(), basePack: z.object({ id: sha, hash, size: z.number().int().min(32).max(MAX_BYTES) }).strict(),
  commits: z.array(z.object({ oid: sha, tree: sha, parents: z.array(sha).max(32), changedPaths: z.number().int().min(0).max(MAX_FILES * 2) }).strict()).min(1).max(MAX_COMMITS),
  objects: z.array(objectRecord).max(MAX_OBJECTS),
  checkedBytes: z.number().int().min(0).max(MAX_BYTES),
}).strict();
export type TaskPushExportManifest = z.infer<typeof manifestSchema>;
type ObjectType = z.infer<typeof objectRecord>["type"];
type Entry = { mode: string; oid: string };
type ObjectValue = { type: ObjectType; bytes: Buffer };
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
function fail(code: string): never { throw new Error(`task_push_export_${code}`); }
const bounded = (signal?: AbortSignal) => AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(180000)]);
const same = (a: Entry | undefined, b: Entry | undefined) => a?.oid === b?.oid && a?.mode === b?.mode;
const git = (directory: string, args: string[], signal: AbortSignal, input?: Buffer | string, limit = MAX_BYTES) =>
  managedGit(directory, ["--git-dir=.", "-c", "core.commitGraph=false", ...args], signal, { input, limit });
const text = async (directory: string, args: string[], signal: AbortSignal, input?: string, limit?: number) => (await git(directory, args, signal, input, limit)).bytes.toString("utf8").trim();

/** Pattern detection is a policy check, not a guarantee that arbitrary binary,
 * compressed or obfuscated content contains no secrets. UTF-16 is also scanned. */
function sensitive(bytes: Buffer) {
  if (snapshotHasSecret(bytes)) return true;
  const even = bytes.subarray(0, bytes.length - bytes.length % 2);
  return snapshotHasSecret(Buffer.from(even.toString("utf16le"))) || snapshotHasSecret(Buffer.from(Buffer.from(even).swap16().toString("utf16le")));
}
async function repository(root: string, segments: string[], signal: AbortSignal) {
  const reader = await ReviewGit.open(root, segments, signal), directory = path.join(root, ...segments);
  for (const name of ["info/grafts", "shallow", "commondir"]) {
    try { await lstat(path.join(directory, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    fail("unsafe_metadata");
  }
  if (await text(directory, ["rev-parse", "--show-object-format"], signal) !== "sha1") fail("unsupported_format");
  return { reader, directory };
}
async function fixedFile(file: string, limit: number) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat(); if (!before.isFile() || before.nlink !== 1 || before.size > limit) fail("artifact_invalid");
    const bytes = await handle.readFile(), after = await handle.stat();
    if (bytes.length > limit || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail("artifact_changed"); return bytes;
  } finally { await handle.close(); }
}
async function durable(file: string, bytes: Buffer | string) {
  const handle = await open(file, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
async function syncDirectory(directory: string) { const handle = await open(directory, "r"); try { await handle.sync(); } finally { await handle.close(); } }
function commit(bytes: Buffer) {
  if (!isUtf8(bytes) || bytes.length > 1024 * 1024 || bytes.includes(0)) fail("unsupported_commit");
  const end = bytes.indexOf("\n\n"); if (end < 0) fail("invalid_commit");
  const lines = bytes.subarray(0, end).toString("utf8").split("\n"), tree = /^tree ([a-f0-9]{40})$/.exec(lines[0]);
  if (!tree || lines.slice(1).some(line => line.startsWith("tree "))) fail("invalid_commit");
  const parents = lines.filter(line => line.startsWith("parent ")).map(line => sha.parse(line.slice(7)));
  if (parents.length > 32 || new Set(parents).size !== parents.length || lines.some(line => line.startsWith("encoding ") && !/^encoding utf-?8$/i.test(line))) fail("unsupported_commit");
  return { tree: tree![1], parents };
}
function ids(raw: string, maximum: number) {
  const values = raw ? raw.split("\n") : [];
  if (values.length > maximum || new Set(values).size !== values.length || values.some(id => !sha.safeParse(id).success)) fail("history_limit"); return values;
}

/** Raw trees retain excluded references. They never follow symbolic links or
 * submodules; the policy compares every new commit against the known baseline. */
async function treeFiles(reader: ReviewGit, tree: string, remember: (oid: string, value: ObjectValue) => void, signal: AbortSignal) {
  let pending = [{ oid: tree, prefix: "" }], count = 0;
  const files = new Map<string, Entry>(), folded = new Map<string, string>();
  while (pending.length) {
    if (signal.aborted) fail("cancelled");
    const trees = await reader.objects([...new Set(pending.map(item => item.oid))], "tree"), next: typeof pending = [];
    for (const item of pending) {
      const bytes = trees.get(item.oid)!; remember(item.oid, { type: "tree", bytes }); let offset = 0;
      const names = new Set<string>();
      while (offset < bytes.length) {
        const space = bytes.indexOf(32, offset), end = bytes.indexOf(0, space + 1);
        if (space < offset || end < space || end + 21 > bytes.length) fail("invalid_tree");
        const mode = bytes.subarray(offset, space).toString("ascii"), name = bytes.subarray(space + 1, end), oid = bytes.subarray(end + 1, end + 21).toString("hex"); offset = end + 21;
        if (!isUtf8(name) || name.includes(47) || ++count > MAX_FILES) fail("tree_limit");
        const file = item.prefix + name.toString("utf8"), key = file.normalize("NFC").toLowerCase();
        if (!safeSnapshotPath(file) || names.has(file) || (folded.has(key) && folded.get(key) !== file)) fail("unsafe_path");
        names.add(file); folded.set(key, file);
        if (mode === "40000") next.push({ oid, prefix: `${file}/` });
        else if (["100644", "100755", "120000", "160000"].includes(mode) && !files.has(file)) files.set(file, { oid, mode });
        else fail("invalid_tree");
      }
    }
    pending = next;
  }
  return files;
}

async function inspect(root: string, input: TaskPushExportInput, signal: AbortSignal) {
  const view = await inspectWorkspaceGit(root, input.source, signal), summary = view.summary();
  if (summary.revision !== input.revision || summary.head !== input.intent.newSha) fail("source_changed");
  return summary;
}

/** Internal broker operation. SQL must establish current member/binding/source
 * authority and exclusive workspace ownership before calling it. Only a verified
 * provider observation may supply remoteBaseline; the hash itself grants nothing. */
export async function exportTaskPush(root: string, raw: TaskPushExportInput, external?: AbortSignal) {
  const input = taskPushExportInput.parse(raw), signal = bounded(external); root = await realpath(root);
  const before = await inspect(root, input, signal);
  const baseline = await repository(root, input.remoteBaseline.captureId ? ["task-push-captures", input.remoteBaseline.captureId, "git"] : ["repositories", input.intent.repositoryId, "git"], signal);
  if (await text(baseline.directory, ["rev-parse", "--is-bare-repository"], signal) !== "true") fail("baseline_invalid");
  // Known remote history is preserved verbatim, including historical commit
  // encodings. Only new commit metadata is subject to the export text policy.
  const baseBytes = (await baseline.reader.objects([input.remoteBaseline.sha], "commit", 1024 * 1024)).get(input.remoteBaseline.sha)!;
  const baseTree = /^tree ([a-f0-9]{40})\n/.exec(baseBytes.subarray(0, 46).toString("ascii")); if (!baseTree) fail("baseline_invalid");
  const known = new Set(ids(await text(baseline.directory, ["rev-list", `--max-count=${MAX_BASE_COMMITS + 1}`, input.remoteBaseline.sha, "--"], signal, undefined, 9 * 1024 * 1024), MAX_BASE_COMMITS));
  if (!known.has(input.remoteBaseline.sha)) fail("baseline_invalid");
  const baseFiles = await treeFiles(baseline.reader, baseTree![1], () => {}, signal);
  const source = await repository(root, ["workspaces", input.source.workspaceId, "checkout", ".git"], signal);
  // The observed remote may have advanced while this workspace was running.
  // Its latest commit need not exist locally: subtract the authoritative set
  // after enumeration, without injecting/fetching objects into the workspace.
  const sourceCommits = ids(await text(source.directory, ["rev-list", `--max-count=${MAX_BASE_COMMITS + MAX_COMMITS + 1}`, input.intent.newSha, "--"], signal, undefined, 9 * 1024 * 1024), MAX_BASE_COMMITS + MAX_COMMITS);
  const commits = sourceCommits.filter(id => !known.has(id));
  if (commits.length > MAX_COMMITS) fail("history_limit");
  if (!commits.length || !commits.includes(input.intent.newSha)) fail("no_new_history");
  const objects = new Map<string, ObjectValue>(); let checkedBytes = 0;
  const remember = (oid: string, value: ObjectValue) => {
    const prior = objects.get(oid);
    if (prior) { if (prior.type !== value.type || !prior.bytes.equals(value.bytes)) fail("invalid_object"); return; }
    checkedBytes += value.bytes.length;
    if (objects.size >= MAX_OBJECTS || checkedBytes > MAX_BYTES) fail("content_limit"); objects.set(oid, value);
  };
  const graph = new Map<string, ReturnType<typeof commit>>();
  for (let offset = 0; offset < commits.length; offset += 32) {
    const bytes = await source.reader.objects(commits.slice(offset, offset + 32), "commit", 8 * 1024 * 1024);
    for (const [oid, value] of bytes) {
      if (sensitive(value)) fail("secret_commit"); graph.set(oid, commit(value)); remember(oid, { type: "commit", bytes: value });
    }
  }
  const reachable = new Set<string>(), pending = [input.intent.newSha];
  while (pending.length) {
    const id = pending.pop()!; if (known.has(id) || reachable.has(id)) continue;
    const node = graph.get(id); if (!node || !node.parents.length) fail("unrelated_history");
    reachable.add(id); pending.push(...node.parents);
  }
  if (reachable.size !== commits.length) fail("invalid_history");
  const records: TaskPushExportManifest["commits"] = [];
  for (const oid of commits) {
    const node = graph.get(oid)!, files = await treeFiles(source.reader, node.tree, remember, signal);
    const changed = [...files].filter(([file, entry]) => !same(entry, baseFiles.get(file)));
    for (const [file, entry] of changed) {
      if (sensitive(Buffer.from(file))) fail("secret_path");
      if (snapshotExcludedPath(file) || !["100644", "100755"].includes(entry.mode)) fail("excluded_history");
    }
    const needed = [...new Set(changed.map(([, entry]) => entry.oid))].filter(id => !objects.has(id));
    for (let offset = 0; offset < needed.length; offset += 32) {
      const batch = needed.slice(offset, offset + 32), sizes = await source.reader.sizes(batch);
      if ([...sizes.values()].some(value => value.type !== "blob" || value.size > 2 * 1024 * 1024)) fail("large_or_invalid_file");
      for (const [id, bytes] of await source.reader.objects(batch, "blob", MAX_BYTES)) {
        if (sensitive(bytes)) fail("secret_content"); remember(id, { type: "blob", bytes });
      }
    }
    records.push({ oid, ...node, changedPaths: changed.length + [...baseFiles.keys()].filter(file => !files.has(file)).length });
  }
  const basePack = (await git(baseline.directory, ["pack-objects", "--stdout", "--revs", "--no-reuse-delta", "--no-reuse-object", "--no-use-bitmap-index", "--threads=1"], signal, `${input.remoteBaseline.sha}\n`)).bytes;
  if (basePack.length < 32 || basePack.subarray(0, 4).toString() !== "PACK" || !basePack.subarray(-20).equals(createHash("sha1").update(basePack.subarray(0, -20)).digest())) fail("baseline_invalid");
  if ((await inspect(root, input, signal)).receiptHash !== before.receiptHash) fail("source_changed");
  const parent = path.join(root, "task-push-exports"); await mkdir(parent, { recursive: true, mode: 0o700 });
  if ((await lstat(parent)).isSymbolicLink()) fail("unsafe_path");
  const directory = path.join(parent, input.exportId); await mkdir(directory, { mode: 0o700 });
  // Failed/cancelled partial exports are never silently reused or deleted.
  const target = path.join(directory, "git");
  await managedGit(directory, ["init", "--bare", "--template=", "--object-format=sha1", "git"], signal);
  const packId = basePack.subarray(-20).toString("hex");
  await git(target, ["index-pack", "--strict", "--stdin"], signal, basePack);
  for (const [oid, value] of objects) {
    if (signal.aborted) fail("cancelled");
    const dir = path.join(target, "objects", oid.slice(0, 2)); await mkdir(dir, { recursive: true, mode: 0o700 });
    await durable(path.join(dir, oid.slice(2)), deflateSync(Buffer.concat([Buffer.from(`${value.type} ${value.bytes.length}\0`), value.bytes]))); await syncDirectory(dir);
  }
  const ref = `refs/heads/export/${input.exportId}`;
  await git(target, ["update-ref", "--no-deref", ref, input.intent.newSha, "0".repeat(40)], signal);
  await git(target, ["symbolic-ref", "HEAD", ref], signal);
  await git(target, ["fsck", "--strict", "--full", "--no-reflogs"], signal);
  if (input.intent.expectedOld && (await managedGit(target, ["--git-dir=.", "-c", "core.commitGraph=false", "merge-base", "--is-ancestor", input.intent.expectedOld, input.intent.newSha], signal, { codes: [0, 1] })).code) fail("non_fast_forward");
  if ((await inspect(root, input, signal)).receiptHash !== before.receiptHash || signal.aborted) fail("source_changed");
  const manifest = manifestSchema.parse({ version: 1, policy: "task-history-v1", input, receiptHash: before.receiptHash, ref,
    basePack: { id: packId, hash: digest(basePack), size: basePack.length }, commits: records,
    objects: [...objects].map(([oid, value]) => ({ oid, type: value.type, size: value.bytes.length, hash: digest(value.bytes) })).sort((a, b) => a.oid.localeCompare(b.oid)), checkedBytes });
  // Flush pack/index and Git metadata before making the completion manifest visible.
  const sync = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await sync(file);
      else if (entry.isFile()) { const handle = await open(file, "r"); try { await handle.sync(); } finally { await handle.close(); } }
      else fail("unsafe_metadata");
    }
    await syncDirectory(dir);
  };
  await sync(target); if (signal.aborted) fail("cancelled");
  const bytes = JSON.stringify(manifest); await durable(path.join(directory, "manifest.json"), bytes); await syncDirectory(directory); await syncDirectory(parent);
  return { manifest, manifestHash: digest(bytes) };
}

/** SQL stores the expected manifest hash. No caller-controlled path or manifest
 * can substitute for that authoritative value. Reads never rebuild artifacts. */
export async function verifyTaskPushExport(root: string, exportId: string, manifestHash: string, external?: AbortSignal) {
  z.uuid().parse(exportId); hash.parse(manifestHash); const signal = bounded(external); root = await realpath(root);
  const { reader, directory } = await repository(root, ["task-push-exports", exportId, "git"], signal);
  if (await text(directory, ["rev-parse", "--is-bare-repository"], signal) !== "true" || await text(directory, ["remote"], signal) !== "") fail("artifact_changed");
  const bytes = await fixedFile(path.join(root, "task-push-exports", exportId, "manifest.json"), 8 * 1024 * 1024);
  if (digest(bytes) !== manifestHash) fail("manifest_changed");
  const manifest = manifestSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (manifest.input.exportId !== exportId || manifest.ref !== `refs/heads/export/${exportId}`) fail("manifest_changed");
  if (await text(directory, ["symbolic-ref", "HEAD"], signal) !== manifest.ref || await text(directory, ["for-each-ref", "--format=%(refname) %(objectname)"], signal) !== `${manifest.ref} ${manifest.input.intent.newSha}`) fail("artifact_changed");
  const pack = await fixedFile(path.join(directory, "objects/pack", `pack-${manifest.basePack.id}.pack`), MAX_BYTES);
  if (pack.length !== manifest.basePack.size || digest(pack) !== manifest.basePack.hash) fail("artifact_changed");
  for (const type of ["commit", "tree", "blob"] as const) {
    const entries = manifest.objects.filter(entry => entry.type === type);
    for (let offset = 0; offset < entries.length; offset += 32) {
      const batch = entries.slice(offset, offset + 32), values = await reader.objects(batch.map(entry => entry.oid), type, MAX_BYTES);
      for (const entry of batch) if (values.get(entry.oid)!.length !== entry.size || digest(values.get(entry.oid)!) !== entry.hash) fail("artifact_changed");
    }
  }
  await git(directory, ["fsck", "--strict", "--full", "--no-reflogs"], signal);
  return { manifest, directory };
}
export async function prepareExportedTaskPush(root: string, exportId: string, manifestHash: string, external?: AbortSignal) {
  const signal = bounded(external), { manifest, directory } = await verifyTaskPushExport(root, exportId, manifestHash, signal);
  return PreparedTaskPush.prepare(directory, manifest.input.intent, signal);
}

// Server-only review uses the same strict raw-tree and UTF-16 secret policy as
// export. These primitives grant no access; callers must authorize the export.
export { treeFiles as taskPushTreeFiles, sensitive as taskPushBytesSensitive };
