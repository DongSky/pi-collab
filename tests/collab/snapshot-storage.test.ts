import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, chmod, readdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createWorkspace } from "../../lib/collab/runtime/workspace";
import { captureSnapshot, restoreSnapshot, loadSnapshot, snapshotSummary, type SnapshotSource } from "../../lib/collab/runtime/snapshots";

const exec = promisify(execFile), root = await mkdtemp(path.join(tmpdir(), "pi-collab-snapshots-")), repo = path.join(root, "source");
before(async () => {
  await mkdir(repo);
  for (const args of [["init"], ["config", "user.name", "Snapshot test"], ["config", "user.email", "snapshot@test.invalid"]]) await exec("git", args, { cwd: repo });
  await writeFile(path.join(repo, "code.txt"), "baseline\n"); await writeFile(path.join(repo, "delete.txt"), "delete later\n");
  await exec("git", ["add", "."], { cwd: repo }); await exec("git", ["commit", "-m", "Initial"], { cwd: repo });
});
after(async () => { await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const workspace = await createWorkspace(root, randomUUID(), repo);
  const source: SnapshotSource = { id: randomUUID(), runId: randomUUID(), workspaceId: workspace.id, repositoryId: randomUUID(), baseSha: workspace.baseSha,
    note: "Continue with the remaining validation", context: { title: "Handoff", description: "Preserve code", acceptance: "Reproduce exact state", prompt: "Task instruction", status: "cancelled" } };
  return { workspace, source };
}

test("snapshots preserve local commits, staged/unstaged edits, binary untracked files, deletion and executable mode in a fresh clone", async () => {
  const { workspace, source } = await fixture();
  const git = (args: string[]) => exec("git", args, { cwd: workspace.checkout });
  await writeFile(path.join(workspace.checkout, "code.txt"), "local commit\n"); await git(["commit", "-am", "Agent commit"]);
  const sourceHead = (await git(["rev-parse", "HEAD"])).stdout.trim();
  await writeFile(path.join(workspace.checkout, "code.txt"), "staged\n"); await git(["add", "code.txt"]);
  await writeFile(path.join(workspace.checkout, "code.txt"), "working\n");
  await rm(path.join(workspace.checkout, "delete.txt"));
  await writeFile(path.join(workspace.checkout, "added.txt"), "staged addition\n"); await git(["add", "added.txt"]);
  const binary = Buffer.from([0, 1, 255, 20]); await writeFile(path.join(workspace.checkout, "untracked.bin"), binary);
  await writeFile(path.join(workspace.checkout, "script.sh"), "#!/bin/sh\nprintf hello\\n\n"); await chmod(path.join(workspace.checkout, "script.sh"), 0o755);
  const before = (await git(["status", "--porcelain=v1"])).stdout;
  const captured = await captureSnapshot(root, source); assert.equal(captured.manifest.sourceHead, sourceHead); assert.notEqual(captured.manifest.exportedHead, sourceHead);
  assert.equal((await git(["status", "--porcelain=v1"])).stdout, before);
  assert.ok(snapshotSummary(captured.manifest).changes.some(file => file.path === "untracked.bin" && file.untracked));
  const restored = await restoreSnapshot(root, randomUUID(), source.id, captured.manifestHash);
  assert.equal((await exec("git", ["status", "--porcelain=v1"], { cwd: restored.checkout })).stdout, before);
  assert.equal(await readFile(path.join(restored.checkout, "code.txt"), "utf8"), "working\n");
  assert.equal((await exec("git", ["show", ":code.txt"], { cwd: restored.checkout })).stdout, "staged\n");
  assert.equal((await exec("git", ["show", "HEAD:code.txt"], { cwd: restored.checkout })).stdout, "local commit\n");
  assert.deepEqual(await readFile(path.join(restored.checkout, "untracked.bin")), binary);
  assert.equal((await exec("git", ["remote"], { cwd: restored.checkout })).stdout, "");
  assert.deepEqual(await readdir(restored.agentDir), []); assert.deepEqual(await readdir(restored.home), []);
  await assert.rejects(restoreSnapshot(root, restored.id, source.id, captured.manifestHash), /EEXIST/);
  await writeFile(path.join(restored.checkout, "code.txt"), "new writer\n"); assert.equal(await readFile(path.join(workspace.checkout, "code.txt"), "utf8"), "working\n");
});

test("private paths, secret patterns in any Git layer, generated outputs, symlinks and large files never enter snapshot blobs", async () => {
  const { workspace, source } = await fixture();
  await writeFile(path.join(workspace.checkout, ".env"), "SECRET=value");
  await writeFile(path.join(workspace.checkout, "token.txt"), "sk-proj-" + "A".repeat(40));
  await exec("git", ["add", "token.txt"], { cwd: workspace.checkout });
  await writeFile(path.join(workspace.checkout, "token.txt"), "now harmless but index was sensitive");
  await writeFile(path.join(workspace.checkout, "large.bin"), Buffer.alloc(2 * 1024 * 1024 + 1, 1));
  await mkdir(path.join(workspace.checkout, "node_modules")); await writeFile(path.join(workspace.checkout, "node_modules", "dependency"), "ignored");
  await symlink(path.join(repo, "code.txt"), path.join(workspace.checkout, "outside"));
  await writeFile(path.join(workspace.agentDir, "models.json"), "old capability"); await writeFile(path.join(workspace.home, "private"), "old home");
  const captured = await captureSnapshot(root, source), reasons = new Set(captured.manifest.excluded.map(entry => entry.reason));
  for (const reason of ["private_path", "secret_pattern", "large_file", "generated", "symlink"] as const) assert.ok(reasons.has(reason));
  for (const layer of [captured.manifest.head, captured.manifest.index, captured.manifest.worktree]) assert.ok(layer.every(entry => ![".env", "token.txt", "large.bin", "outside"].includes(entry.path)));
  for (const bytes of captured.blobs.values()) assert.equal(bytes.includes(Buffer.from("sk-proj-")), false);
  const restored = await restoreSnapshot(root, randomUUID(), source.id, captured.manifestHash);
  await assert.rejects(readFile(path.join(restored.checkout, "token.txt")), /ENOENT/); assert.deepEqual(await readdir(restored.agentDir), []);
});

test("capture retries reuse a complete immutable artifact; corrupt manifests or blobs cannot be restored", async () => {
  const { workspace, source } = await fixture();
  const a = await captureSnapshot(root, source); await writeFile(path.join(workspace.checkout, "code.txt"), "later local change");
  const b = await captureSnapshot(root, source); assert.equal(a.manifestHash, b.manifestHash);
  await assert.rejects(captureSnapshot(root, { ...source, runId: randomUUID() }), /snapshot_invalid_artifact/);
  await assert.rejects(loadSnapshot(root, source.id, "a".repeat(64)), /snapshot_invalid_artifact/);
  const blob = a.manifest.worktree.find(entry => entry.path === "code.txt")!.hash;
  await writeFile(path.join(root, "snapshots", source.id, "blobs", blob), "tampered");
  await assert.rejects(restoreSnapshot(root, randomUUID(), source.id, a.manifestHash), /snapshot_invalid_artifact/);
});

test("source Git symlinks/alternates are rejected and unresolved index conflicts fail explicitly", async () => {
  const { workspace, source } = await fixture();
  await mkdir(path.join(workspace.checkout, ".git", "objects", "info"), { recursive: true });
  const alternate = path.join(workspace.checkout, ".git", "objects", "info", "alternates"); await writeFile(alternate, "/outside/objects\n");
  await assert.rejects(captureSnapshot(root, source), /snapshot_unsafe_git/); await rm(alternate);
  await symlink(repo, path.join(workspace.checkout, ".git", "unsafe")); await assert.rejects(captureSnapshot(root, source), /snapshot_unsafe_git/); await rm(path.join(workspace.checkout, ".git", "unsafe"));
  await exec("git", ["checkout", "-b", "other"], { cwd: workspace.checkout }); await writeFile(path.join(workspace.checkout, "code.txt"), "other\n"); await exec("git", ["commit", "-am", "Other"], { cwd: workspace.checkout });
  await exec("git", ["checkout", workspace.branch], { cwd: workspace.checkout }); await writeFile(path.join(workspace.checkout, "code.txt"), "ours\n"); await exec("git", ["commit", "-am", "Ours"], { cwd: workspace.checkout });
  await assert.rejects(exec("git", ["merge", "other"], { cwd: workspace.checkout }));
  await assert.rejects(captureSnapshot(root, source), /snapshot_unmerged_index/);
});

test("special Git index flags cannot silently change staging semantics during handoff", async () => {
  const { workspace, source } = await fixture();
  await writeFile(path.join(workspace.checkout, "intent.txt"), "not yet staged\n");
  await exec("git", ["add", "-N", "intent.txt"], { cwd: workspace.checkout });
  await assert.rejects(captureSnapshot(root, source), /snapshot_index_flags/);
  await exec("git", ["reset", "--", "intent.txt"], { cwd: workspace.checkout });
  await exec("git", ["update-index", "--assume-unchanged", "code.txt"], { cwd: workspace.checkout });
  await assert.rejects(captureSnapshot(root, source), /snapshot_index_flags/);
});

test("restoration preserves raw UTF-16 and line endings without applying Git working-tree conversion twice", async () => {
  const { workspace, source } = await fixture(), git = (args: string[]) => exec("git", args, { cwd: workspace.checkout });
  await writeFile(path.join(workspace.checkout, ".gitattributes"), "utf16.txt working-tree-encoding=UTF-16LE\ncode.txt text eol=crlf\n");
  await writeFile(path.join(workspace.checkout, "utf16.txt"), Buffer.from("committed\n", "utf16le")); await git(["add", "."]); await git(["commit", "-m", "Encoded source"]);
  await writeFile(path.join(workspace.checkout, "utf16.txt"), Buffer.from("staged\n", "utf16le")); await git(["add", "utf16.txt"]);
  const working = Buffer.from("working\r\n", "utf16le"); await writeFile(path.join(workspace.checkout, "utf16.txt"), working);
  await writeFile(path.join(workspace.checkout, "code.txt"), "raw LF despite project CRLF rule\n");
  const captured = await captureSnapshot(root, source), restored = await restoreSnapshot(root, randomUUID(), source.id, captured.manifestHash);
  assert.deepEqual(await readFile(path.join(restored.checkout, "utf16.txt")), working);
  assert.equal(await readFile(path.join(restored.checkout, "code.txt"), "utf8"), "raw LF despite project CRLF rule\n");
  assert.equal((await exec("git", ["show", ":utf16.txt"], { cwd: restored.checkout })).stdout, "staged\n");
  await assert.rejects(readFile(path.join(restored.checkout, ".git", "info", "attributes")), /ENOENT/);
});
