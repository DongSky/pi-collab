import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { promotionInputSchema, type PromotionInput, type PromotionObservation } from "../promotion-schema";
import { ReviewGit } from "./review-git";
import { runnerEnvironment } from "./workspace";
import { snapshotBaselineChanges, verifiedSnapshot } from "./snapshots";

const oid = (type: string, data: Buffer | string) => {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");
};
const sha = /^[a-f0-9]{40}$/;
function fail(reason: string): never { throw new Error(`promotion_${reason}`); }
const PACK_LIMIT = 128 * 1024 * 1024;
const bounded = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const identity = (input: PromotionInput) => `pi-collab integration <integration@pi-collab.local> ${Math.floor(Date.parse(input.requestedAt) / 1000)} +0000`;

// Commands use broker-owned paths, fixed IDs, explicit configuration and no
// remote helper. Failure/timeout after a ref command is uncertainty until read.
async function git(directory: string, args: string[], signal: AbortSignal, input?: Buffer | string, limit = 4 * 1024 * 1024, extra: Record<string, string> = {}) {
  return new Promise<{ code: number; bytes: Buffer }>((resolve, reject) => {
    if (signal.aborted) { reject(new Error("promotion_cancelled")); return; }
    const child = spawn("git", ["--git-dir=.", "--no-pager", "--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
      "-c", "core.attributesFile=/dev/null", "-c", "protocol.allow=never", "-c", "core.fsync=committed", "-c", "core.fsyncMethod=fsync", ...args], {
      cwd: directory, env: { ...runnerEnvironment("/nonexistent", "/nonexistent"), GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_CEILING_DIRECTORIES: directory, ...extra }, stdio: "pipe",
    });
    const chunks: Buffer[] = []; let bytes = 0, failed = false;
    const stop = () => { failed = true; child.kill("SIGKILL"); };
    signal.addEventListener("abort", stop, { once: true }); const timer = setTimeout(stop, 30_000);
    child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > limit) stop(); else chunks.push(chunk); });
    child.stderr.resume(); child.stdin.on("error", () => {}); child.stdin.end(input);
    child.once("error", () => { failed = true; });
    child.once("close", code => {
      clearTimeout(timer); signal.removeEventListener("abort", stop);
      if (failed || code === null) reject(new Error(signal.aborted ? "promotion_cancelled" : "promotion_git_unavailable"));
      else resolve({ code, bytes: Buffer.concat(chunks) });
    });
  });
}
async function checked(directory: string, args: string[], signal: AbortSignal, input?: Buffer | string, limit?: number, extra?: Record<string, string>) {
  const result = await git(directory, args, signal, input, limit, extra);
  if (result.code) fail("git_unavailable"); return result.bytes;
}
function receipts(input: PromotionInput) {
  const values = Object.fromEntries((["prepared", "applied", "aborted"] as const).map(decision => {
    // Prepared/applied records keep the unique promotion and its code graph
    // reachable through ordinary Git GC, even if the target later diverges.
    // Aborted records have no parent: they can fence a not-yet-prepared writer.
    const parent = decision === "aborted" ? "" : `parent ${localPromotionCommit(input).oid}\n`;
    const bytes = `tree ${EMPTY_TREE}\n${parent}author ${identity(input)}\ncommitter ${identity(input)}\n\n${JSON.stringify({ version: 1, kind: "pi-collab-local-promotion", decision, input })}\n`;
    return [decision, { bytes, oid: oid("commit", bytes) }];
  })) as Record<"prepared" | "applied" | "aborted", { bytes: string; oid: string }>;
  return { ref: `refs/pi-collab/promotions/${input.promotionId}`, values };
}
/** One uniquely attributable commit with exactly the reviewed candidate tree.
 * Its identity can be computed before any Git effect or database admission. */
export function localPromotionCommit(raw: PromotionInput) {
  const input = promotionInputSchema.parse(raw);
  const bytes = `tree ${input.candidateTree}\nparent ${input.candidateSha}\nauthor ${identity(input)}\ncommitter ${identity(input)}\n\npi-collab local promotion\n\n${JSON.stringify(input)}\n`;
  return { bytes, oid: oid("commit", bytes) };
}
async function repository(root: string, raw: PromotionInput, signal: AbortSignal) {
  const input = promotionInputSchema.parse(raw), segments = ["repositories", input.repositoryId, "git"];
  await ReviewGit.open(root, segments, signal); const directory = path.join(root, ...segments), target = `refs/heads/${input.targetBranch}`;
  if ((await checked(directory, ["rev-parse", "--is-bare-repository"], signal)).toString().trim() !== "true") fail("repository_not_bare");
  if ((await git(directory, ["check-ref-format", target], signal)).code) fail("invalid_branch");
  const receipt = receipts(input);
  for (const ref of [target, receipt.ref]) {
    const symbolic = await git(directory, ["symbolic-ref", "-q", ref], signal);
    if (symbolic.code !== 1) fail("symbolic_ref");
  }
  return { input, directory, target, receipt, commit: localPromotionCommit(input) };
}
type Repository = Awaited<ReturnType<typeof repository>>;
async function readRef(repo: Repository, ref: string, signal: AbortSignal) {
  const exists = await git(repo.directory, ["show-ref", "--verify", "--quiet", ref], signal);
  if (exists.code === 1) return null;
  if (exists.code) fail("ref_unavailable");
  const result = await git(repo.directory, ["show-ref", "--verify", "--hash", ref], signal);
  if (result.code || !sha.test(result.bytes.toString().trim())) fail("ref_unavailable");
  return result.bytes.toString().trim();
}
async function observe(repo: Repository, signal: AbortSignal): Promise<PromotionObservation> {
  // Read the receipt first. An applied receipt proves a historical write even
  // if another authorized operation subsequently advanced the target again.
  const receiptOid = await readRef(repo, repo.receipt.ref, signal);
  let decision: PromotionObservation["decision"] = "absent";
  if (receiptOid) {
    const match = Object.entries(repo.receipt.values).find(([, value]) => value.oid === receiptOid);
    if (!match) fail("receipt_mismatch");
    const content = await checked(repo.directory, ["cat-file", "commit", receiptOid], signal, undefined, 16384);
    if (!content.equals(Buffer.from(match[1].bytes)) || oid("commit", content) !== receiptOid) fail("receipt_mismatch");
    decision = match[0] as PromotionObservation["decision"];
  }
  const targetSha = await readRef(repo, repo.target, signal);
  let applicationEvidence: PromotionObservation["applicationEvidence"] = decision === "applied" ? "receipt" : null;
  if (targetSha === repo.commit.oid) applicationEvidence ??= "target";
  else if (targetSha && targetSha !== repo.input.targetSha && decision !== "absent") {
    const exists = await git(repo.directory, ["cat-file", "-e", `${repo.commit.oid}^{commit}`], signal);
    if (!exists.code) {
      const ancestor = await git(repo.directory, ["merge-base", "--is-ancestor", repo.commit.oid, targetSha], signal);
      if (ancestor.code > 1) fail("ref_unavailable");
      if (!ancestor.code) applicationEvidence ??= "ancestry";
    } else fail("candidate_invalid");
  }
  if (applicationEvidence) {
    if (decision === "aborted" || decision === "absent") fail("receipt_mismatch");
    const bytes = await checked(repo.directory, ["cat-file", "commit", repo.commit.oid], signal, undefined, 16384);
    if (!bytes.equals(Buffer.from(repo.commit.bytes)) || oid("commit", bytes) !== repo.commit.oid) fail("candidate_invalid");
    decision = "applied";
  }
  return { decision, receiptRef: repo.receipt.ref, receiptOid, promotionSha: repo.commit.oid, applicationEvidence,
    targetSha, targetMatchesExpected: targetSha === repo.input.targetSha, appliedTargetCurrent: decision === "applied" && targetSha === repo.commit.oid };
}
async function writeReceiptObjects(repo: Repository, signal: AbortSignal, decisions: ("prepared" | "applied" | "aborted")[]) {
  if ((await checked(repo.directory, ["hash-object", "-t", "tree", "-w", "--stdin"], signal, "")).toString().trim() !== EMPTY_TREE) fail("receipt_mismatch");
  for (const decision of decisions) {
    const value = repo.receipt.values[decision];
    if ((await checked(repo.directory, ["hash-object", "-t", "commit", "-w", "--stdin"], signal, value.bytes)).toString().trim() !== value.oid) fail("receipt_mismatch");
  }
}

/** Verify that EVERY changed candidate path is exactly represented by the
 * checked snapshot. Excluded baseline paths may survive only unchanged. */
async function verifyTree(root: string, repo: Repository, candidateDirectory: string, candidateReader: ReviewGit, signal: AbortSignal) {
  const { input } = repo, saved = await verifiedSnapshot(root, input.integrationId, input.manifestHash), m = saved.manifest;
  if (m.repositoryId !== input.repositoryId || m.baseSha !== input.targetSha || m.sourceHead !== input.candidateSha || m.worktreeCommit !== input.worktreeCommit || m.resolution) fail("snapshot_mismatch");
  const bytes = (await candidateReader.objects([input.candidateSha], "commit", 1024 * 1024)).get(input.candidateSha)!;
  const match = /^tree ([a-f0-9]{40})\n/.exec(bytes.toString("utf8")); if (!match) fail("candidate_invalid");
  if ((await git(candidateDirectory, ["merge-base", "--is-ancestor", input.targetSha, input.candidateSha], signal)).code) fail("not_fast_forward");
  const delta = await snapshotBaselineChanges(root, input.integrationId, input.manifestHash), entries = new Map(m.worktree.map(entry => [entry.path, entry]));
  const parent = path.join(root, "promotion-verifications"); await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(path.join(parent, `${input.promotionId}-`)), extra = { GIT_INDEX_FILE: path.join(temporary, "index") };
  try {
    await checked(repo.directory, ["read-tree", input.targetSha], signal, undefined, undefined, extra);
    const updates: string[] = [];
    for (const change of delta.changes) {
      const entry = entries.get(change.path);
      if (!entry) updates.push(`0 ${"0".repeat(40)}\t${change.path}\0`);
      else {
        const blob = saved.blobs.get(entry.hash)!, expected = oid("blob", blob);
        const actual = (await checked(repo.directory, ["hash-object", "-w", "--stdin"], signal, blob)).toString().trim();
        if (actual !== expected) fail("snapshot_mismatch");
        updates.push(`${entry.mode} ${expected}\t${entry.path}\0`);
      }
    }
    if (updates.length) await checked(repo.directory, ["update-index", "-z", "--index-info"], signal, updates.join(""), undefined, extra);
    const expectedTree = (await checked(repo.directory, ["write-tree"], signal, undefined, undefined, extra)).toString().trim();
    if (expectedTree !== match[1] || match[1] !== input.candidateTree) fail("unchecked_candidate_changes");
    return { tree: expectedTree, changedPaths: delta.changes.length, unchangedExcluded: delta.excluded };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

/** INTERNAL native broker primitive. The caller must admit and durably record
 * this operation with current policy/authority. No HTTP route calls it yet.
 * Preparation imports only verified objects and opens a once-only decision. */
export async function prepareLocalPromotion(root: string, raw: PromotionInput, signal: AbortSignal, hooks: { beforeDecisionCreate?: () => Promise<void> } = {}) {
  signal = bounded(signal);
  const repo = await repository(root, raw, signal), before = await observe(repo, signal);
  if (before.decision === "applied" || before.decision === "aborted") return { observation: before, verification: null };
  if (!before.targetMatchesExpected) fail("target_moved");
  const parts = ["workspaces", repo.input.integrationId, "checkout", ".git"], source = await ReviewGit.open(root, parts, signal), sourceDirectory = path.join(root, ...parts);
  const verification = await verifyTree(root, repo, sourceDirectory, source, signal);
  // Transfer fixed objects over bounded pipes, never fetch a user-provided URL
  // or share alternates/hardlinks with an agent's repository.
  const pack = await checked(sourceDirectory, ["pack-objects", "--stdout", "--revs", "--no-reuse-delta", "--no-reuse-object"], signal,
    `${repo.input.candidateSha}\n^${repo.input.targetSha}\n`, PACK_LIMIT);
  await checked(repo.directory, ["index-pack", "--strict", "--stdin"], signal, pack);
  await verifyTree(root, repo, repo.directory, await ReviewGit.open(root, ["repositories", repo.input.repositoryId, "git"], signal), signal);
  if ((await checked(repo.directory, ["hash-object", "-t", "commit", "-w", "--stdin"], signal, repo.commit.bytes)).toString().trim() !== repo.commit.oid) fail("candidate_invalid");
  await writeReceiptObjects(repo, signal, ["prepared", "applied"]);
  await hooks.beforeDecisionCreate?.();
  // A concurrent abort can create its terminal receipt while objects import.
  // Never replace that receipt or silently re-open an old decision.
  if (before.decision === "absent") await git(repo.directory, ["update-ref", "--no-deref", "--stdin"], signal, `start\ncreate ${repo.receipt.ref} ${repo.receipt.values.prepared.oid}\nprepare\ncommit\n`);
  return { observation: await observe(repo, signal), verification };
}

async function sealApplied(repo: Repository, before: PromotionObservation, signal: AbortSignal) {
  if (before.decision === "applied" && before.receiptOid === repo.receipt.values.prepared.oid) {
    // Only the receipt changes. The target/ancestry already proves application;
    // this second durable record is useful after later branch advancement.
    await writeReceiptObjects(repo, signal, ["applied"]);
    await git(repo.directory, ["update-ref", "--no-deref", "--stdin"], signal,
      `start\nupdate ${repo.receipt.ref} ${repo.receipt.values.applied.oid} ${repo.receipt.values.prepared.oid}\nprepare\ncommit\n`);
  }
  return observe(repo, signal);
}

/** Caller must hold the final database authority gate around this operation.
 * Git locks both refs but mutates ONLY the target, so file-ref crash atomicity
 * does not depend on committing several renamed lockfiles together. */
export async function applyLocalPromotion(root: string, raw: PromotionInput, signal: AbortSignal, hooks: { beforeTargetUpdate?: () => Promise<void>; afterTargetUpdate?: () => Promise<void> } = {}) {
  signal = bounded(signal);
  const repo = await repository(root, raw, signal), before = await observe(repo, signal);
  if (before.decision === "applied") return sealApplied(repo, before, signal);
  if (before.decision === "aborted") return before;
  if (before.decision !== "prepared") fail("not_prepared");
  if (!before.targetMatchesExpected) fail("target_moved");
  await verifyTree(root, repo, repo.directory, await ReviewGit.open(root, ["repositories", repo.input.repositoryId, "git"], signal), signal);
  await hooks.beforeTargetUpdate?.();
  await git(repo.directory, ["update-ref", "--no-deref", "--stdin"], signal,
    `start\nverify ${repo.receipt.ref} ${repo.receipt.values.prepared.oid}\nupdate ${repo.target} ${repo.commit.oid} ${repo.input.targetSha}\nprepare\ncommit\n`);
  await hooks.afterTargetUpdate?.();
  return sealApplied(repo, await observe(repo, signal), signal);
}

/** Terminal CAS closes even an operation whose old process has not prepared
 * yet. No lease timeout, PID check or missing receipt alone proves nonexecution. */
export async function abortLocalPromotion(root: string, raw: PromotionInput, signal: AbortSignal) {
  signal = bounded(signal);
  const repo = await repository(root, raw, signal), before = await observe(repo, signal);
  if (before.decision === "applied") return sealApplied(repo, before, signal);
  if (before.decision === "aborted") return before;
  if (!before.targetSha) fail("target_moved");
  await writeReceiptObjects(repo, signal, ["aborted"]);
  const command = before.decision === "absent" ? `create ${repo.receipt.ref} ${repo.receipt.values.aborted.oid}`
    : `update ${repo.receipt.ref} ${repo.receipt.values.aborted.oid} ${repo.receipt.values.prepared.oid}`;
  // Verify/lock the observed target against a concurrent apply. The decision
  // ref is the ONLY mutation; once terminal, even a late preparer cannot reopen.
  await git(repo.directory, ["update-ref", "--no-deref", "--stdin"], signal, `start\nverify ${repo.target} ${before.targetSha}\n${command}\nprepare\ncommit\n`);
  return sealApplied(repo, await observe(repo, signal), signal);
}

export async function observeLocalPromotion(root: string, raw: PromotionInput, signal: AbortSignal) {
  signal = bounded(signal);
  return observe(await repository(root, raw, signal), signal);
}
