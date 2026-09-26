import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { lstat, readdir, realpath, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runnerEnvironment } from "./workspace";
import { safeSnapshotPath, snapshotExcludedPath } from "./snapshots";
import type { CodeLine, CodeSide } from "../integration-code-schema";

const sha = /^[a-f0-9]{40}$/;
export const reviewHash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const oid = (type: string, bytes: Buffer) => createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");
const invalid = () => new Error("integration_code_unavailable");

async function command(directory: string, args: string[], input: string | undefined, limit: number, signal: AbortSignal, codes = [0]) {
  return new Promise<Buffer>((resolve, reject) => {
    if (signal.aborted) { reject(invalid()); return; }
    const child = spawn("git", ["--no-pager", "--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.allow=never", "-c", "core.attributesFile=/dev/null", ...args], {
      cwd: directory, env: { ...runnerEnvironment("/nonexistent", "/nonexistent"), GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_CEILING_DIRECTORIES: directory }, stdio: "pipe",
    });
    const chunks: Buffer[] = []; let bytes = 0, failed = false;
    const stop = () => { failed = true; child.kill("SIGKILL"); };
    signal.addEventListener("abort", stop, { once: true }); const timer = setTimeout(stop, 10000);
    child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > limit) stop(); else chunks.push(chunk); });
    child.stderr.resume(); child.stdin.on("error", () => {}); child.stdin.end(input);
    child.once("error", () => { failed = true; });
    child.once("close", code => { clearTimeout(timer); signal.removeEventListener("abort", stop); if (failed || code === null || !codes.includes(code)) reject(invalid()); else resolve(Buffer.concat(chunks)); });
  });
}

/** Only fixed broker-owned paths enter this reader. Git objects are independently
 * hashed; neither a mutable HEAD nor Git's willingness to inflate an object is proof. */
export class ReviewGit {
  private constructor(private readonly directory: string, private readonly signal: AbortSignal) {}
  static async open(root: string, segments: string[], signal: AbortSignal) {
    let directory = await realpath(root);
    const ancestors = [directory];
    for (const segment of segments) {
      if (!segment || segment.includes("/") || [".", ".."].includes(segment)) throw invalid();
      directory = path.join(directory, segment);
      ancestors.push(directory);
    }
    const identities = new Map<string, { dev: number; ino: number }>();
    const validateAncestors = async () => {
      for (const ancestor of ancestors) {
        if (signal.aborted) throw invalid();
        const stat = await lstat(ancestor), expected = identities.get(ancestor);
        if (!stat.isDirectory() || stat.isSymbolicLink() || expected && (stat.dev !== expected.dev || stat.ino !== expected.ino)) throw invalid();
        identities.set(ancestor, { dev: stat.dev, ino: stat.ino });
      }
    };
    const rescan = Symbol("git_pack_metadata_changed");
    for (let attempt = 0; attempt < 3; attempt++) {
      await validateAncestors();
      let count = 0;
      const guard = async (dir: string) => {
        if (signal.aborted) throw invalid();
        for (const name of await readdir(dir)) {
          if (++count > 50000 || signal.aborted) throw invalid();
          const file = path.join(dir, name);
          if (file.endsWith("/objects/info/alternates") || file.endsWith("/objects/info/http-alternates")) throw invalid();
          const stat = await lstat(file).catch(error => {
            // index-pack atomically publishes/removes these temporary files.
            // Retry the entire validation, never skip an unexamined entry or
            // retry a Git effect. Other missing files remain failures.
            if (error?.code === "ENOENT" && dir === path.join(directory, "objects", "pack") && /^tmp_(?:pack|idx|rev)_[A-Za-z0-9]+$/.test(name)) throw rescan;
            throw error;
          });
          if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw invalid();
          if (stat.isDirectory()) await guard(file);
        }
      };
      try {
        await guard(directory); await validateAncestors();
        return new ReviewGit(directory, signal);
      } catch (error) {
        if (error !== rescan) throw error;
        if (attempt === 2 || signal.aborted) throw invalid();
      }
    }
    throw invalid();
  }
  async sizes(ids: string[]) {
    if (!ids.length) return new Map<string, { type: string; size: number }>();
    if (ids.length > 5000 || ids.some(id => !sha.test(id))) throw invalid();
    const raw = await command(this.directory, ["--git-dir=.", "cat-file", "--batch-check"], ids.join("\n") + "\n", 1024 * 1024, this.signal);
    const rows = raw.toString("ascii").trimEnd().split("\n"); if (rows.length !== ids.length) throw invalid();
    return new Map(rows.map((row, index) => {
      const match = /^([a-f0-9]{40}) (blob|tree|commit) ([0-9]+)$/.exec(row);
      if (!match || match[1] !== ids[index] || !Number.isSafeInteger(Number(match[3]))) throw invalid();
      return [match[1], { type: match[2], size: Number(match[3]) }];
    }));
  }
  async objects(ids: string[], type: "blob" | "tree" | "commit", limit = 8 * 1024 * 1024) {
    if (!ids.length) return new Map<string, Buffer>();
    const sizes = await this.sizes(ids);
    if ([...sizes.values()].some(value => value.type !== type) || [...sizes.values()].reduce((sum, value) => sum + value.size, 0) > limit) throw invalid();
    const raw = await command(this.directory, ["--git-dir=.", "cat-file", "--batch"], ids.join("\n") + "\n", limit + ids.length * 100, this.signal);
    const result = new Map<string, Buffer>(); let cursor = 0;
    for (const id of ids) {
      const end = raw.indexOf(10, cursor); if (end < 0) throw invalid();
      const expected = sizes.get(id)!; if (raw.subarray(cursor, end).toString("ascii") !== `${id} ${type} ${expected.size}`) throw invalid();
      const bytes = raw.subarray(end + 1, end + 1 + expected.size); cursor = end + 2 + expected.size;
      if (raw[cursor - 1] !== 10 || oid(type, bytes) !== id) throw invalid();
      result.set(id, bytes);
    }
    if (cursor !== raw.length) throw invalid(); return result;
  }
  async tree(commit: string) {
    const bytes = (await this.objects([commit], "commit", 1024 * 1024)).get(commit)!;
    const match = /^tree ([a-f0-9]{40})\n/.exec(bytes.toString("utf8")); if (!match) throw invalid();
    const files = new Map<string, NonNullable<CodeSide>>(), excluded = new Map<string, string>();
    let pending = [{ id: match[1], prefix: "" }], count = 0;
    while (pending.length) {
      const objects = await this.objects([...new Set(pending.map(item => item.id))], "tree"), next: typeof pending = [];
      for (const item of pending) {
        const tree = objects.get(item.id)!; let cursor = 0;
        while (cursor < tree.length) {
          const space = tree.indexOf(32, cursor), end = tree.indexOf(0, space + 1);
          if (space < cursor || end < space || end + 21 > tree.length) throw invalid();
          const mode = tree.subarray(cursor, space).toString("ascii"), name = tree.subarray(space + 1, end);
          if (!isUtf8(name) || name.includes(47)) throw invalid();
          const file = item.prefix + name.toString("utf8"), id = tree.subarray(end + 1, end + 21).toString("hex"); cursor = end + 21;
          if (++count > 5000 || !safeSnapshotPath(file)) throw invalid();
          const reason = snapshotExcludedPath(file) ?? (mode === "120000" ? "symlink" : mode === "160000" ? "submodule" : null);
          if (reason) { excluded.set(file, reason); continue; }
          if (mode === "40000") next.push({ id, prefix: `${file}/` });
          else if (["100644", "100755"].includes(mode) && !files.has(file)) files.set(file, { oid: id, mode });
          else throw invalid();
        }
      }
      pending = next;
    }
    return { files, excluded };
  }
}

/** Controlled temporary names and an empty local repository keep project Git
 * attributes, textconv, external diff drivers and executable content out. */
export async function reviewDiff(before: Buffer, after: Buffer, signal: AbortSignal): Promise<CodeLine[]> {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-collab-review-"));
  try {
    await command(directory, ["init", "--bare", "--template=", "--object-format=sha1", "git"], undefined, 4096, signal);
    await mkdir(path.join(directory, "files"));
    await writeFile(path.join(directory, "files/before"), before, { mode: 0o600 }); await writeFile(path.join(directory, "files/after"), after, { mode: 0o600 });
    const raw = await command(directory, ["--git-dir=git", "diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3", "--", "files/before", "files/after"], undefined, 1024 * 1024, signal, [0, 1]);
    let old = 0, current = 0, started = false; const lines: CodeLine[] = [];
    for (const line of raw.toString("utf8").split("\n")) {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) { old = Number(hunk[1]); current = Number(hunk[2]); started = true; lines.push({ kind: "hunk", text: line, before: null, after: null }); }
      else if (started && line.startsWith("+")) lines.push({ kind: "added", text: line.slice(1), before: null, after: current++ });
      else if (started && line.startsWith("-")) lines.push({ kind: "removed", text: line.slice(1), before: old++, after: null });
      else if (started && line.startsWith(" ")) lines.push({ kind: "context", text: line.slice(1), before: old++, after: current++ });
      else if (started && line.startsWith("\\")) lines.push({ kind: "note", text: line, before: null, after: null });
    }
    return lines;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
