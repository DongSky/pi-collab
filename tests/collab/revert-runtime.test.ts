import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createWorkspace } from "../../lib/collab/runtime/workspace";
import { prepareRevert } from "../../lib/collab/runtime/revert";
const exec = promisify(execFile);
for (const conflict of [false, true]) test(`managed inverse preserves later history and ${conflict ? "exposes conflicts" : "creates a fresh revert commit"}`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-collab-revert-"));
  const git = async (...args: string[]) => (await exec("git", args, { cwd: root })).stdout.trim();
  try {
    await git("init", "-b", "main"); await git("config", "user.name", "Fixture"); await git("config", "user.email", "fixture@test.invalid");
    await writeFile(path.join(root, "shared.txt"), "before\n"); await git("add", "."); await git("commit", "-m", "before"); const oldSha = await git("rev-parse", "HEAD");
    await writeFile(path.join(root, "shared.txt"), "promoted\n"); await git("add", "."); await git("commit", "-m", "actual changes");
    await git("commit", "--allow-empty", "-m", "promotion provenance"); const newSha = await git("rev-parse", "HEAD");
    await writeFile(path.join(root, "later.txt"), "keep later work\n"); if (conflict) await writeFile(path.join(root, "shared.txt"), "later edit\n");
    await git("add", "."); await git("commit", "-m", "later work"); const targetSha = await git("rev-parse", "HEAD");
    const w = await createWorkspace(root, randomUUID(), root, targetSha, true);
    const result = await prepareRevert(w, { version: 1, taskId: randomUUID(), repositoryId: randomUUID(), promotionId: randomUUID(), oldSha, newSha, targetSha }, AbortSignal.timeout(30000));
    assert.equal(result.requiresResolution, conflict); assert.notEqual(result.commit, targetSha); assert.notEqual(result.commit, oldSha);
    assert.equal(await readFile(path.join(w.checkout, "later.txt"), "utf8"), "keep later work\n");
    const content = await readFile(path.join(w.checkout, "shared.txt"), "utf8"); if (conflict) assert.match(content, /<<<<<<<[\s\S]*later edit[\s\S]*before/); else assert.equal(content, "before\n");
    assert.equal(await git("rev-parse", "main"), targetSha);
    assert.equal((await exec("git", ["rev-parse", "HEAD^"], { cwd: w.checkout })).stdout.trim(), targetSha);
    assert.match(await readFile(path.join(w.root, "revert.json"), "utf8"), /preparedCommit/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
