import { spawn } from "node:child_process";
import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { codeDisplayText, type CodeLine } from "../integration-code-schema";
import { inspectContainerExit } from "./container-receipts";
import { inspectNativeExit } from "./receipts";
import { ReviewGit, reviewDiff, reviewHash } from "./review-git";
import { scanWorkspaceLayers, safeSnapshotPath, snapshotHasSecret } from "./snapshots";
import { runnerEnvironment } from "./workspace";
import { sourceSchema, commitIdentitySchema, workspaceStageSelection, type WorkspaceGitSource, type WorkspaceCommitIdentity, type WorkspaceStageSelection } from "../git/workspace-schema";
export { sourceSchema, commitIdentitySchema, workspaceStageSelection, type WorkspaceGitSource, type WorkspaceCommitIdentity, type WorkspaceStageSelection } from "../git/workspace-schema";

const sha = z.string().regex(/^[a-f0-9]{40}$/), hash = z.string().regex(/^[a-f0-9]{64}$/);
export type GitLayer = "staged" | "working";
export type GitEntry = { path: string; mode: string; oid: string };
type Scan = Awaited<ReturnType<typeof scanWorkspaceLayers>>;
type Entry = Scan["head"][number];
type Hunk = { id: string; beforeStart: number; beforeCount: number; afterStart: number; afterCount: number; lines: CodeLine[] };
const selectionsSchema = z.array(workspaceStageSelection).min(1).max(200);
function fail(reason: string): never { throw new Error(`workspace_git_${reason}`); }
export function workspaceGitObjectId(type: "blob" | "tree" | "commit", bytes: Buffer) {
  return createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");
}
const equal = (a?: { mode: string; oid: string }, b?: { mode: string; oid: string }) => a?.mode === b?.mode && a?.oid === b?.oid;
const sorted = (entries: GitEntry[]) => [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
const related = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/** Construct Git trees from exact entries without writing objects or invoking
 * project filters. Byte ordering includes the slash used to sort directories. */
function trees(entries: GitEntry[]) {
  if (entries.length > 5000) fail("limit");
  type Tree = Map<string, GitEntry | Tree>;
  const root: Tree = new Map(), canonical = new Map<string, string>();
  for (const entry of entries) {
    if (!safeSnapshotPath(entry.path) || !sha.safeParse(entry.oid).success || !["100644", "100755", "120000", "160000"].includes(entry.mode)) fail("invalid_tree");
    let node = root;
    const parts = entry.path.split("/");
    for (let i = 0; i < parts.length; i++) {
      const prefix = parts.slice(0, i + 1).join("/"), folded = prefix.normalize("NFC").toLowerCase();
      if (canonical.has(folded) && canonical.get(folded) !== prefix) fail("path_collision");
      canonical.set(folded, prefix);
      const part = parts[i], existing = node.get(part);
      if (i === parts.length - 1) { if (existing) fail("path_collision"); node.set(part, entry); }
      else {
        if (existing && !(existing instanceof Map)) fail("path_collision");
        if (!existing) node.set(part, new Map()); node = node.get(part) as Tree;
      }
    }
  }
  const objects = new Map<string, Buffer>();
  const build = (node: Tree): string => {
    const rows = [...node].map(([name, value]) => value instanceof Map
      ? { name, mode: "40000", oid: build(value), sort: Buffer.from(`${name}/`) }
      : { name, mode: value.mode, oid: value.oid, sort: Buffer.from(name) });
    rows.sort((a, b) => Buffer.compare(a.sort, b.sort));
    const bytes = Buffer.concat(rows.map(row => Buffer.concat([Buffer.from(`${row.mode} ${row.name}\0`), Buffer.from(row.oid, "hex")])));
    const id = workspaceGitObjectId("tree", bytes); objects.set(id, bytes); return id;
  };
  return { oid: build(root), objects };
}

async function readRegular(file: string, limit: number) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat(); if (!before.isFile() || before.size > limit) fail("unsafe_metadata");
    const bytes = await handle.readFile(), after = await handle.stat();
    if (bytes.length > limit || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail("source_changed");
    return bytes;
  } finally { await handle.close(); }
}
async function absent(file: string) {
  try { await lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  fail("busy");
}
export type WorkspaceGitLock = { name: string; dev: string; ino: string };
async function guardMetadata(checkout: string, workspaceId: string, held: WorkspaceGitLock[]) {
  const allowed = new Set(["index.lock", "HEAD.lock", `refs/heads/task/${workspaceId}.lock`]);
  if (held.some(lock => !allowed.has(lock.name)) || new Set(held.map(lock => lock.name)).size !== held.length) fail("unsafe_metadata");
  for (const name of ["index.lock", "HEAD.lock", "packed-refs.lock", `refs/heads/task/${workspaceId}.lock`, "commondir", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "rebase-apply", "rebase-merge", "sequencer", "BISECT_LOG"]) {
    const lock = held.find(item => item.name === name), file = path.join(checkout, ".git", name);
    if (!lock) await absent(file);
    else { const stat = await lstat(file, { bigint: true }); if (!stat.isFile() || stat.nlink !== BigInt(1) || String(stat.dev) !== lock.dev || String(stat.ino) !== lock.ino) fail("source_changed"); }
  }
  const head = await readRegular(path.join(checkout, ".git", "HEAD"), 256);
  if (head.toString("utf8") !== `ref: refs/heads/task/${workspaceId}\n`) fail("unexpected_branch");
  // A task ref may itself be symbolic. Updating it later must never follow an
  // alias into another branch. A missing loose ref may legitimately be packed.
  try {
    const branch = await readRegular(path.join(checkout, ".git", "refs", "heads", "task", workspaceId), 256);
    if (!/^[a-f0-9]{40}\n$/.test(branch.toString("ascii"))) fail("unexpected_branch");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const index = await readRegular(path.join(checkout, ".git", "index"), 8 * 1024 * 1024);
  return { indexHash: reviewHash(index), branch: `refs/heads/task/${workspaceId}` };
}
async function git(checkout: string, args: string[], signal: AbortSignal) {
  return new Promise<Buffer>((resolve, reject) => {
    if (signal.aborted) { reject(new Error("workspace_git_cancelled")); return; }
    const child = spawn("git", ["--git-dir=.git", "--work-tree=.", "--no-pager", "--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.allow=never", ...args], {
      cwd: checkout, env: { ...runnerEnvironment("/nonexistent", "/nonexistent"), GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_CEILING_DIRECTORIES: checkout }, stdio: ["ignore", "pipe", "ignore"],
    });
    let size = 0, failed = false; const chunks: Buffer[] = [];
    const stop = () => { failed = true; child.kill("SIGKILL"); };
    signal.addEventListener("abort", stop, { once: true }); const timer = setTimeout(stop, 10000);
    child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 8 * 1024 * 1024) stop(); else chunks.push(chunk); });
    child.once("error", () => { failed = true; });
    child.once("close", code => { clearTimeout(timer); signal.removeEventListener("abort", stop); if (failed || code !== 0) reject(new Error("workspace_git_unavailable")); else resolve(Buffer.concat(chunks)); });
  });
}
function rows(bytes: Buffer, index: boolean) {
  if (!isUtf8(bytes)) fail("invalid_tree");
  const result = bytes.toString("utf8").split("\0").filter(Boolean).map(row => {
    const match = /^(100644|100755|120000|160000) ([a-z0-9]+) ([a-z0-9]+)\t(.+)$/.exec(row);
    if (!match || (index ? match[3] !== "0" : match[2] !== (match[1] === "160000" ? "commit" : "blob"))) fail("invalid_tree");
    return { path: match[4], mode: match[1], oid: sha.parse(index ? match[2] : match[3]) };
  });
  if (result.length > 5000) fail("limit"); return sorted(result);
}
const ref = (entry: Entry, blobs: Map<string, Buffer>): GitEntry => ({ path: entry.path, mode: entry.mode, oid: workspaceGitObjectId("blob", blobs.get(entry.hash)!) });
function textEligible(bytes: Buffer) { return bytes.length <= 256 * 1024 && isUtf8(bytes) && !bytes.includes(0) && bytes.toString("utf8").split("\n").length <= 8000; }
function lineBytes(bytes: Buffer) {
  const lines: Buffer[] = []; let start = 0;
  for (let end = bytes.indexOf(10); end >= 0; end = bytes.indexOf(10, start)) { lines.push(bytes.subarray(start, end + 1)); start = end + 1; }
  if (start < bytes.length) lines.push(bytes.subarray(start)); return lines;
}

type State = {
  root: string; source: WorkspaceGitSource; scan: Scan; head: GitEntry[]; index: GitEntry[];
  headTree: string; indexTree: string; indexHash: string; branch: string; receiptHash: string; revision: string;
};

/** Internal evidence only. Construct via inspectWorkspaceGit; no endpoint may
 * accept this object or treat its existence as mutation authorization. */
export class WorkspaceGitView {
  #state: State;
  constructor(state: State) { this.#state = state; }
  get revision() { return this.#state.revision; }
  private excluded(file: string) { return this.#state.scan.excluded.some(item => related(file, item.path)); }
  private entry(layer: "head" | "index" | "worktree", file: string) { return this.#state.scan[layer].find(entry => entry.path === file); }
  private bytes(entry: Entry | undefined): Buffer { return entry ? this.#state.scan.blobs.get(entry.hash)! : Buffer.alloc(0); }
  summary() {
    const s = this.#state, head = new Map(s.head.map(e => [e.path, e])), index = new Map(s.index.map(e => [e.path, e]));
    const work = new Map(s.scan.worktree.map(e => [e.path, ref(e, s.scan.blobs)]));
    const files = [...new Set([...head.keys(), ...index.keys(), ...work.keys()])].sort().flatMap(file => {
      const staged = !equal(head.get(file), index.get(file)), working = !equal(index.get(file), work.get(file));
      if (this.excluded(file)) return staged ? [{ path: file, staged, working: false, excluded: true }] : [];
      return staged || working ? [{ path: file, staged, working, excluded: false }] : [];
    });
    return structuredClone({ version: 1, ...s.source, revision: s.revision, branch: s.branch, head: s.scan.sourceHead, headTree: s.headTree, indexTree: s.indexTree, indexHash: s.indexHash, receiptHash: s.receiptHash,
      files, exclusions: s.scan.excluded, commitBlockedPaths: files.filter(f => f.excluded).map(f => f.path), stagingPolicy: "raw-bytes-no-filters" });
  }
  private async rawFile(layer: GitLayer, file: string, signal: AbortSignal) {
    if (!["staged", "working"].includes(layer) || !safeSnapshotPath(file)) fail("invalid_selection");
    if (this.excluded(file)) fail("excluded_path");
    const before = this.entry(layer === "staged" ? "head" : "index", file), after = this.entry(layer === "staged" ? "index" : "worktree", file);
    if (!before && !after) fail("invalid_selection");
    const a = this.bytes(before), b = this.bytes(after), fileHash = reviewHash(JSON.stringify({ revision: this.revision, layer, file, before, after }));
    const text = textEligible(a) && textEligible(b), lines = text ? await reviewDiff(a, b, signal) : [];
    const hunks: Hunk[] = [];
    for (const line of lines) {
      if (line.kind === "hunk") {
        const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line.text); if (!match) fail("invalid_diff");
        const beforeCount = Number(match[2] ?? 1), afterCount = Number(match[4] ?? 1);
        hunks.push({ id: "", beforeStart: Number(match[1]) - (beforeCount ? 1 : 0), beforeCount, afterStart: Number(match[3]) - (afterCount ? 1 : 0), afterCount, lines: [line] });
      } else { if (!hunks.length) fail("invalid_diff"); hunks.at(-1)!.lines.push(line); }
    }
    for (const hunk of hunks) hunk.id = reviewHash(JSON.stringify({ fileHash, ...hunk }));
    return { fileHash, before, after, a, b, text, hunks, partial: !!before && !!after && text && hunks.length > 0 };
  }
  async file(layer: GitLayer, file: string, signal = AbortSignal.timeout(30000)) {
    const data = await this.rawFile(layer, file, signal);
    const content = (entry: Entry | undefined, bytes: Buffer) => entry ? { ...entry, oid: workspaceGitObjectId("blob", bytes),
      text: textEligible(bytes) ? codeDisplayText(bytes.toString("utf8")) : null,
      lineEndings: { lf: bytes.filter(v => v === 10).length, crlf: (bytes.toString("utf8").match(/\r\n/g) ?? []).length }, trailingNewline: bytes.at(-1) === 10 } : null;
    return { revision: this.revision, layer, path: file, fileHash: data.fileHash, partial: data.partial, omitted: data.text ? null : "binary_encoding_or_size",
      before: content(data.before, data.a), after: content(data.after, data.b),
      hunks: data.hunks.map(hunk => ({ ...hunk, lines: hunk.lines.map(line => ({ ...line, text: codeDisplayText(line.text) })) })) };
  }
  /** Produces exact index entries and new objects. It does not write the index,
   * refs or working files; execution requires a separate durable owner. */
  async planStaging(expectedRevision: string, raw: WorkspaceStageSelection[], signal = AbortSignal.timeout(30000)) {
    if (expectedRevision !== this.revision) fail("stale_revision");
    const selections = selectionsSchema.parse(raw), seen = new Set<string>(), s = this.#state;
    const next = new Map(s.index.map(entry => [entry.path, entry])), blobs = new Map<string, Buffer>();
    for (const selection of selections) {
      if (seen.has(selection.path)) fail("duplicate_selection"); seen.add(selection.path);
      const current = next.get(selection.path);
      let replacement: GitEntry | undefined;
      if (this.excluded(selection.path)) {
        // Restoring the original reference needs no secret bytes. It is the only
        // permitted operation on an excluded staged path.
        if (selection.direction !== "unstage" || selection.hunks !== "file") fail("excluded_path");
        replacement = s.head.find(entry => entry.path === selection.path);
      } else {
        const data = await this.rawFile(selection.direction === "stage" ? "working" : "staged", selection.path, signal);
        const target = selection.direction === "stage" ? data.after : data.before;
        let bytes = selection.direction === "stage" ? data.b : data.a;
        if (selection.hunks !== "file") {
          if (!data.partial || new Set(selection.hunks).size !== selection.hunks.length) fail("invalid_selection");
          const selected = new Set(selection.hunks), hunks = data.hunks.filter(hunk => selected.has(hunk.id));
          if (hunks.length !== selected.size) fail("stale_hunk");
          const forward = selection.direction === "stage", from = lineBytes(forward ? data.a : data.b), to = lineBytes(forward ? data.b : data.a);
          const result: Buffer[] = []; let cursor = 0;
          for (const hunk of hunks) {
            const start = forward ? hunk.beforeStart : hunk.afterStart, count = forward ? hunk.beforeCount : hunk.afterCount;
            const targetStart = forward ? hunk.afterStart : hunk.beforeStart, targetCount = forward ? hunk.afterCount : hunk.beforeCount;
            if (start < cursor || start + count > from.length || targetStart < 0 || targetStart + targetCount > to.length) fail("invalid_diff");
            result.push(...from.slice(cursor, start), ...to.slice(targetStart, targetStart + targetCount)); cursor = start + count;
          }
          result.push(...from.slice(cursor)); bytes = Buffer.concat(result);
        }
        if (target) {
          if (bytes.length > 2 * 1024 * 1024 || snapshotHasSecret(bytes)) fail("unsafe_content");
          const oid = workspaceGitObjectId("blob", bytes); blobs.set(oid, Buffer.from(bytes));
          replacement = { path: selection.path, mode: selection.hunks === "file" ? target.mode : current!.mode, oid };
        }
      }
      if (equal(current, replacement)) fail("unchanged_selection");
      if (replacement) next.set(selection.path, replacement); else next.delete(selection.path);
    }
    const entries = sorted([...next.values()]), tree = trees(entries), changes = selections.map(selection => ({ ...selection,
      before: s.index.find(e => e.path === selection.path) ?? null, after: next.get(selection.path) ?? null })).sort((a, b) => a.path.localeCompare(b.path, "en"));
    const manifest = { version: 1, source: s.source, revision: s.revision, head: s.scan.sourceHead, branch: s.branch, indexHash: s.indexHash, beforeTree: s.indexTree, afterTree: tree.oid, entries, changes };
    return { manifest: structuredClone(manifest), planHash: reviewHash(JSON.stringify(manifest)), blobs, trees: tree.objects };
  }
  /** actorId/displayName must come from the authenticated member in the future
   * admission transaction. This internal helper grants no permission. */
  planCommit(expectedRevision: string, raw: WorkspaceCommitIdentity) {
    if (expectedRevision !== this.revision) fail("stale_revision");
    const s = this.#state, identity = commitIdentitySchema.parse(raw);
    if (this.summary().commitBlockedPaths.length) fail("excluded_staged_changes");
    if (s.indexTree === s.headTree) fail("empty_commit");
    const seconds = Math.floor(Date.parse(identity.requestedAt) / 1000); if (!Number.isSafeInteger(seconds) || seconds < 0) fail("invalid_identity");
    const actorHash = reviewHash(identity.actorId), member = `${identity.displayName} <member-${actorHash.slice(0, 32)}@pi-collab.invalid>`;
    const bytes = Buffer.from(`tree ${s.indexTree}\nparent ${s.scan.sourceHead}\nauthor ${member} ${seconds} +0000\ncommitter pi-collab <platform@pi-collab.invalid> ${seconds} +0000\npi-collab-operation ${identity.operationId}\npi-collab-member ${actorHash}\npi-collab-workspace ${s.source.workspaceId}\npi-collab-run ${s.source.identity.runId}\npi-collab-revision ${s.revision}\n\n${identity.message}\n`);
    const manifest = { version: 1, source: s.source, revision: s.revision, branch: s.branch, parent: s.scan.sourceHead, indexHash: s.indexHash, tree: s.indexTree,
      commit: workspaceGitObjectId("commit", bytes), ...identity, provenance: "member-confirmed-ai-workspace", signed: false };
    return { manifest: structuredClone(manifest), planHash: reviewHash(JSON.stringify(manifest)), bytes, trees: trees(s.index).objects };
  }
}

/** Only broker-owned paths; no active writer, user pathname, filter execution
 * or automatic lock cleanup. Double inspection detects persistent changes; it
 * is not a substitute for exclusive mutation ownership or a native sandbox. */
export async function inspectWorkspaceGit(dataRoot: string, raw: WorkspaceGitSource, signal = AbortSignal.timeout(120000), heldLocks: WorkspaceGitLock[] = []) {
  const source = sourceSchema.parse(raw), root = await realpath(dataRoot);
  let checkout = root;
  for (const segment of ["workspaces", source.workspaceId, "checkout"]) {
    checkout = path.join(checkout, segment); const stat = await lstat(checkout);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("unsafe_path");
  }
  const exit = await (source.runtime === "docker" ? inspectContainerExit : inspectNativeExit)(root, source.workspaceId, source.identity); if (!exit.safe || !exit.receiptHash) fail("writer_not_exited");
  const reader = await ReviewGit.open(root, ["workspaces", source.workspaceId, "checkout", ".git"], signal);
  const read = async () => {
    if (signal.aborted) fail("cancelled");
    const metadata = await guardMetadata(checkout, source.workspaceId, heldLocks), scan = await scanWorkspaceLayers(checkout);
    const head = rows(await git(checkout, ["ls-tree", "-rz", "--full-tree", scan.sourceHead], signal), false);
    const index = rows(await git(checkout, ["ls-files", "--stage", "-z"], signal), true);
    const headTree = trees(head).oid, indexTree = trees(index).oid;
    const commit = (await reader.objects([scan.sourceHead], "commit", 1024 * 1024)).get(scan.sourceHead)!;
    if (!commit.subarray(0, 46).equals(Buffer.from(`tree ${headTree}\n`))) fail("invalid_objects");
    // Verify eligible object bytes even when Git accepts a corrupt loose object
    // stored under the expected pathname. Raw HEAD tree reconstruction includes
    // excluded references but never reads their contents.
    for (const [entries, rawEntries] of [[scan.head, head], [scan.index, index]] as const) {
      const expected = new Map(rawEntries.map(e => [e.path, e]));
      for (const entry of entries) if (!equal(ref(entry, scan.blobs), expected.get(entry.path))) fail("invalid_objects");
    }
    if (JSON.stringify(metadata) !== JSON.stringify(await guardMetadata(checkout, source.workspaceId, heldLocks))) fail("source_changed");
    const evidence = { version: 1, source, receiptHash: exit.receiptHash, ...metadata, headTree, indexTree, head, index,
      sourceHead: scan.sourceHead, layers: { head: scan.head, index: scan.index, worktree: scan.worktree, excluded: scan.excluded } };
    return { metadata, scan, head, index, headTree, indexTree, revision: reviewHash(JSON.stringify(evidence)) };
  };
  const first = await read(), second = await read(), afterExit = await (source.runtime === "docker" ? inspectContainerExit : inspectNativeExit)(root, source.workspaceId, source.identity);
  if (first.revision !== second.revision || !afterExit.safe || afterExit.receiptHash !== exit.receiptHash || signal.aborted) fail("source_changed");
  return new WorkspaceGitView({ root, source, scan: second.scan, head: second.head, index: second.index, headTree: second.headTree, indexTree: second.indexTree,
    ...second.metadata, receiptHash: exit.receiptHash, revision: second.revision });
}

/** Fresh evidence is always required when consuming a client selection. */
export async function planWorkspaceStaging(root: string, source: WorkspaceGitSource, revision: string, selections: WorkspaceStageSelection[], signal?: AbortSignal) {
  return (await inspectWorkspaceGit(root, source, signal)).planStaging(hash.parse(revision), selections, signal);
}
export async function planWorkspaceCommit(root: string, source: WorkspaceGitSource, revision: string, identity: WorkspaceCommitIdentity, signal?: AbortSignal) {
  return (await inspectWorkspaceGit(root, source, signal)).planCommit(hash.parse(revision), identity);
}
