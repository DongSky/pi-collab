import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, chmod, rename, readdir } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import path from "node:path";
import { tmpdir } from "node:os";
import { createWorkspace, runnerEnvironment, type WorkspaceLocation } from "../../lib/collab/runtime/workspace";
import { NativeRuntimeBackend } from "../../lib/collab/runtime/backends";
import { beginNativeReceipt } from "../../lib/collab/runtime/receipts";
import { inspectWorkspaceGit, planWorkspaceStaging, planWorkspaceCommit, workspaceGitObjectId, type WorkspaceGitSource } from "../../lib/collab/runtime/workspace-git-view";

const root = await mkdtemp(path.join(tmpdir(), "pi-collab-workspace-git-")), sourceRepo = path.join(root, "source");
const original = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\r\n"); // Deliberately no trailing newline.
const changed = (base: string, changes: Record<number, string>) => base.split("\r\n").map((line, i) => changes[i + 1] ?? line).join("\r\n");
function git(cwd: string, args: string[], input?: Buffer | string) {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.autocrlf=false", ...args], { cwd, env: runnerEnvironment("/nonexistent", "/nonexistent"), stdio: "pipe" });
    const out: Buffer[] = []; let size = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
    child.stdout.on("data", (b: Buffer) => { size += b.length; if (size > 16 * 1024 * 1024) child.kill("SIGKILL"); else out.push(b); });
    child.stderr.resume(); child.stdin.on("error", () => {}); child.stdin.end(input);
    child.once("error", reject); child.once("close", code => { clearTimeout(timer); if (code !== 0) reject(new Error("fixture_git_failed")); else resolve(Buffer.concat(out)); });
  });
}
before(async () => {
  await mkdir(sourceRepo);
  for (const args of [["init", "-b", "main"], ["config", "user.name", "Workspace test"], ["config", "user.email", "test@pi-collab.invalid"]]) await git(sourceRepo, args);
  await writeFile(path.join(sourceRepo, "code.txt"), original); await writeFile(path.join(sourceRepo, "delete.txt"), "delete later\n");
  await writeFile(path.join(sourceRepo, ".env"), "baseline excluded\n");
  await git(sourceRepo, ["add", "."]); await git(sourceRepo, ["commit", "-m", "Initial"]);
});
after(async () => { await rm(root, { recursive: true, force: true }); });
async function fixture(receipt = true) {
  const workspace = await createWorkspace(root, randomUUID(), sourceRepo);
  const source: WorkspaceGitSource = { workspaceId: workspace.id, identity: { runId: randomUUID(), executorId: randomUUID(), epoch: "1" } };
  // Non-process tests explicitly create a stopped fixture receipt. The separate
  // Pi test below exercises actual launch, tool writing and group-exit evidence.
  if (receipt) await (await beginNativeReceipt(workspace, source.identity)).stopped();
  return { workspace, source, inspect: () => inspectWorkspaceGit(root, source), git: (args: string[], input?: Buffer | string) => git(workspace.checkout, args, input),
    write: (file: string, bytes: Buffer | string) => writeFile(path.join(workspace.checkout, file), bytes) };
}
const identity = () => ({ operationId: randomUUID(), actorId: randomUUID(), displayName: "确认成员", requestedAt: "2026-09-23T00:00:00.000Z", message: "Confirm selected code\n\nPreserve remaining draft." });
async function fingerprint(workspace: WorkspaceLocation) {
  const files: [string, string][] = [];
  const walk = async (dir: string, prefix = "") => {
    for (const name of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix + name.name, absolute = path.join(dir, name.name);
      if (name.isDirectory()) await walk(absolute, `${relative}/`);
      else if (name.isFile()) files.push([relative, (await readFile(absolute)).toString("base64")]);
    }
  };
  await walk(workspace.checkout); return files;
}
/** Git independently reconstructs the planned index/tree in a separate repo. */
async function verifyPlan(workspace: WorkspaceLocation, plan: Awaited<ReturnType<typeof planWorkspaceStaging>>) {
  const dir = await mkdtemp(path.join(root, "verify-")); await git(dir, ["init", "--object-format=sha1"]);
  for (const entry of plan.manifest.entries) {
    if (entry.mode === "160000") continue;
    const bytes = plan.blobs.get(entry.oid) ?? await git(workspace.checkout, ["cat-file", "blob", entry.oid]);
    assert.equal((await git(dir, ["hash-object", "-w", "--stdin"], bytes)).toString().trim(), entry.oid);
  }
  await git(dir, ["update-index", "-z", "--index-info"], plan.manifest.entries.map(entry => `${entry.mode} ${entry.oid}\t${entry.path}\0`).join(""));
  assert.equal((await git(dir, ["write-tree"])).toString().trim(), plan.manifest.afterTree);
  for (const [oid, bytes] of plan.trees) assert.deepEqual(await git(dir, ["cat-file", "tree", oid]), bytes);
  return dir;
}
function plannedBytes(plan: Awaited<ReturnType<typeof planWorkspaceStaging>>, file: string) { return plan.blobs.get(plan.manifest.entries.find(e => e.path === file)!.oid)!; }

test("real native Pi must exit before Git inspection; all three layers stay distinct and source bytes stay unchanged", async () => {
  const f = await fixture(false), agent = await new NativeRuntimeBackend().start(f.workspace, undefined, f.source.identity);
  try {
    await agent.peer.command("bash", { command: "printf 'staged by Pi\\n' > code.txt && git add code.txt && printf 'working by Pi\\n' > code.txt" });
    await assert.rejects(f.inspect(), /workspace_git_writer_not_exited/);
  } finally { await agent.stop(); }
  const before = await fingerprint(f.workspace), view = await f.inspect(), staged = await view.file("staged", "code.txt"), working = await view.file("working", "code.txt");
  assert.equal(staged.before!.text, original); assert.equal(staged.after!.text, "staged by Pi\n"); assert.equal(working.after!.text, "working by Pi\n");
  assert.deepEqual(view.summary().files, [{ path: "code.txt", staged: true, working: true, excluded: false }]);
  assert.equal(view.summary().branch, `refs/heads/${f.workspace.branch}`);
  assert.equal((await f.inspect()).revision, view.revision);
  await view.planStaging(view.revision, [{ path: "code.txt", direction: "stage", hunks: "file" }]);
  const commit = view.planCommit(view.revision, identity()); assert.equal(commit.manifest.tree, view.summary().indexTree);
  assert.deepEqual(await fingerprint(f.workspace), before);
});

test("selective stage retains existing index changes, CRLF, missing trailing newline and index mode", async () => {
  const f = await fixture(), stagedText = changed(original, { 3: "already staged" }), workingText = changed(stagedText, { 17: "select this", 36: "leave unstaged" });
  await f.write("code.txt", stagedText); await f.git(["add", "code.txt"]); await f.write("code.txt", workingText); await chmod(path.join(f.workspace.checkout, "code.txt"), 0o755);
  const before = await fingerprint(f.workspace), view = await f.inspect(), file = await view.file("working", "code.txt");
  assert.equal(file.hunks.length, 2); assert.equal(file.partial, true); assert.equal(file.after!.trailingNewline, false);
  const plan = await planWorkspaceStaging(root, f.source, view.revision, [{ path: "code.txt", direction: "stage", hunks: [file.hunks[0].id] }]);
  assert.equal(plannedBytes(plan, "code.txt").toString(), changed(stagedText, { 17: "select this" }));
  assert.equal(plan.manifest.entries.find(e => e.path === "code.txt")!.mode, "100644");
  await verifyPlan(f.workspace, plan); assert.deepEqual(await fingerprint(f.workspace), before);
  assert.equal((await planWorkspaceStaging(root, f.source, view.revision, [{ path: "code.txt", direction: "stage", hunks: [file.hunks[0].id] }])).planHash, plan.planHash);
});

test("selective unstage reverses only the selected HEAD/index hunk and never uses working bytes", async () => {
  const f = await fixture(), stagedText = changed(original, { 3: "unstage this", 36: "keep staged" });
  await f.write("code.txt", stagedText); await f.git(["add", "code.txt"]); await f.write("code.txt", "unrelated working draft\n");
  const view = await f.inspect(), file = await view.file("staged", "code.txt"); assert.equal(file.hunks.length, 2);
  const plan = await view.planStaging(view.revision, [{ path: "code.txt", direction: "unstage", hunks: [file.hunks[0].id] }]);
  assert.equal(plannedBytes(plan, "code.txt").toString(), changed(original, { 36: "keep staged" })); await verifyPlan(f.workspace, plan);
  assert.equal(await readFile(path.join(f.workspace.checkout, "code.txt"), "utf8"), "unrelated working draft\n");
});

test("full file selection supports binary, add/delete, executable mode and Git directory byte ordering", async () => {
  const f = await fixture(), binary = Buffer.from([0, 255, 128, 10]); await f.write("binary.dat", binary);
  await mkdir(path.join(f.workspace.checkout, "a")); await f.write("a/file", "nested\n"); await f.write("a.c", "sort before directory\n"); await f.write("a0", "sort after directory\n");
  await f.write("é.txt", "unicode name\n"); await f.write("unselected.txt", "keep draft\n");
  await rm(path.join(f.workspace.checkout, "delete.txt")); await chmod(path.join(f.workspace.checkout, "code.txt"), 0o755);
  const view = await f.inspect(), binaryView = await view.file("working", "binary.dat"); assert.equal(binaryView.partial, false); assert.equal(binaryView.after!.text, null);
  const plan = await view.planStaging(view.revision, ["binary.dat", "a/file", "a.c", "a0", "é.txt", "delete.txt", "code.txt"].map(file => ({ path: file, direction: "stage", hunks: "file" })));
  assert.deepEqual(plannedBytes(plan, "binary.dat"), binary); assert.ok(!plan.manifest.entries.some(e => ["unselected.txt", "delete.txt"].includes(e.path)));
  assert.equal(plan.manifest.entries.find(e => e.path === "code.txt")!.mode, "100755"); await verifyPlan(f.workspace, plan);
});

test("stale working files, exact index bytes, local commits and run identities invalidate confirmations", async () => {
  const f = await fixture(); await f.write("code.txt", "first view\n"); await f.git(["add", "code.txt"]);
  let view = await f.inspect(); await f.write("code.txt", "another browser's draft\n");
  await assert.rejects(planWorkspaceStaging(root, f.source, view.revision, [{ path: "code.txt", direction: "stage", hunks: "file" }]), /workspace_git_stale_revision/);
  await assert.rejects(planWorkspaceCommit(root, f.source, view.revision, identity()), /workspace_git_stale_revision/);
  view = await f.inspect(); await f.git(["update-index", "--index-version=4"]);
  const indexOnly = await f.inspect(); assert.equal(view.summary().indexTree, indexOnly.summary().indexTree); assert.notEqual(view.summary().indexHash, indexOnly.summary().indexHash);
  await assert.rejects(planWorkspaceCommit(root, f.source, view.revision, identity()), /workspace_git_stale_revision/);
  view = indexOnly; await f.git(["commit", "-m", "Local user commit"]);
  await assert.rejects(planWorkspaceCommit(root, f.source, view.revision, identity()), /workspace_git_stale_revision/);
  await assert.rejects(inspectWorkspaceGit(root, { ...f.source, identity: { ...f.source.identity, epoch: "2" } }), /workspace_git_writer_not_exited/);
});

test("forged, duplicated and cross-layer hunks are rejected; returned views cannot mutate evidence", async () => {
  const f = await fixture(); await f.write("code.txt", changed(original, { 3: "first" })); await f.git(["add", "code.txt"]); await f.write("code.txt", changed(original, { 3: "first", 36: "second" }));
  const view = await f.inspect(), staged = await view.file("staged", "code.txt"), working = await view.file("working", "code.txt");
  for (const hunks of [["0".repeat(64)], [staged.hunks[0].id], [working.hunks[0].id, working.hunks[0].id]]) await assert.rejects(view.planStaging(view.revision, [{ path: "code.txt", direction: "stage", hunks }]), /workspace_git_(stale_hunk|invalid_selection)/);
  await assert.rejects(view.planStaging(view.revision, Array.from({ length: 2 }, () => ({ path: "code.txt", direction: "stage", hunks: "file" as const }))), /workspace_git_duplicate_selection/);
  await assert.rejects(view.planStaging(view.revision, [{ path: "../code.txt", direction: "stage", hunks: "file" }]));
  working.after!.text = "tampered"; working.hunks[0].lines.length = 0; view.summary().files.length = 0;
  const plan = await view.planStaging(view.revision, [{ path: "code.txt", direction: "stage", hunks: "file" }]);
  plan.manifest.entries[0].oid = "0".repeat(40); plan.blobs.clear();
  assert.equal(plannedBytes(await view.planStaging(view.revision, [{ path: "code.txt", direction: "stage", hunks: "file" }]), "code.txt").toString(), changed(original, { 3: "first", 36: "second" }));
});

test("excluded staging blocks commits and can only be fully unstaged without disclosing secret contents", async () => {
  const f = await fixture(); await f.write("code.txt", "safe change\n"); await f.write(".env", "changed excluded\n");
  const secret = "sk-proj-" + "A".repeat(40); await f.write("token.txt", secret); await f.git(["add", "."]); await f.write("token.txt", "looks safe now\n");
  const view = await f.inspect(); assert.deepEqual(view.summary().commitBlockedPaths, [".env", "token.txt"]);
  assert.equal(JSON.stringify(view.summary()).includes(secret), false);
  for (const name of [".env", "token.txt"]) {
    await assert.rejects(view.file("staged", name), /workspace_git_excluded_path/);
    await assert.rejects(view.planStaging(view.revision, [{ path: name, direction: "stage", hunks: "file" }]), /workspace_git_excluded_path/);
  }
  assert.throws(() => view.planCommit(view.revision, identity()), /workspace_git_excluded_staged_changes/);
  const plan = await view.planStaging(view.revision, [".env", "token.txt"].map(name => ({ path: name, direction: "unstage", hunks: "file" })));
  assert.equal(plan.blobs.size, 0); assert.equal(plan.manifest.entries.some(e => e.path === "token.txt"), false);
  assert.equal(plan.manifest.entries.find(e => e.path === ".env")!.oid, (await f.git(["rev-parse", "HEAD:.env"])).toString().trim());
  assert.equal(JSON.stringify(plan.manifest).includes(secret), false); await verifyPlan(f.workspace, plan);
});

test("working symlinks, oversized files and excluded ancestors are never represented as safe deletion", async () => {
  const f = await fixture(); await f.git(["rm", "code.txt"]); await symlink(path.join(sourceRepo, "code.txt"), path.join(f.workspace.checkout, "code.txt"));
  await f.write("delete.txt", Buffer.alloc(2 * 1024 * 1024 + 1, 1));
  await mkdir(path.join(f.workspace.checkout, "folder")); await f.write("folder/file", "tracked nested\n"); await f.git(["add", "folder/file"]); await f.git(["commit", "-m", "Nested baseline"]);
  await rm(path.join(f.workspace.checkout, "folder"), { recursive: true }); await symlink(sourceRepo, path.join(f.workspace.checkout, "folder"));
  const view = await f.inspect();
  assert.ok(!view.summary().files.some(e => !e.excluded && ["code.txt", "delete.txt", "folder/file"].includes(e.path)));
  for (const name of ["code.txt", "delete.txt", "folder/file"]) await assert.rejects(view.file("working", name), /workspace_git_excluded_path/);
});

test("writer receipts, Git locks, unexpected branches and in-progress operations fail closed without deleting locks", async () => {
  const f = await fixture(false); await assert.rejects(f.inspect(), /workspace_git_writer_not_exited/);
  const receipt = await beginNativeReceipt(f.workspace, f.source.identity); await assert.rejects(f.inspect(), /workspace_git_writer_not_exited/); await receipt.stopped();
  for (const name of ["index.lock", "HEAD.lock", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REBASE_HEAD", `refs/heads/task/${f.workspace.id}.lock`, "commondir"]) {
    const file = path.join(f.workspace.checkout, ".git", name); await writeFile(file, "another owner\n");
    await assert.rejects(f.inspect(), /workspace_git_busy/); assert.equal(await readFile(file, "utf8"), "another owner\n"); await rm(file);
  }
  await f.git(["checkout", "--detach"]); await assert.rejects(f.inspect(), /workspace_git_unexpected_branch/);
  await f.git(["checkout", f.workspace.branch]); await f.git(["pack-refs", "--all", "--prune"]); await f.inspect();
  await f.git(["symbolic-ref", `refs/heads/${f.workspace.branch}`, "refs/heads/main"]); await assert.rejects(f.inspect(), /workspace_git_unexpected_branch/);
  await rm(path.join(f.workspace.checkout, ".git", "refs", "heads", f.workspace.branch));
  await f.git(["update-index", "--skip-worktree", "code.txt"]); await assert.rejects(f.inspect(), /snapshot_index_flags/);
});

test("independent object hashing rejects plausible corrupt blobs/commits and unsafe Git metadata", async () => {
  const f = await fixture(); await f.write("code.txt", "local loose object\n"); await f.git(["add", "code.txt"]); await f.git(["commit", "-m", "Loose object"]);
  const id = (await f.git(["rev-parse", "HEAD:code.txt"])).toString().trim(), file = path.join(f.workspace.checkout, ".git/objects", id.slice(0, 2), id.slice(2)), saved = await readFile(file);
  const bytes = Buffer.from("plausible wrong content\n"); await chmod(file, 0o600); await writeFile(file, deflateSync(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])));
  await assert.rejects(f.inspect(), /workspace_git_invalid_objects/); await writeFile(file, saved);
  const head = (await f.git(["rev-parse", "HEAD"])).toString().trim(), headFile = path.join(f.workspace.checkout, ".git/objects", head.slice(0, 2), head.slice(2)), savedHead = await readFile(headFile);
  const commit = await f.git(["cat-file", "commit", head]), badCommit = Buffer.from(commit.toString().replace("Loose object", "Fake object!"));
  await chmod(headFile, 0o600); await writeFile(headFile, deflateSync(Buffer.concat([Buffer.from(`commit ${badCommit.length}\0`), badCommit])));
  await assert.rejects(f.inspect(), /integration_code_unavailable|snapshot_git_failed/); await writeFile(headFile, savedHead);
  await symlink(sourceRepo, path.join(f.workspace.checkout, ".git/unsafe")); await assert.rejects(f.inspect(), /integration_code_unavailable/); await rm(path.join(f.workspace.checkout, ".git/unsafe"));
  await writeFile(path.join(f.workspace.checkout, ".git/objects/info/alternates"), sourceRepo); await assert.rejects(f.inspect(), /integration_code_unavailable/);
});

test("deterministic commit plans bind member, operation, run, exact index and message without signatures or source writes", async () => {
  const f = await fixture(); const empty = await f.inspect(); assert.throws(() => empty.planCommit(empty.revision, identity()), /workspace_git_empty_commit/);
  await f.write("code.txt", "commit this\n"); await f.git(["add", "code.txt"]); await f.write("code.txt", "keep this unstaged\n");
  const before = await fingerprint(f.workspace), view = await f.inspect(), who = identity(), plan = await planWorkspaceCommit(root, f.source, view.revision, who);
  const second = view.planCommit(view.revision, who); assert.equal(plan.manifest.commit, second.manifest.commit); assert.deepEqual(plan.bytes, second.bytes);
  assert.equal(plan.manifest.tree, view.summary().indexTree); assert.equal(plan.manifest.signed, false);
  assert.ok(plan.bytes.toString().includes(`pi-collab-run ${f.source.identity.runId}\n`)); assert.ok(plan.bytes.toString().endsWith(`${who.message}\n`));
  assert.equal(plan.bytes.includes(Buffer.from("gpgsig")), false); assert.notEqual(view.planCommit(view.revision, { ...who, actorId: randomUUID() }).manifest.commit, plan.manifest.commit);
  assert.notEqual(view.planCommit(view.revision, { ...who, operationId: randomUUID() }).manifest.commit, plan.manifest.commit);
  for (const displayName of ["Forged\nauthor Fake", "Fake <fake@example.com>", "\u202eevil"]) assert.throws(() => view.planCommit(view.revision, { ...who, displayName }));
  assert.equal(workspaceGitObjectId("commit", plan.bytes), plan.manifest.commit); assert.deepEqual(await fingerprint(f.workspace), before);
  second.manifest.source.identity.runId = randomUUID(); second.bytes.fill(0);
  assert.equal(view.planCommit(view.revision, who).manifest.commit, plan.manifest.commit);
  // Git parses the exact prepared object, in an independent object database.
  const dir = await mkdtemp(path.join(root, "commit-")); await git(dir, ["init", "--bare"]);
  assert.equal((await git(dir, ["hash-object", "-t", "commit", "-w", "--stdin"], plan.bytes)).toString().trim(), plan.manifest.commit);
  assert.deepEqual(await git(dir, ["cat-file", "commit", plan.manifest.commit]), plan.bytes);
});

test("raw-byte staging does not execute project filters/diff drivers and preserves UTF-16 bytes", async () => {
  const f = await fixture(), marker = path.join(root, `filter-${randomUUID()}`), encoded = Buffer.from("working utf16\r\n", "utf16le");
  await f.git(["config", "filter.danger.clean", `touch '${marker}'`]); await f.git(["config", "diff.danger.command", `touch '${marker}'`]);
  await f.write(".gitattributes", "code.txt filter=danger diff=danger\nutf16.txt working-tree-encoding=UTF-16LE\n");
  await f.write("code.txt", "raw text\r\n"); await f.write("utf16.txt", encoded);
  const view = await f.inspect(), file = await view.file("working", "code.txt"); assert.equal(file.after!.text, "raw text\r\n");
  assert.equal((await view.file("working", "utf16.txt")).partial, false);
  const plan = await view.planStaging(view.revision, ["code.txt", "utf16.txt"].map(name => ({ path: name, direction: "stage", hunks: "file" })));
  assert.deepEqual(plannedBytes(plan, "utf16.txt"), encoded); assert.equal(plannedBytes(plan, "code.txt").toString(), "raw text\r\n");
  await assert.rejects(readFile(marker), /ENOENT/); await verifyPlan(f.workspace, plan);
});

test("file/directory transitions require a complete non-colliding selection", async () => {
  const f = await fixture(); await rename(path.join(f.workspace.checkout, "code.txt"), path.join(f.workspace.checkout, "moved.txt"));
  await mkdir(path.join(f.workspace.checkout, "code.txt")); await f.write("code.txt/nested", "replacement\n");
  const view = await f.inspect();
  await assert.rejects(view.planStaging(view.revision, [{ path: "code.txt/nested", direction: "stage", hunks: "file" }]), /workspace_git_path_collision/);
  const plan = await view.planStaging(view.revision, ["code.txt", "code.txt/nested", "moved.txt"].map(name => ({ path: name, direction: "stage", hunks: "file" })));
  assert.ok(!plan.manifest.entries.some(e => e.path === "code.txt")); await verifyPlan(f.workspace, plan);
});

test("hunk ranges preserve insert/delete offsets, end-of-file changes and empty existing files", async () => {
  const f = await fixture(), lines = original.split("\r\n"), modified = ["new start", ...lines.slice(0, 15), ...lines.slice(17), "new end\r\n"].join("\r\n");
  await f.write("code.txt", modified);
  const view = await f.inspect(), diff = await view.file("working", "code.txt"); assert.equal(diff.hunks.length, 3);
  for (const indices of [[0], [1], [2], [0, 2], [0, 1, 2]]) {
    const expected = [ ...(indices.includes(0) ? ["new start"] : []), ...lines.slice(0, 15), ...(indices.includes(1) ? [] : lines.slice(15, 17)), ...lines.slice(17), ...(indices.includes(2) ? ["new end\r\n"] : []) ].join("\r\n");
    const plan = await view.planStaging(view.revision, [{ path: "code.txt", direction: "stage", hunks: indices.map(i => diff.hunks[i].id) }]);
    assert.equal(plannedBytes(plan, "code.txt").toString(), expected); await verifyPlan(f.workspace, plan);
  }
  await f.git(["add", "code.txt"]); const staged = await f.inspect(), back = await staged.file("staged", "code.txt");
  const reverse = await staged.planStaging(staged.revision, [{ path: "code.txt", direction: "unstage", hunks: back.hunks.map(h => h.id) }]);
  assert.equal(plannedBytes(reverse, "code.txt").toString(), original);
  await f.write("empty.txt", ""); await f.git(["add", "empty.txt"]); await f.git(["commit", "-m", "Empty baseline"]); await f.write("empty.txt", "one line without newline");
  let emptyView = await f.inspect(), emptyDiff = await emptyView.file("working", "empty.txt"); assert.equal(emptyDiff.partial, true); assert.equal(emptyDiff.hunks[0].beforeCount, 0);
  let emptyPlan = await emptyView.planStaging(emptyView.revision, [{ path: "empty.txt", direction: "stage", hunks: [emptyDiff.hunks[0].id] }]);
  assert.equal(plannedBytes(emptyPlan, "empty.txt").toString(), "one line without newline"); await verifyPlan(f.workspace, emptyPlan);
  await f.git(["add", "empty.txt"]); await f.write("empty.txt", ""); emptyView = await f.inspect(); emptyDiff = await emptyView.file("working", "empty.txt");
  assert.equal(emptyDiff.hunks[0].afterCount, 0);
  emptyPlan = await emptyView.planStaging(emptyView.revision, [{ path: "empty.txt", direction: "stage", hunks: [emptyDiff.hunks[0].id] }]);
  assert.equal(plannedBytes(emptyPlan, "empty.txt").length, 0); await verifyPlan(f.workspace, emptyPlan);
});
