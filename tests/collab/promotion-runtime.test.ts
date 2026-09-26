import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, symlink } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createWorkspace, runnerEnvironment } from "../../lib/collab/runtime/workspace";
import { captureSnapshot } from "../../lib/collab/runtime/snapshots";
import { integrate } from "../../lib/collab/runtime/integration";
import { prepareLocalPromotion, applyLocalPromotion, abortLocalPromotion, observeLocalPromotion, localPromotionCommit } from "../../lib/collab/runtime/local-promotion";
import type { PromotionInput } from "../../lib/collab/promotion-schema";
import type { IntegrationClaim } from "../../lib/collab/integration-schema";

const exec = promisify(execFile), signal = () => new AbortController().signal;
const git = async (cwd: string, args: string[]) => (await exec("git", args, { cwd, env: runnerEnvironment("/nonexistent", "/nonexistent") })).stdout.trim();
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "pi-collab-promotion-")), original = path.join(root, "original"), repositoryId = randomUUID();
  const repository = path.join(root, "repositories", repositoryId, "git");
  await mkdir(original); await git(original, ["init", "-b", "main"]); await git(original, ["config", "user.name", "Promotion test"]); await git(original, ["config", "user.email", "promotion@test.invalid"]);
  for (const [file, bytes] of Object.entries({ "code.txt": "baseline\n", "delete.txt": "remove\n", ".env": "PRIVATE_FIXTURE=unchanged\n" })) await writeFile(path.join(original, file), bytes);
  await git(original, ["add", "."]); await git(original, ["commit", "-m", "Baseline"]); const base = await git(original, ["rev-parse", "HEAD"]);
  await mkdir(path.dirname(repository), { recursive: true }); await git(original, ["clone", "--bare", "--no-local", "--", original, repository]); await git(repository, ["remote", "remove", "origin"]);
  async function candidate(content = "combined\n", target = base) {
    const workspace = await createWorkspace(root, randomUUID(), repository, target, true);
    await writeFile(path.join(workspace.checkout, "code.txt"), content); await writeFile(path.join(workspace.checkout, "binary.bin"), Buffer.from([0, 1, 42]));
    await writeFile(path.join(workspace.checkout, "executable.sh"), "#!/bin/sh\nexit 0\n"); await chmod(path.join(workspace.checkout, "executable.sh"), 0o755); await rm(path.join(workspace.checkout, "delete.txt"), { force: true });
    const saved = await captureSnapshot(root, { id: randomUUID(), workspaceId: workspace.id, runId: randomUUID(), repositoryId, baseSha: target, note: "Exact source bytes", context: { title: "Source", description: "", acceptance: "", prompt: "", status: "completed" } });
    const claim: IntegrationClaim = { id: randomUUID(), executorId: randomUUID(), epoch: "1", repositoryId, targetBranch: "main", targetSha: target,
      inputHash: createHash("sha256").update(randomUUID()).digest("hex"), profileId: randomUUID(), checkId: randomUUID(),
      config: { version: 1, steps: [{ tool: "node", args: ["-e", `require('node:assert/strict').equal(require('node:fs').readFileSync('code.txt','utf8'),${JSON.stringify(content)})`], timeoutSeconds: 10 }] },
      sources: [{ resultId: randomUUID(), taskId: randomUUID(), snapshotId: saved.manifest.id, manifestHash: saved.manifestHash, worktreeCommit: saved.manifest.worktreeCommit, baseSha: target, dependencyResultIds: [] }] };
    const evidence = await integrate(root, claim, signal(), async () => {}); assert.equal(evidence.outcome, "checked");
    const candidateSha = evidence.candidateCommit!, candidateTree = await git(path.join(root, "workspaces", claim.id, "checkout"), ["rev-parse", `${candidateSha}^{tree}`]);
    const input: PromotionInput = { version: 1, promotionId: randomUUID(), integrationId: claim.id, repositoryId, requestedAt: new Date().toISOString(), targetBranch: "main", targetSha: target,
      candidateSha, candidateTree, inputHash: claim.inputHash, revisionHash: createHash("sha256").update(JSON.stringify(evidence)).digest("hex"),
      policyId: randomUUID(), profileId: claim.profileId, manifestHash: evidence.snapshot!.manifestHash, worktreeCommit: evidence.snapshot!.worktreeCommit };
    return { input, workspace, evidence };
  }
  return { root, original, repository, repositoryId, base, candidate, close: () => rm(root, { recursive: true, force: true }) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function using(run: (f: Fixture) => Promise<void>) { const f = await fixture(); try { await run(f); } finally { await f.close(); } }

test("native promotion preserves the exact checked tree, binary/modes/deletion and unchanged excluded base; originals remain intact", () => using(async f => {
  const { input, workspace } = await f.candidate(), expected = localPromotionCommit(input).oid;
  const prepared = await prepareLocalPromotion(f.root, input, signal()); assert.equal(prepared.observation.decision, "prepared"); assert.equal(prepared.verification?.tree, input.candidateTree);
  assert.ok(prepared.verification?.unchangedExcluded.some(item => item.path === ".env")); assert.equal(await git(f.repository, ["rev-parse", "main"]), f.base);
  const result = await applyLocalPromotion(f.root, input, signal()); assert.equal(result.decision, "applied"); assert.equal(result.appliedTargetCurrent, true);
  assert.equal(await git(f.repository, ["rev-parse", "main"]), expected); assert.equal(await git(f.repository, ["rev-parse", "main^{tree}"]), input.candidateTree);
  assert.equal(await git(f.repository, ["show", "main:.env"]), "PRIVATE_FIXTURE=unchanged");
  assert.equal(await git(f.original, ["rev-parse", "HEAD"]), f.base); assert.equal(await git(workspace.checkout, ["rev-parse", "HEAD"]), f.base);
  assert.equal((await applyLocalPromotion(f.root, input, signal())).decision, "applied"); assert.equal((await abortLocalPromotion(f.root, input, signal())).decision, "applied");
  assert.equal(await git(f.repository, ["rev-list", "--count", `${input.candidateSha}..main`]), "1");
}));

test("two verified candidates race one expected target; only one actual branch change succeeds", () => using(async f => {
  const first = await f.candidate("one\n"), second = await f.candidate("two\n");
  await Promise.all([prepareLocalPromotion(f.root, first.input, signal()), prepareLocalPromotion(f.root, second.input, signal())]);
  await Promise.allSettled([applyLocalPromotion(f.root, first.input, signal()), applyLocalPromotion(f.root, second.input, signal())]);
  const observations = await Promise.all([first, second].map(c => observeLocalPromotion(f.root, c.input, signal())));
  assert.equal(observations.filter(o => o.decision === "applied").length, 1);
  const loser = observations[0].decision === "applied" ? second.input : first.input;
  assert.equal((await abortLocalPromotion(f.root, loser, signal())).decision, "aborted");
  const tip = await git(f.repository, ["rev-parse", "main"]); assert.equal((await applyLocalPromotion(f.root, loser, signal())).decision, "aborted"); assert.equal(await git(f.repository, ["rev-parse", "main"]), tip);
}));

test("cancellation before preparation fences a late worker; concurrent apply/abort produces a single terminal decision", () => using(async f => {
  const a = await f.candidate(); assert.equal((await abortLocalPromotion(f.root, a.input, signal())).decision, "aborted");
  assert.equal((await prepareLocalPromotion(f.root, a.input, signal())).observation.decision, "aborted"); assert.equal((await applyLocalPromotion(f.root, a.input, signal())).decision, "aborted");
  assert.equal(await git(f.repository, ["rev-parse", "main"]), f.base);
  const b = await f.candidate(); await prepareLocalPromotion(f.root, b.input, signal());
  await Promise.allSettled([applyLocalPromotion(f.root, b.input, signal()), abortLocalPromotion(f.root, b.input, signal())]);
  let end = await observeLocalPromotion(f.root, b.input, signal());
  if (end.decision === "prepared") end = await abortLocalPromotion(f.root, b.input, signal());
  assert.ok(["applied", "aborted"].includes(end.decision));
  assert.equal(await git(f.repository, ["rev-parse", "main"]), end.decision === "applied" ? end.promotionSha : f.base);
}));

test("an actual executor crash after the one-ref update is proven from the target and reconciled without applying again", () => using(async f => {
  const { input } = await f.candidate(); await prepareLocalPromotion(f.root, input, signal());
  const inputFile = path.join(f.root, "input.json"); await writeFile(inputFile, JSON.stringify(input));
  const child = spawn(process.execPath, ["--import", "tsx", "tests/collab/fixtures/crash-promotion.ts", f.root, inputFile], { stdio: "ignore" });
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  assert.equal(exit.signal, "SIGKILL");
  const uncertain = await observeLocalPromotion(f.root, input, signal()); assert.equal(uncertain.decision, "applied"); assert.equal(uncertain.applicationEvidence, "target");
  const acknowledged = await abortLocalPromotion(f.root, input, signal()); assert.equal(acknowledged.decision, "applied"); assert.equal(acknowledged.applicationEvidence, "receipt");
  assert.equal(await git(f.repository, ["rev-list", "--count", `${input.candidateSha}..main`]), "1");
}));

test("an unsealed write remains attributable after a later fast-forward; sealed receipts retain history after divergence", () => using(async f => {
  const first = await f.candidate(); await prepareLocalPromotion(f.root, first.input, signal());
  await assert.rejects(applyLocalPromotion(f.root, first.input, signal(), { afterTargetUpdate: async () => { throw new Error("lost acknowledgement"); } }), /lost acknowledgement/);
  const target = localPromotionCommit(first.input).oid, second = await f.candidate("later\n", target);
  await prepareLocalPromotion(f.root, second.input, signal()); await applyLocalPromotion(f.root, second.input, signal());
  const past = await observeLocalPromotion(f.root, first.input, signal()); assert.equal(past.decision, "applied"); assert.equal(past.applicationEvidence, "ancestry"); assert.equal(past.appliedTargetCurrent, false);
  await abortLocalPromotion(f.root, first.input, signal());
  // External history rewrites are not approved by this broker; keep the proven
  // historical receipt and expose divergence instead of resetting the branch.
  await git(f.repository, ["update-ref", "refs/heads/main", f.base]);
  const divergent = await observeLocalPromotion(f.root, first.input, signal()); assert.equal(divergent.decision, "applied"); assert.equal(divergent.appliedTargetCurrent, false);
}));

test("a checked candidate containing a changed excluded path is refused instead of treating omissions as tested", () => using(async f => {
  const candidate = await f.candidate(), checkout = path.join(f.root, "workspaces", candidate.input.integrationId, "checkout");
  await writeFile(path.join(checkout, ".env"), "PRIVATE_FIXTURE=changed\n"); await git(checkout, ["add", ".env"]); await git(checkout, ["commit", "-m", "Unchecked private change"]);
  const malicious = { ...candidate.input, candidateSha: await git(checkout, ["rev-parse", "HEAD"]), candidateTree: await git(checkout, ["rev-parse", "HEAD^{tree}"]) };
  // Capture has omitted .env, so even a matching snapshot identity is not proof
  // that every difference in the actual Git candidate was checked.
  const saved = await captureSnapshot(f.root, { id: randomUUID(), runId: randomUUID(), workspaceId: candidate.input.integrationId, repositoryId: f.repositoryId,
    baseSha: f.base, note: "Excluded difference", context: { title: "candidate", description: "", acceptance: "", prompt: "", status: "checking" } });
  const renamed = { ...malicious, integrationId: saved.manifest.id, manifestHash: saved.manifestHash, worktreeCommit: saved.manifest.worktreeCommit };
  await mkdir(path.join(f.root, "workspaces", renamed.integrationId));
  await git(checkout, ["clone", "--no-local", "--", checkout, path.join(f.root, "workspaces", renamed.integrationId, "checkout")]);
  await assert.rejects(prepareLocalPromotion(f.root, renamed, signal()), /promotion_unchecked_candidate_changes/);
  assert.equal(await git(f.repository, ["rev-parse", "main"]), f.base); assert.equal((await observeLocalPromotion(f.root, renamed, signal())).decision, "absent");
}));

test("missing/corrupt artifacts, identity reuse, unsafe refs and symbolic broker paths fail before a branch update", () => using(async f => {
  const { input } = await f.candidate();
  for (const branch of ["../escape", "main\nupdate refs/heads/other", "main.lock", "main:other"]) await assert.rejects(prepareLocalPromotion(f.root, { ...input, targetBranch: branch }, signal()));
  await git(f.repository, ["symbolic-ref", "refs/heads/alias", "refs/heads/main"]);
  await assert.rejects(prepareLocalPromotion(f.root, { ...input, targetBranch: "alias" }, signal()), /promotion_symbolic_ref/);
  await git(f.repository, ["symbolic-ref", "--delete", "refs/heads/alias"]);
  await prepareLocalPromotion(f.root, input, signal());
  await assert.rejects(prepareLocalPromotion(f.root, { ...input, revisionHash: "f".repeat(64) }, signal()), /promotion_receipt_mismatch/);
  const artifact = path.join(f.root, "snapshots", input.integrationId, "manifest.json"), bytes = await readFile(artifact); await writeFile(artifact, "{}");
  await assert.rejects(applyLocalPromotion(f.root, input, signal()), /snapshot_invalid_artifact/); await writeFile(artifact, bytes);
  const config = path.join(f.repository, "objects", "info", "alternates"); await writeFile(config, "/nonexistent\n");
  await assert.rejects(observeLocalPromotion(f.root, input, signal()), /integration_code_unavailable/); await rm(config);
  const old = f.repository + "-saved"; await (await import("node:fs/promises")).rename(f.repository, old); await symlink(old, f.repository);
  await assert.rejects(applyLocalPromotion(f.root, input, signal()), /integration_code_unavailable/);
  assert.equal(await git(f.original, ["rev-parse", "HEAD"]), f.base);
}));

test("caller cancellation does not falsely certify an operation or create a reusable prepared decision", () => using(async f => {
  const { input } = await f.candidate(), controller = new AbortController(); controller.abort();
  await assert.rejects(prepareLocalPromotion(f.root, input, controller.signal));
  assert.equal((await observeLocalPromotion(f.root, input, signal())).decision, "absent");
  await assert.rejects(applyLocalPromotion(f.root, input, signal()), /promotion_not_prepared/);
  assert.equal(await git(f.repository, ["rev-parse", "main"]), f.base);
}));

test("ordinary Git garbage collection preserves prepared code and applied historical evidence", () => using(async f => {
  const { input } = await f.candidate(); await prepareLocalPromotion(f.root, input, signal());
  await git(f.repository, ["gc", "--prune=now"]);
  assert.equal((await applyLocalPromotion(f.root, input, signal())).decision, "applied");
  await git(f.repository, ["update-ref", "refs/heads/main", f.base]);
  await git(f.repository, ["reflog", "expire", "--expire=now", "--all"]); await git(f.repository, ["gc", "--prune=now"]);
  const observed = await observeLocalPromotion(f.root, input, signal()); assert.equal(observed.decision, "applied"); assert.equal(observed.applicationEvidence, "receipt"); assert.equal(observed.appliedTargetCurrent, false);
  assert.equal(await git(f.repository, ["cat-file", "-t", observed.promotionSha]), "commit"); await git(f.repository, ["fsck", "--strict"]);
}));

test("corrupted candidate Git objects cannot open a prepared decision", () => using(async f => {
  const { input } = await f.candidate();
  const object = path.join(f.root, "workspaces", input.integrationId, "checkout", ".git", "objects", input.candidateSha.slice(0, 2), input.candidateSha.slice(2));
  await chmod(object, 0o600); await writeFile(object, "damaged object");
  await assert.rejects(prepareLocalPromotion(f.root, input, signal()), /integration_code_unavailable|promotion_git_unavailable/);
  assert.equal((await observeLocalPromotion(f.root, input, signal())).decision, "absent"); assert.equal(await git(f.repository, ["rev-parse", "main"]), f.base);
}));

test("repository-configured reference hooks cannot execute during promotion", () => using(async f => {
  const { input } = await f.candidate(), hooks = path.join(f.root, "hooks"), marker = path.join(f.root, "hook-ran");
  await mkdir(hooks); await writeFile(path.join(hooks, "reference-transaction"), `#!/bin/sh\nprintf hook > '${marker}'\n`, { mode: 0o755 });
  await git(f.repository, ["config", "core.hooksPath", hooks]);
  await prepareLocalPromotion(f.root, input, signal()); assert.equal((await applyLocalPromotion(f.root, input, signal())).decision, "applied");
  await assert.rejects(readFile(marker), /ENOENT/);
}));

test("a preparer paused after its original absent observation cannot reopen a concurrent terminal cancellation", () => using(async f => {
  const { input } = await f.candidate(); let resume!: () => void, announce!: () => void;
  const paused = new Promise<void>(resolve => { announce = resolve; }), continuation = new Promise<void>(resolve => { resume = resolve; });
  const preparing = prepareLocalPromotion(f.root, input, signal(), { beforeDecisionCreate: async () => { announce(); await continuation; } });
  try {
    await Promise.race([paused, preparing.then(() => { throw new Error("Expected preparation pause"); })]);
    assert.equal((await abortLocalPromotion(f.root, input, signal())).decision, "aborted");
  } finally { resume(); }
  assert.equal((await preparing).observation.decision, "aborted"); assert.equal((await applyLocalPromotion(f.root, input, signal())).decision, "aborted");
  assert.equal(await git(f.repository, ["rev-parse", "main"]), f.base);
}));
