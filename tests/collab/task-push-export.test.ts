import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, chmod, readdir, rename } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { managedGit } from "../../lib/collab/git/github-pack";
import { createWorkspace } from "../../lib/collab/runtime/workspace";
import { beginNativeReceipt } from "../../lib/collab/runtime/receipts";
import { NativeRuntimeBackend } from "../../lib/collab/runtime/backends";
import { inspectWorkspaceGit, type WorkspaceGitSource } from "../../lib/collab/runtime/workspace-git-view";
import { exportTaskPush, verifyTaskPushExport, prepareExportedTaskPush, taskPushExportInput, type TaskPushExportInput } from "../../lib/collab/git/task-push-export";
import { taskPushRef } from "../../lib/collab/git/task-push-protocol";
import { taskPushFixture } from "./fixtures/task-push";

const root = await mkdtemp(path.join(tmpdir(), "pi-collab-task-export-")), repositoryId = randomUUID(), sourceRepo = path.join(root, "source");
const baselineRepo = path.join(root, "repositories", repositoryId, "git"), remote = path.join(root, "source.git");
let baseSha = "";
const deadline = () => AbortSignal.timeout(60000);
const git = async (directory: string, args: string[], input?: Buffer | string) => (await managedGit(directory, args, deadline(), { input })).bytes.toString("utf8").trim();
before(async () => {
  await managedGit(root, ["init", "--template=", "-b", "main", "source"], deadline());
  await git(sourceRepo, ["config", "user.name", "Export fixture"]); await git(sourceRepo, ["config", "user.email", "export@test.invalid"]);
  await writeFile(path.join(sourceRepo, "code.txt"), "baseline\r\n"); await writeFile(path.join(sourceRepo, ".env"), "KNOWN_REMOTE_PLACEHOLDER=yes\n");
  await git(sourceRepo, ["add", "."]); await git(sourceRepo, ["commit", "-m", "Known remote base"]);
  baseSha = await git(sourceRepo, ["rev-parse", "HEAD"]); await mkdir(path.dirname(baselineRepo), { recursive: true });
  for (const target of [baselineRepo, remote]) await git(root, ["-c", "protocol.file.allow=always", "clone", "--bare", "--no-local", "--template=", sourceRepo, target]);
});
after(async () => { await rm(root, { recursive: true, force: true }); });
async function fixture(receipt = true) {
  const workspace = await createWorkspace(root, randomUUID(), baselineRepo, baseSha);
  const source: WorkspaceGitSource = { workspaceId: workspace.id, identity: { runId: randomUUID(), executorId: randomUUID(), epoch: "1" } };
  // Most cases use an explicit stopped protocol fixture; the Pi case below
  // verifies actual child launch, tool commits and positive process-group exit.
  if (receipt) await (await beginNativeReceipt(workspace, source.identity)).stopped();
  const runGit = (args: string[], input?: Buffer | string) => git(workspace.checkout, args, input);
  return { workspace, source, git: runGit,
    write: (file: string, bytes: Buffer | string) => writeFile(path.join(workspace.checkout, file), bytes),
    commit: async (message = "Task change") => { await runGit(["add", "."]); await runGit(["commit", "--allow-empty", "-m", message]); return runGit(["rev-parse", "HEAD"]); },
    input: async (): Promise<TaskPushExportInput> => {
      const view = await inspectWorkspaceGit(root, source);
      return { version: 1, exportId: randomUUID(), source, revision: view.revision,
        intent: { operationId: randomUUID(), repositoryId, taskId: randomUUID(), workspaceId: workspace.id, expectedOld: null, newSha: view.summary().head },
        remoteBaseline: { sha: baseSha, observationHash: createHash("sha256").update(`fixture-provider-observation:${repositoryId}:${baseSha}`).digest("hex") } };
    } };
}
const exportDir = (id: string) => path.join(root, "task-push-exports", id);
async function fingerprint(directory: string) {
  const rows: string[] = [];
  const walk = async (dir: string) => { for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(file);
    else if (entry.isFile()) rows.push(`${path.relative(directory, file)}:${createHash("sha256").update(await readFile(file)).digest("hex")}`);
  } }; await walk(directory); return rows;
}

test("actual native Pi commit exports unchanged history, mode/CRLF/binary bytes, leaves drafts and source intact, then pushes the original SHA", async () => {
  const f = await fixture(false), agent = await new NativeRuntimeBackend().start(f.workspace, undefined, f.source.identity);
  try {
    await agent.peer.command("bash", { command: "printf 'committed by Pi\\r\\n' > code.txt; printf '\\000\\001\\377' > binary.dat; chmod +x code.txt; git add code.txt binary.dat; git commit -m 'Pi code'; printf 'uncommitted draft\\n' > code.txt" });
    await assert.rejects(inspectWorkspaceGit(root, f.source), /writer_not_exited/);
  } finally { await agent.stop(); }
  const input = await f.input(), before = await fingerprint(f.workspace.checkout), result = await exportTaskPush(root, input);
  const checked = await verifyTaskPushExport(root, input.exportId, result.manifestHash);
  assert.equal(checked.manifest.commits.length, 1); assert.equal(checked.manifest.commits[0].oid, input.intent.newSha);
  assert.deepEqual(await fingerprint(f.workspace.checkout), before);
  assert.equal(await git(checked.directory, ["rev-parse", "HEAD"]), input.intent.newSha);
  assert.equal(await git(checked.directory, ["rev-parse", "HEAD^", "HEAD^{tree}"]), await f.git(["rev-parse", "HEAD^", "HEAD^{tree}"]));
  assert.equal(await git(checked.directory, ["remote"]), "");
  assert.equal(await git(checked.directory, ["show", "HEAD:.env"]), "KNOWN_REMOTE_PLACEHOLDER=yes");
  const http = await taskPushFixture(root);
  try {
    const push = await prepareExportedTaskPush(root, input.exportId, result.manifestHash);
    assert.equal((await push.execute(http.transport, async () => true, deadline())).status, "acknowledged");
    const ref = taskPushRef({ taskId: input.intent.taskId, workspaceId: input.source.workspaceId });
    assert.equal(await git(remote, ["rev-parse", ref]), input.intent.newSha); assert.equal(await git(remote, ["rev-parse", "main"]), baseSha);
    assert.deepEqual((await managedGit(remote, ["show", `${ref}:binary.dat`], deadline())).bytes, Buffer.from([0, 1, 255]));
    assert.deepEqual((await managedGit(remote, ["show", `${ref}:code.txt`], deadline())).bytes, Buffer.from("committed by Pi\r\n"));
    assert.match(await git(remote, ["ls-tree", ref, "code.txt"]), /^100755 /);
  } finally { await http.close(); }
});

test("a secret-bearing intermediate commit remains blocked after the final file was replaced or deleted", async () => {
  for (const ending of ["replace", "delete"]) {
    const f = await fixture(); await f.write("settings.txt", `access_token = "${"q".repeat(24)}"\n`); await f.commit("temporary settings");
    if (ending === "replace") await f.write("settings.txt", "safe final content\n"); else await rm(path.join(f.workspace.checkout, "settings.txt"));
    await f.commit("remove temporary value"); const input = await f.input();
    await assert.rejects(exportTaskPush(root, input), /task_push_export_secret_content/);
    await assert.rejects(readFile(path.join(exportDir(input.exportId), "manifest.json")), { code: "ENOENT" });
  }
});

test("new or edited excluded paths in intermediate commits block export; inherited known refs and explicit deletion are preserved", async () => {
  for (const file of [".env", "auth.json", "generated.key"]) {
    const f = await fixture(); await f.write(file, "excluded intermediate content\n"); await f.commit();
    if (file === ".env") await f.write(file, "KNOWN_REMOTE_PLACEHOLDER=yes\n"); else await rm(path.join(f.workspace.checkout, file));
    await f.commit(); await assert.rejects(exportTaskPush(root, await f.input()), /excluded_history/);
  }
  const removed = await fixture(); await rm(path.join(removed.workspace.checkout, ".env")); await removed.commit("explicitly remove known file");
  const input = await removed.input(), output = await exportTaskPush(root, input);
  const checked = await verifyTaskPushExport(root, input.exportId, output.manifestHash);
  assert.equal(await git(checked.directory, ["ls-tree", "HEAD", ".env"]), "");
});

test("commit messages and UTF-16 content are scanned, including a value hidden by a later safe commit", async () => {
  const message = await fixture(); await message.write("safe.txt", "safe\n"); await message.commit(`Bearer ${"z".repeat(25)}`);
  await assert.rejects(exportTaskPush(root, await message.input()), /secret_commit/);
  for (const bigEndian of [false, true]) {
    const f = await fixture(), bytes = Buffer.from(`password = "${"x".repeat(20)}"\n`, "utf16le");
    await f.write("utf16.txt", bigEndian ? bytes.swap16() : bytes); await f.commit(); await f.write("utf16.txt", "safe\n"); await f.commit();
    await assert.rejects(exportTaskPush(root, await f.input()), /secret_content/);
  }
});

test("all parents of merges are checked and unrelated roots cannot be hidden behind a safe final tree", async () => {
  const f = await fixture(); await f.write("main.txt", "main line\n"); const main = await f.commit();
  await f.git(["checkout", "-b", "side", baseSha]); await f.write("side.txt", "parallel side\n"); const side = await f.commit();
  await f.git(["checkout", f.workspace.branch]); await f.git(["merge", "--no-ff", "-m", "Join task history", side]);
  const input = await f.input(), output = await exportTaskPush(root, input);
  assert.equal(output.manifest.commits.length, 3); assert.deepEqual(new Set(output.manifest.commits[0].parents), new Set([main, side]));
  const bad = await fixture(), tree = await bad.git(["rev-parse", "HEAD^{tree}"]);
  const orphan = await bad.git(["commit-tree", tree], "unrelated root\n");
  const merge = await bad.git(["commit-tree", tree, "-p", baseSha, "-p", orphan], "hide unrelated history\n");
  await bad.git(["reset", "--hard", merge]); await assert.rejects(exportTaskPush(root, await bad.input()), /unrelated_history/);
});

test("a secret on a merged side branch is checked even when the merge tree excludes that side's file", async () => {
  const f = await fixture(); await f.write("secret.txt", `api_key = "${"h".repeat(24)}"\n`); const side = await f.commit();
  const baseTree = await f.git(["rev-parse", `${baseSha}^{tree}`]);
  const merge = await f.git(["commit-tree", baseTree, "-p", baseSha, "-p", side], "clean-looking merge\n");
  await f.git(["reset", "--hard", merge]); await assert.rejects(exportTaskPush(root, await f.input()), /secret_content/);
});

test("new symlinks, submodule references, generated directories and oversized historical files are rejected", async () => {
  for (const mode of ["symlink", "submodule", "generated", "large"]) {
    const f = await fixture();
    if (mode === "symlink") await symlink("code.txt", path.join(f.workspace.checkout, "linked"));
    else if (mode === "submodule") await f.git(["update-index", "--add", "--cacheinfo", `160000,${baseSha},submodule`]);
    else if (mode === "generated") { await mkdir(path.join(f.workspace.checkout, "dist")); await f.write("dist/code.txt", "built output\n"); }
    else await f.write("large.dat", Buffer.alloc(2 * 1024 * 1024 + 1, 65));
    if (mode === "submodule") await f.git(["commit", "-m", "submodule entry"]); else await f.commit();
    const tree = await f.git(["rev-parse", `${baseSha}^{tree}`]), bad = await f.git(["rev-parse", "HEAD"]);
    const clean = await f.git(["commit-tree", tree, "-p", bad], "restore final tree\n"); await f.git(["reset", "--hard", clean]);
    await assert.rejects(exportTaskPush(root, await f.input()), mode === "large" ? /large_or_invalid_file/ : /excluded_history/);
  }
});

test("stale revision, changed HEAD, missing exit evidence, invalid scope and cancellation cannot publish an export", async () => {
  const f = await fixture(); await f.write("code.txt", "change\n"); await f.commit(); const input = await f.input();
  await f.write("code.txt", "later draft\n"); await assert.rejects(exportTaskPush(root, input), /source_changed/);
  await f.commit(); await assert.rejects(exportTaskPush(root, { ...input, revision: (await f.input()).revision }), /source_changed/);
  assert.equal(taskPushExportInput.safeParse({ ...input, source: { ...input.source, workspaceId: randomUUID() } }).success, false);
  const stopped = await f.input(); await rm(path.join(root, "runtime-receipts", `${f.workspace.id}.json`));
  await assert.rejects(exportTaskPush(root, stopped), /writer_not_exited/);
  const cancelled = await fixture(); await cancelled.commit(); const valid = await cancelled.input();
  await assert.rejects(exportTaskPush(root, valid, AbortSignal.abort()));
  await assert.rejects(readFile(path.join(exportDir(valid.exportId), "manifest.json")), { code: "ENOENT" });
});

test("immutable exported input survives subsequent workspace edits; another export requires new confirmation and IDs cannot be reused", async () => {
  const f = await fixture(); await f.write("code.txt", "confirmed\n"); await f.commit(); const input = await f.input();
  const result = await exportTaskPush(root, input); await f.write("code.txt", "new workspace draft\n"); await f.commit();
  const checked = await verifyTaskPushExport(root, input.exportId, result.manifestHash);
  assert.equal(await git(checked.directory, ["show", "HEAD:code.txt"]), "confirmed");
  await assert.rejects(exportTaskPush(root, input), /source_changed/);
  const next = { ...await f.input(), exportId: input.exportId }; await assert.rejects(exportTaskPush(root, next), { code: "EEXIST" });
  assert.equal((await verifyTaskPushExport(root, input.exportId, result.manifestHash)).manifest.input.intent.newSha, input.intent.newSha);
});

test("manifest, exported object/ref and base pack corruption are refused rather than repaired from the mutable workspace", async () => {
  for (const mode of ["manifest", "object", "ref", "pack"]) {
    const f = await fixture(); await f.write("code.txt", "checked content\n"); await f.commit(); const input = await f.input(), result = await exportTaskPush(root, input);
    const repo = path.join(exportDir(input.exportId), "git");
    if (mode === "manifest") await writeFile(path.join(exportDir(input.exportId), "manifest.json"), "{}");
    else if (mode === "ref") await git(repo, ["update-ref", result.manifest.ref, baseSha]);
    else if (mode === "pack") {
      const file = path.join(repo, "objects/pack", `pack-${result.manifest.basePack.id}.pack`), bytes = await readFile(file); bytes[15] ^= 127; await chmod(file, 0o600); await writeFile(file, bytes);
    } else {
      const entry = result.manifest.objects.find(item => item.type === "blob")!;
      await writeFile(path.join(repo, "objects", entry.oid.slice(0, 2), entry.oid.slice(2)), deflateSync(Buffer.from("blob 7\0changed")));
    }
    await assert.rejects(verifyTaskPushExport(root, input.exportId, result.manifestHash));
    await assert.rejects(prepareExportedTaskPush(root, input.exportId, result.manifestHash));
  }
});

test("grafts, alternates, symbolic artifact directories and forged baseline objects cannot bypass the history boundary", async () => {
  const f = await fixture(); await f.commit(); const input = await f.input(), meta = path.join(f.workspace.checkout, ".git");
  const graft = path.join(meta, "info/grafts"); await mkdir(path.dirname(graft), { recursive: true }); await writeFile(graft, `${input.intent.newSha} ${baseSha}\n`);
  await assert.rejects(exportTaskPush(root, input), /unsafe_metadata/); await rm(graft);
  const alt = path.join(meta, "objects/info/alternates"); await mkdir(path.dirname(alt), { recursive: true }); await writeFile(alt, path.join(baselineRepo, "objects"));
  await assert.rejects(exportTaskPush(root, input)); await rm(alt);
  const foreign = { ...input, remoteBaseline: { ...input.remoteBaseline, sha: input.intent.newSha } };
  await assert.rejects(exportTaskPush(root, foreign));
  const good = await exportTaskPush(root, input); const moved = `${exportDir(input.exportId)}-saved`;
  await rename(exportDir(input.exportId), moved); await symlink(moved, exportDir(input.exportId));
  await assert.rejects(verifyTaskPushExport(root, input.exportId, good.manifestHash));
});

test("a corrupt intermediate commit cannot hide its original tree behind a clean final HEAD", async () => {
  const f = await fixture(); await f.write("secret.txt", `access_token = "${"n".repeat(24)}"\n`); const earlier = await f.commit("intermediate");
  await rm(path.join(f.workspace.checkout, "secret.txt")); await f.commit("clean final tree");
  const old = (await managedGit(f.workspace.checkout, ["cat-file", "commit", earlier], deadline())).bytes;
  const baseTree = await f.git(["rev-parse", `${baseSha}^{tree}`]);
  const changed = Buffer.concat([Buffer.from(`tree ${baseTree}\n`), old.subarray(46)]);
  const file = path.join(f.workspace.checkout, ".git/objects", earlier.slice(0, 2), earlier.slice(2)); await chmod(file, 0o600);
  await writeFile(file, deflateSync(Buffer.concat([Buffer.from(`commit ${changed.length}\0`), changed])));
  const input = await f.input(); await assert.rejects(exportTaskPush(root, input), /integration_code_unavailable|github_git_failed/);
  await assert.rejects(readFile(path.join(exportDir(input.exportId), "manifest.json")), { code: "ENOENT" });
});

test("export never runs source clean/smudge filters, textconv or hooks", async () => {
  const f = await fixture(); await f.write(".gitattributes", "*.txt filter=probe diff=probe\n"); await f.write("code.txt", "raw committed bytes\r\n"); await f.commit();
  for (const [key, value] of [["filter.probe.clean", "touch should-not-exist"], ["filter.probe.smudge", "touch should-not-exist"], ["diff.probe.textconv", "touch should-not-exist"], ["core.hooksPath", ".hooks"]]) await f.git(["config", key, value]);
  await mkdir(path.join(f.workspace.checkout, ".hooks")); await f.write(".hooks/pre-push", "#!/bin/sh\ntouch should-not-exist\n"); await chmod(path.join(f.workspace.checkout, ".hooks/pre-push"), 0o700);
  const input = await f.input(), output = await exportTaskPush(root, input), result = await verifyTaskPushExport(root, input.exportId, output.manifestHash);
  assert.deepEqual((await managedGit(result.directory, ["show", "HEAD:code.txt"], deadline())).bytes, Buffer.from("raw committed bytes\r\n"));
  await assert.rejects(readFile(path.join(f.workspace.checkout, "should-not-exist")), { code: "ENOENT" });
});

test("already remote legacy commit encodings are preserved while new UTF-8 history is checked", async () => {
  const f = await fixture(), tree = await f.git(["rev-parse", "HEAD^{tree}"]);
  const bytes = Buffer.concat([Buffer.from(`tree ${tree}\nparent ${baseSha}\nauthor Legacy <legacy@test.invalid> 1700000000 +0000\ncommitter Legacy <legacy@test.invalid> 1700000000 +0000\nencoding ISO-8859-1\n\n`), Buffer.from([0x63, 0x61, 0x66, 0xe9, 10])]);
  const known = await f.git(["hash-object", "-t", "commit", "-w", "--stdin"], bytes); await f.git(["reset", "--hard", known]);
  const otherRepoId = randomUUID(), otherRepo = path.join(root, "repositories", otherRepoId, "git"); await mkdir(path.dirname(otherRepo), { recursive: true });
  await git(root, ["-c", "protocol.file.allow=always", "clone", "--bare", "--no-local", "--template=", f.workspace.checkout, otherRepo]);
  await f.write("code.txt", "new UTF-8 commit\n"); await f.commit(); const input = await f.input();
  input.intent.repositoryId = otherRepoId; input.remoteBaseline = { sha: known, observationHash: createHash("sha256").update(`fixture:${known}`).digest("hex") };
  const output = await exportTaskPush(root, input), result = await verifyTaskPushExport(root, input.exportId, output.manifestHash);
  assert.equal(output.manifest.commits.length, 1);
  assert.deepEqual((await managedGit(result.directory, ["cat-file", "commit", known], deadline())).bytes, bytes);
});

test("oversized commit graphs stop before export publication rather than silently truncating history", async () => {
  const f = await fixture(), tree = await f.git(["rev-parse", "HEAD^{tree}"]); let parent = baseSha;
  for (let index = 0; index < 1001; index++) {
    const bytes = Buffer.from(`tree ${tree}\nparent ${parent}\nauthor Fixture <fixture@test.invalid> 1700000000 +0000\ncommitter Fixture <fixture@test.invalid> 1700000000 +0000\n\nHistory ${index}\n`);
    const object = Buffer.concat([Buffer.from(`commit ${bytes.length}\0`), bytes]); parent = createHash("sha1").update(object).digest("hex");
    const dir = path.join(f.workspace.checkout, ".git/objects", parent.slice(0, 2)); await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, parent.slice(2)), deflateSync(object), { flag: "wx" });
  }
  await f.git(["reset", "--hard", parent]); const input = await f.input();
  await assert.rejects(exportTaskPush(root, input), /history_limit/);
  await assert.rejects(readFile(path.join(exportDir(input.exportId), "manifest.json")), { code: "ENOENT" });
  assert.equal(await f.git(["rev-parse", "HEAD"]), parent);
});

test("a newer observed remote baseline need not be fetched into an older running task's checkout", async () => {
  const f = await fixture(); await f.write("code.txt", "independent task change\n"); await f.commit();
  const otherRepoId = randomUUID(), otherRepo = path.join(root, "repositories", otherRepoId, "git"); await mkdir(path.dirname(otherRepo), { recursive: true });
  await git(root, ["-c", "protocol.file.allow=always", "clone", "--bare", "--no-local", "--template=", baselineRepo, otherRepo]);
  const rows = await git(otherRepo, ["ls-tree", baseSha]), blob = await git(otherRepo, ["hash-object", "-w", "--stdin"], "concurrent remote feature\n");
  const tree = await git(otherRepo, ["mktree"], `${rows}\n100644 blob ${blob}\tremote.txt\n`);
  const newer = await git(otherRepo, ["-c", "user.name=Remote fixture", "-c", "user.email=remote@test.invalid", "commit-tree", tree, "-p", baseSha], "Remote advanced\n");
  await git(otherRepo, ["update-ref", "refs/heads/main", newer]);
  await assert.rejects(f.git(["cat-file", "-e", newer])); const before = await fingerprint(f.workspace.checkout), input = await f.input();
  input.intent.repositoryId = otherRepoId; input.remoteBaseline = { sha: newer, observationHash: createHash("sha256").update(`fixture:${newer}`).digest("hex") };
  const output = await exportTaskPush(root, input), result = await verifyTaskPushExport(root, input.exportId, output.manifestHash);
  assert.equal(output.manifest.commits.length, 1); assert.equal(await git(result.directory, ["rev-parse", "HEAD^1"]), baseSha);
  assert.equal(await git(result.directory, ["ls-tree", "HEAD", "remote.txt"]), "");
  assert.deepEqual(await fingerprint(f.workspace.checkout), before); await assert.rejects(f.git(["cat-file", "-e", newer]));
});
