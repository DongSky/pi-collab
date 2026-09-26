import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { ReviewGit } from "../runtime/review-git";
import { GitHubError } from "./github-credentials";
import { githubBranch } from "./github-schema";
import { managedGit } from "./github-pack";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
export const syncGitInput = z.object({ version: z.literal(1), syncId: z.uuid(), repositoryId: z.uuid(), targetBranch: githubBranch,
  oldSha: sha, newSha: sha, observedAt: z.iso.datetime() }).strict().refine(value => value.oldSha !== value.newSha);
export type SyncGitInput = z.infer<typeof syncGitInput>;
export type SyncClassification = "equal" | "remote_ahead" | "local_ahead" | "diverged" | "branch_changed";
type Decision = "absent" | "prepared" | "applied" | "aborted";
export interface SyncObservation { decision: Decision; receiptOid: string | null; targetSha: string | null; }
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904", PACK_LIMIT = 256 * 1024 * 1024;
function fail(code: string): never { throw new GitHubError(`github_sync_${code}`); }
const git = (directory: string, args: string[], signal: AbortSignal, options?: Parameters<typeof managedGit>[3]) => managedGit(directory, ["--git-dir=.", ...args], signal, options);
const text = async (directory: string, args: string[], signal: AbortSignal, input?: string) => (await git(directory, args, signal, { input })).bytes.toString().trim();
const bounded = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
async function directory(root: string, segments: string[], signal: AbortSignal) {
  await ReviewGit.open(root, segments, signal); const result = path.join(root, ...segments);
  if (await text(result, ["rev-parse", "--is-bare-repository"], signal) !== "true" || await text(result, ["rev-parse", "--is-shallow-repository"], signal) !== "false") fail("repository_invalid");
  return result;
}
async function readRef(dir: string, ref: string, signal: AbortSignal) {
  if ((await git(dir, ["symbolic-ref", "-q", ref], signal, { codes: [0, 1] })).code !== 1) fail("symbolic_ref");
  if ((await git(dir, ["show-ref", "--verify", "--quiet", ref], signal, { codes: [0, 1] })).code === 1) return null;
  return sha.parse(await text(dir, ["show-ref", "--verify", "--hash", ref], signal));
}
async function transfer(from: string, to: string, commit: string, signal: AbortSignal) {
  const pack = await git(from, ["pack-objects", "--stdout", "--revs", "--no-reuse-delta", "--no-reuse-object"], signal, { input: `${commit}\n`, limit: PACK_LIMIT });
  await git(to, ["index-pack", "--strict", "--stdin"], signal, { input: pack.bytes });
}
/** Classification never changes a managed branch. Its staging graph receives
 * local objects so ahead/divergence is calculated from real complete ancestry. */
export async function classifyGitHubSync(root: string, repositoryId: string, syncId: string, branch: string, oldSha: string, remoteBranch: string, newSha: string, signal: AbortSignal): Promise<SyncClassification> {
  signal = bounded(signal); z.uuid().parse(repositoryId); z.uuid().parse(syncId); githubBranch.parse(branch); githubBranch.parse(remoteBranch); sha.parse(oldSha); sha.parse(newSha);
  const target = await directory(root, ["repositories", repositoryId, "git"], signal);
  if (await readRef(target, `refs/heads/${branch}`, signal) !== oldSha) fail("target_moved");
  const source = await directory(root, ["github-syncs", syncId, "git"], signal);
  if (await readRef(source, `refs/heads/${remoteBranch}`, signal) !== newSha) fail("source_changed");
  if (branch !== remoteBranch) return "branch_changed";
  if (oldSha === newSha) return "equal";
  await transfer(target, source, oldSha, signal);
  const ancestor = async (a: string, b: string) => (await git(source, ["merge-base", "--is-ancestor", a, b], signal, { codes: [0, 1] })).code === 0;
  if (await ancestor(oldSha, newSha)) return "remote_ahead";
  if (await ancestor(newSha, oldSha)) return "local_ahead";
  return "diverged";
}
function receipts(input: SyncGitInput) {
  const values = Object.fromEntries((["prepared", "applied", "aborted"] as const).map(decision => {
    const person = `pi-collab sync <sync@pi-collab.local> ${Math.floor(Date.parse(input.observedAt) / 1000)} +0000`;
    const bytes = `tree ${EMPTY_TREE}\n${decision === "aborted" ? "" : `parent ${input.newSha}\n`}author ${person}\ncommitter ${person}\n\n${JSON.stringify({ version: 1, kind: "pi-collab-github-sync", decision, input })}\n`;
    return [decision, { bytes, oid: createHash("sha1").update(`commit ${Buffer.byteLength(bytes)}\0`).update(bytes).digest("hex") }];
  })) as Record<Exclude<Decision, "absent">, { bytes: string; oid: string }>;
  return { ref: `refs/pi-collab/syncs/${input.syncId}`, values };
}
async function repository(root: string, raw: SyncGitInput, signal: AbortSignal) {
  const input = syncGitInput.parse(raw), dir = await directory(root, ["repositories", input.repositoryId, "git"], signal);
  return { input, dir, target: `refs/heads/${input.targetBranch}`, receipt: receipts(input) };
}
type Repository = Awaited<ReturnType<typeof repository>>;
async function observe(repo: Repository, signal: AbortSignal): Promise<SyncObservation> {
  const receiptOid = await readRef(repo.dir, repo.receipt.ref, signal); let decision: Decision = "absent";
  if (receiptOid) {
    const match = Object.entries(repo.receipt.values).find(([, v]) => v.oid === receiptOid); if (!match) fail("receipt_mismatch");
    const bytes = (await git(repo.dir, ["cat-file", "commit", receiptOid], signal)).bytes;
    if (!bytes.equals(Buffer.from(match[1].bytes))) fail("receipt_mismatch");
    decision = match[0] as Decision;
  }
  const targetSha = await readRef(repo.dir, repo.target, signal);
  // This proves the intended postcondition, not unique causal attribution.
  // Managed writers are excluded by durable DB occupancy. Out-of-band writers
  // with the same OS account are outside the native trust boundary.
  if (decision === "prepared" && targetSha === repo.input.newSha) decision = "applied";
  return { decision, receiptOid, targetSha };
}
async function writeObjects(repo: Repository, decision: Exclude<Decision, "absent">, signal: AbortSignal) {
  if (await text(repo.dir, ["hash-object", "-t", "tree", "-w", "--stdin"], signal, "") !== EMPTY_TREE) fail("receipt_mismatch");
  const value = repo.receipt.values[decision];
  if (await text(repo.dir, ["hash-object", "-t", "commit", "-w", "--stdin"], signal, value.bytes) !== value.oid) fail("receipt_mismatch");
}
async function change(repo: Repository, commands: string, signal: AbortSignal) {
  // Lock multiple refs, mutate exactly ONE; never rely on crash-atomic renames
  // across several loose refs. Nonzero CAS is resolved by observation.
  await git(repo.dir, ["update-ref", "--no-deref", "--stdin"], signal, { input: `start\n${commands}prepare\ncommit\n`, codes: [0, 128] });
}
async function seal(repo: Repository, signal: AbortSignal) {
  const before = await observe(repo, signal);
  if (before.decision === "applied" && before.receiptOid === repo.receipt.values.prepared.oid) {
    await writeObjects(repo, "applied", signal);
    await change(repo, `verify ${repo.target} ${repo.input.newSha}\nupdate ${repo.receipt.ref} ${repo.receipt.values.applied.oid} ${repo.receipt.values.prepared.oid}\n`, signal);
  }
  const after = await observe(repo, signal);
  if (after.decision === "applied" && after.receiptOid !== repo.receipt.values.applied.oid) fail("seal_unconfirmed");
  return after;
}
/** Internal broker primitive: a durable input/target occupancy must exist
 * before preparation. No executor or browser can call these functions. */
export async function prepareGitHubSync(root: string, raw: SyncGitInput, signal: AbortSignal, beforeCreate?: () => Promise<void>) {
  signal = bounded(signal); const repo = await repository(root, raw, signal), before = await observe(repo, signal);
  if (["applied", "aborted"].includes(before.decision)) return seal(repo, signal);
  if (before.targetSha !== repo.input.oldSha) fail("target_moved");
  const source = await directory(root, ["github-syncs", repo.input.syncId, "git"], signal);
  if (await readRef(source, `refs/heads/${repo.input.targetBranch}`, signal) !== repo.input.newSha) fail("source_changed");
  await transfer(source, repo.dir, repo.input.newSha, signal);
  await git(repo.dir, ["fsck", "--strict", "--full", "--no-reflogs", "--no-dangling"], signal);
  if ((await git(repo.dir, ["merge-base", "--is-ancestor", repo.input.oldSha, repo.input.newSha], signal, { codes: [0, 1] })).code) fail("not_fast_forward");
  await writeObjects(repo, "prepared", signal); await beforeCreate?.();
  if (before.decision === "absent") await change(repo, `create ${repo.receipt.ref} ${repo.receipt.values.prepared.oid}\n`, signal);
  return seal(repo, signal);
}
/** Final SQL authority gate surrounds this CAS. Reconciliation NEVER invokes
 * it again; it observes application or writes a terminal abort receipt. */
export async function applyGitHubSync(root: string, raw: SyncGitInput, signal: AbortSignal, hooks: { beforeUpdate?: () => Promise<void>; afterUpdate?: () => Promise<void> } = {}) {
  signal = bounded(signal); const repo = await repository(root, raw, signal), before = await observe(repo, signal);
  if (["applied", "aborted"].includes(before.decision)) return seal(repo, signal);
  if (before.decision !== "prepared" || before.targetSha !== repo.input.oldSha) fail("not_prepared");
  if ((await git(repo.dir, ["merge-base", "--is-ancestor", repo.input.oldSha, repo.input.newSha], signal, { codes: [0, 1] })).code) fail("not_fast_forward");
  await hooks.beforeUpdate?.();
  await change(repo, `verify ${repo.receipt.ref} ${repo.receipt.values.prepared.oid}\nupdate ${repo.target} ${repo.input.newSha} ${repo.input.oldSha}\n`, signal);
  await hooks.afterUpdate?.(); return seal(repo, signal);
}
export async function abortGitHubSync(root: string, raw: SyncGitInput, signal: AbortSignal) {
  signal = bounded(signal); const repo = await repository(root, raw, signal), before = await observe(repo, signal);
  if (["applied", "aborted"].includes(before.decision)) return seal(repo, signal);
  if (!before.targetSha) fail("target_moved");
  await writeObjects(repo, "aborted", signal);
  const command = before.decision === "absent" ? `create ${repo.receipt.ref} ${repo.receipt.values.aborted.oid}` : `update ${repo.receipt.ref} ${repo.receipt.values.aborted.oid} ${repo.receipt.values.prepared.oid}`;
  await change(repo, `verify ${repo.target} ${before.targetSha}\n${command}\n`, signal);
  return seal(repo, signal);
}
