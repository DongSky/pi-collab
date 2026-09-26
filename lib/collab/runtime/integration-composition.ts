import { spawn } from "node:child_process";
import { isUtf8 } from "node:buffer";
import { rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { runnerEnvironment } from "./workspace";
import { safeSnapshotPath, snapshotBaselineChanges, verifiedSnapshot } from "./snapshots";
import { contractPins, type ContractPin } from "../contract-schema";
import { integrationSourcesSchema, type IntegrationEvidence, type IntegrationSource, type MergeConflict } from "../integration-schema";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
export interface ConflictSide { oid: string; mode: "100644" | "100755"; }
export interface CompositionConflict {
  resultId: string; sourceCommit: string; previousCommit: string; tree: string;
  files: { path: string; base: ConflictSide | null; ours: ConflictSide | null; theirs: ConflictSide | null }[];
  notices: { kind: string; paths: string[] }[];
}

// All writes target a newly provisioned private clone. Never use this helper
// with an agent-controlled checkout or an imported repository as its cwd.
export function compositionGit(cwd: string, args: string[], signal: AbortSignal, input?: Buffer | string, extra: Record<string, string> = {}) {
  return new Promise<{ code: number; stdout: Buffer }>((resolve, reject) => {
    if (signal.aborted) { reject(new Error("integration_cancelled")); return; }
    const child = spawn("git", ["--no-pager", "--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.attributesFile=/dev/null", "-c", "protocol.allow=never", ...args], {
      cwd, env: { ...runnerEnvironment("/nonexistent", "/nonexistent"), GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1",
        GIT_AUTHOR_NAME: "pi-collab integration", GIT_COMMITTER_NAME: "pi-collab integration", GIT_AUTHOR_EMAIL: "integration@pi-collab.local", GIT_COMMITTER_EMAIL: "integration@pi-collab.local",
        GIT_AUTHOR_DATE: "1600000000 +0000", GIT_COMMITTER_DATE: "1600000000 +0000", ...extra }, stdio: "pipe",
    });
    const chunks: Buffer[] = []; let bytes = 0, failed = false;
    const stop = () => { failed = true; child.kill("SIGKILL"); };
    signal.addEventListener("abort", stop, { once: true }); const timer = setTimeout(stop, 30_000);
    child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) stop(); else chunks.push(chunk); });
    child.stderr.resume(); child.stdin.on("error", () => {}); child.stdin.end(input);
    child.once("error", () => { failed = true; });
    child.once("close", code => {
      clearTimeout(timer); signal.removeEventListener("abort", stop);
      if (failed || code === null) reject(new Error(signal.aborted ? "integration_cancelled" : "integration_git_failed"));
      else resolve({ code, stdout: Buffer.concat(chunks) });
    });
  });
}
export async function checkedCompositionGit(cwd: string, args: string[], signal: AbortSignal, input?: Buffer | string, extra?: Record<string, string>) {
  const result = await compositionGit(cwd, args, signal, input, extra);
  if (result.code) throw new Error("integration_git_failed");
  return result.stdout;
}

/** Parse Git's NUL-delimited stages and informational tuples. Keep structured
 * kinds/paths, never diagnostic prose that may contain arbitrary file bytes. */
function conflictDetails(raw: Buffer): Pick<CompositionConflict, "tree" | "files" | "notices"> {
  if (!isUtf8(raw)) throw new Error("integration_conflict_unsupported");
  const records = raw.toString("utf8").split("\0"), tree = sha.parse(records.shift());
  const files = new Map<string, CompositionConflict["files"][number]>();
  let cursor = 0;
  for (; cursor < records.length && records[cursor]; cursor++) {
    const match = /^(100644|100755) ([a-f0-9]{40}) ([123])\t(.+)$/.exec(records[cursor]);
    if (!match || !safeSnapshotPath(match[4])) throw new Error("integration_conflict_unsupported");
    const file = match[4], side = match[3] === "1" ? "base" : match[3] === "2" ? "ours" : "theirs";
    const entry = files.get(file) ?? { path: file, base: null, ours: null, theirs: null };
    if (entry[side]) throw new Error("integration_conflict_unsupported");
    entry[side] = { oid: match[2], mode: match[1] as ConflictSide["mode"] }; files.set(file, entry);
    if (files.size > 256) throw new Error("integration_conflict_limit");
  }
  if (!files.size || records[cursor++] !== "") throw new Error("integration_conflict_unsupported");
  const notices: CompositionConflict["notices"] = []; let tuples = 0;
  while (cursor < records.length - 1) {
    const count = Number(records[cursor++]);
    if (!Number.isInteger(count) || count < 1 || count > 256 || ++tuples > 1024) throw new Error("integration_conflict_limit");
    const paths = records.slice(cursor, cursor + count); cursor += count;
    const kind = records[cursor++], message = records[cursor++];
    if (paths.length !== count || paths.some(file => !safeSnapshotPath(file)) || !kind || kind.length > 120 || /[\x00-\x1f\x7f]/.test(kind) || message === undefined)
      throw new Error("integration_conflict_unsupported");
    if (kind.startsWith("CONFLICT")) notices.push({ kind, paths });
  }
  if (cursor !== records.length - 1 || records[cursor] !== "") throw new Error("integration_conflict_unsupported");
  return { tree, files: [...files.values()], notices };
}
export function legacyConflict(conflict: CompositionConflict): NonNullable<IntegrationEvidence["conflict"]> {
  return { resultId: conflict.resultId, files: conflict.files.map(file => ({ path: file.path, base: file.base?.oid ?? null, ours: file.ours?.oid ?? null, theirs: file.theirs?.oid ?? null })) };
}
const orderedFiles = (files: MergeConflict[]) => [...files].sort((a, b) => a.path.localeCompare(b.path));

export interface CompositionInput { repositoryId: string; targetSha: string; sources: IntegrationSource[]; }
interface CompositionOptions {
  // Resolution preparation must reproduce the original failure, including the
  // already completed prefix, before it is allowed to continue past it.
  expectedFailure?: { merges: IntegrationEvidence["merges"]; conflict: NonNullable<IntegrationEvidence["conflict"]> };
}
export async function composeIntegrationSources(root: string, checkout: string, input: CompositionInput, signal: AbortSignal, options: CompositionOptions = {}) {
  z.uuid().parse(input.repositoryId); sha.parse(input.targetSha);
  const sources = integrationSourcesSchema.parse(input.sources), contracts = new Map<string, ContractPin>();
  const merges: IntegrationEvidence["merges"] = [], conflicts: CompositionConflict[] = [];
  let current = input.targetSha, conflictFiles = 0;
  for (const source of sources) {
    if (signal.aborted) throw new Error("integration_cancelled");
    const { manifest, blobs } = await verifiedSnapshot(root, source.snapshotId, source.manifestHash);
    if (manifest.repositoryId !== input.repositoryId || manifest.worktreeCommit !== source.worktreeCommit || manifest.baseSha !== source.baseSha) throw new Error("integration_source_mismatch");
    for (const pin of manifest.contracts) {
      const old = contracts.get(pin.contractId);
      if (old && JSON.stringify(old) !== JSON.stringify(pin)) throw new Error("integration_contract_mismatch");
      contracts.set(pin.contractId, pin);
    }
    const changes = await snapshotBaselineChanges(root, source.snapshotId, source.manifestHash), entries = new Map(manifest.worktree.map(entry => [entry.path, entry]));
    const index = path.join(checkout, ".git", `integration-${source.resultId}.index`), env = { GIT_INDEX_FILE: index };
    try {
      await checkedCompositionGit(checkout, ["read-tree", source.baseSha], signal, undefined, env);
      for (const change of changes.changes) {
        const entry = entries.get(change.path); let record = `0 ${"0".repeat(40)}\t${change.path}\0`;
        if (entry) {
          const oid = sha.parse((await checkedCompositionGit(checkout, ["hash-object", "-w", "--stdin"], signal, blobs.get(entry.hash))).toString().trim());
          record = `${entry.mode} ${oid}\t${entry.path}\0`;
        }
        await checkedCompositionGit(checkout, ["update-index", "-z", "--index-info"], signal, record, env);
      }
      const tree = sha.parse((await checkedCompositionGit(checkout, ["write-tree"], signal, undefined, env)).toString().trim());
      const sourceCommit = sha.parse((await checkedCompositionGit(checkout, ["commit-tree", tree, "-p", source.baseSha], signal, `Result ${source.resultId}\nManifest ${source.manifestHash}\n`)).toString().trim());
      const merge = await compositionGit(checkout, ["merge-tree", "--write-tree", "-z", current, sourceCommit], signal);
      if (![0, 1].includes(merge.code)) throw new Error("integration_git_failed");
      const combinedTree = sha.parse(merge.stdout.toString().split("\0")[0].trim());
      if (merge.code === 1) {
        const conflict = { resultId: source.resultId, sourceCommit, previousCommit: current, ...conflictDetails(merge.stdout) };
        conflictFiles += conflict.files.length;
        if (conflictFiles > 1024) throw new Error("integration_conflict_limit");
        if (!conflicts.length && options.expectedFailure) {
          const actual = legacyConflict(conflict), expected = options.expectedFailure;
          if (JSON.stringify(merges) !== JSON.stringify(expected.merges) || actual.resultId !== expected.conflict.resultId
            || JSON.stringify(orderedFiles(actual.files)) !== JSON.stringify(orderedFiles(expected.conflict.files))) throw new Error("integration_resolution_mismatch");
        }
        conflicts.push(conflict);
        if (!options.expectedFailure) return { current, merges, conflicts, contracts: [...contracts.values()] };
      }
      // A temporary resolution commit may contain markers or a selected binary
      // side. Its clean index is NOT evidence that the conflicts are resolved.
      const mergedCommit = sha.parse((await checkedCompositionGit(checkout, ["commit-tree", combinedTree, "-p", current, "-p", sourceCommit], signal, `Integrate result ${source.resultId}\n`)).toString().trim());
      merges.push({ resultId: source.resultId, sourceCommit, mergedCommit, tree: combinedTree }); current = mergedCommit;
    } finally { await rm(index, { force: true }); }
  }
  if (options.expectedFailure && !conflicts.length) throw new Error("integration_resolution_mismatch");
  return { current, merges, conflicts, contracts: contractPins.parse([...contracts.values()].sort((a, b) => a.contractId.localeCompare(b.contractId))) };
}
