import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { gitSource } from "./fixtures/git-source";
import { classifyGitHubSync, prepareGitHubSync, applyGitHubSync, abortGitHubSync, type SyncGitInput } from "../../lib/collab/git/github-sync-git";
const exec = promisify(execFile), signal = () => AbortSignal.timeout(30_000);
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "pi-collab-sync-git-")), repositoryId = randomUUID(), syncId = randomUUID();
  const newSha = await gitSource(root), oldSha = (await exec("git", ["rev-parse", "HEAD^"], { cwd: path.join(root, "source") })).stdout.trim();
  const target = path.join(root, "repositories", repositoryId, "git"), source = path.join(root, "github-syncs", syncId, "git");
  for (const dir of [target, source]) { await mkdir(path.dirname(dir), { recursive: true }); await exec("git", ["clone", "--bare", "--no-local", path.join(root, "source.git"), dir]); }
  await exec("git", ["update-ref", "refs/heads/main", oldSha], { cwd: target });
  const input: SyncGitInput = { version: 1, syncId, repositoryId, targetBranch: "main", oldSha, newSha, observedAt: new Date().toISOString() };
  return { root, input, target, source, head: async () => (await exec("git", ["rev-parse", "refs/heads/main"], { cwd: target })).stdout.trim(), close: () => rm(root, { recursive: true, force: true }) };
}
test("real Git classifies equal, ahead, behind, divergence and branch change without moving target", async () => {
  const f = await fixture(); try {
    const classify = (branch: string, old: string, remote: string, next: string) => classifyGitHubSync(f.root, f.input.repositoryId, f.input.syncId, branch, old, remote, next, signal());
    assert.equal(await classify("main", f.input.oldSha, "main", f.input.newSha), "remote_ahead");
    assert.equal(await f.head(), f.input.oldSha);
    await exec("git", ["update-ref", "refs/heads/main", f.input.newSha], { cwd: f.target });
    assert.equal(await classify("main", f.input.newSha, "main", f.input.newSha), "equal");
    await exec("git", ["update-ref", "refs/heads/main", f.input.oldSha], { cwd: f.source });
    assert.equal(await classify("main", f.input.newSha, "main", f.input.oldSha), "local_ahead");
    await exec("git", ["checkout", "--detach", f.input.oldSha], { cwd: path.join(f.root, "source") });
    await writeFile(path.join(f.root, "source", "other.txt"), "divergent\n");
    for (const args of [["add", "."], ["commit", "-m", "Divergence"], ["push", f.source, "HEAD:refs/heads/main"]]) await exec("git", args, { cwd: path.join(f.root, "source") });
    const diverged = (await exec("git", ["rev-parse", "HEAD"], { cwd: path.join(f.root, "source") })).stdout.trim();
    assert.equal(await classify("main", f.input.newSha, "main", diverged), "diverged");
    await exec("git", ["update-ref", "refs/heads/renamed", diverged], { cwd: f.source });
    assert.equal(await classify("main", f.input.newSha, "renamed", diverged), "branch_changed");
    assert.equal(await f.head(), f.input.newSha);
  } finally { await f.close(); }
});
test("sync preserves the original remote SHA and seals idempotent evidence", async () => {
  const f = await fixture(); try {
    assert.equal((await prepareGitHubSync(f.root, f.input, signal())).decision, "prepared");
    assert.equal(await f.head(), f.input.oldSha);
    const result = await applyGitHubSync(f.root, f.input, signal()); assert.equal(result.decision, "applied"); assert.equal(await f.head(), f.input.newSha);
    assert.deepEqual(await abortGitHubSync(f.root, f.input, signal()), result);
    assert.deepEqual(await applyGitHubSync(f.root, f.input, signal()), result);
  } finally { await f.close(); }
});
test("terminal abort fences an in-flight preparer and late applier", async () => {
  const f = await fixture(); try {
    const prepared = await prepareGitHubSync(f.root, f.input, signal(), async () => { assert.equal((await abortGitHubSync(f.root, f.input, signal())).decision, "aborted"); });
    assert.equal(prepared.decision, "aborted");
    assert.equal((await applyGitHubSync(f.root, f.input, signal())).decision, "aborted"); assert.equal(await f.head(), f.input.oldSha);
  } finally { await f.close(); }
});
test("terminal abort races target CAS without rewind or reopen", async () => {
  const f = await fixture(); try {
    await prepareGitHubSync(f.root, f.input, signal());
    const applied = await applyGitHubSync(f.root, f.input, signal(), { beforeUpdate: async () => { assert.equal((await abortGitHubSync(f.root, f.input, signal())).decision, "aborted"); } });
    assert.equal(applied.decision, "aborted"); assert.equal(await f.head(), f.input.oldSha);
  } finally { await f.close(); }
});
test("crash between target CAS and receipt seal is recovered from exact postcondition", async () => {
  const f = await fixture(); try {
    await prepareGitHubSync(f.root, f.input, signal());
    await assert.rejects(applyGitHubSync(f.root, f.input, signal(), { afterUpdate: async () => { throw new Error("simulated process loss"); } }), /simulated process loss/);
    assert.equal(await f.head(), f.input.newSha);
    assert.equal((await abortGitHubSync(f.root, f.input, signal())).decision, "applied");
  } finally { await f.close(); }
});
test("mismatched receipts, symbolic refs and symlinked repository paths fail closed", async () => {
  const f = await fixture(); try {
    await exec("git", ["update-ref", `refs/pi-collab/syncs/${f.input.syncId}`, f.input.oldSha], { cwd: f.target });
    await assert.rejects(abortGitHubSync(f.root, f.input, signal()), /github_sync_receipt_mismatch/);
    await exec("git", ["update-ref", "-d", `refs/pi-collab/syncs/${f.input.syncId}`], { cwd: f.target });
    await exec("git", ["symbolic-ref", "refs/heads/main", "refs/heads/other"], { cwd: f.target });
    await assert.rejects(prepareGitHubSync(f.root, f.input, signal()), /github_sync_symbolic_ref/);
    await symlink(path.join(f.root, "source.git"), path.join(f.target, "unexpected"));
    await assert.rejects(abortGitHubSync(f.root, f.input, signal()), /integration_code_unavailable/);
  } finally { await f.close(); }
});
