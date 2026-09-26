import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { managedGit } from "../../lib/collab/git/github-pack";
import { createWorkspace } from "../../lib/collab/runtime/workspace";
import { beginNativeReceipt } from "../../lib/collab/runtime/receipts";
import { NativeRuntimeBackend } from "../../lib/collab/runtime/backends";
import { inspectWorkspaceGit } from "../../lib/collab/runtime/workspace-git-view";
import { createTaskPushPreview, taskPushPreviewInput, type TaskPushPreviewInput } from "../../lib/collab/git/task-push-preview";
import { prepareExportedTaskPush, verifyTaskPushExport } from "../../lib/collab/git/task-push-export";
import { taskPushRef } from "../../lib/collab/git/task-push-protocol";
import { githubPushFixture } from "./fixtures/github-push";

const deadline = () => AbortSignal.timeout(60000);
const git = async (directory: string, args: string[]) => (await managedGit(directory, args, deadline())).bytes.toString().trim();
const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
async function fingerprint(directory: string): Promise<string[]> {
  const rows: string[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) rows.push(...(await fingerprint(file)).map(row => `${entry.name}/${row}`));
    else if (entry.isFile()) rows.push(`${entry.name}:${digest(await readFile(file))}`);
  }
  return rows;
}
async function fixture(stopped = true) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-collab-push-preview-")), repositoryId = randomUUID(), taskId = randomUUID();
  const original = path.join(root, "original"), baseline = path.join(root, "repositories", repositoryId, "git"), remote = path.join(root, "source.git");
  await mkdir(original); await git(original, ["init", "--template=", "-b", "main"]);
  await git(original, ["config", "user.name", "Preview fixture"]); await git(original, ["config", "user.email", "preview@test.invalid"]);
  await writeFile(path.join(original, "code.txt"), "known base\n"); await writeFile(path.join(original, ".env"), "KNOWN_REMOTE_PLACEHOLDER=yes\n");
  await git(original, ["add", "."]); await git(original, ["commit", "-m", "Known base"]); const base = await git(original, ["rev-parse", "HEAD"]);
  await mkdir(path.dirname(baseline), { recursive: true });
  for (const target of [baseline, remote]) await git(root, ["-c", "protocol.file.allow=always", "clone", "--bare", "--no-local", "--template=", original, target]);
  const workspace = await createWorkspace(root, randomUUID(), baseline, base), source = { workspaceId: workspace.id, identity: { runId: randomUUID(), executorId: randomUUID(), epoch: "1" } };
  if (stopped) await (await beginNativeReceipt(workspace, source.identity)).stopped();
  const binding = { repositoryId, githubRepositoryId: "1011", nodeId: "R_fixture", ownerId: "789", ownerLogin: "example-org", name: "example-repo",
    defaultBranch: "main", private: true, visibility: "private" as const, integrationBranches: ["main", "release"] };
  const ref = taskPushRef({ taskId, workspaceId: workspace.id }), api = await githubPushFixture(root, binding, ref, "read");
  const input = async (): Promise<TaskPushPreviewInput> => {
    const view = (await inspectWorkspaceGit(root, source)).summary();
    return { version: 1, exportId: randomUUID(), operationId: randomUUID(), taskId, source, revision: view.revision, head: view.head, binding };
  };
  const write = (name: string, bytes: string) => writeFile(path.join(workspace.checkout, name), bytes);
  const commit = async () => { await git(workspace.checkout, ["add", "."]); await git(workspace.checkout, ["commit", "--allow-empty", "-m", "Task commit"]); return git(workspace.checkout, ["rev-parse", "HEAD"]); };
  const advanceRemote = async () => {
    await writeFile(path.join(original, "remote.txt"), "new remote history\n"); await git(original, ["add", "."]); await git(original, ["commit", "-m", "Remote advanced"]);
    await git(remote, ["-c", "protocol.file.allow=always", "fetch", "--no-tags", original, "main:refs/heads/main"]); return git(original, ["rev-parse", "HEAD"]);
  };
  return { root, original, baseline, remote, base, workspace, source, binding, taskId, ref, api, input, write, commit, advanceRemote,
    preview: (value: TaskPushPreviewInput, signal?: AbortSignal) => createTaskPushPreview(root, value, api.readClient, signal),
    async close() { await api.close(); await rm(root, { recursive: true, force: true }); } };
}

test("real Pi commits use authenticated read-only baseline capture and immutable history export before a separate exact task push", async () => {
  const f = await fixture(false), agent = await new NativeRuntimeBackend().start(f.workspace, undefined, f.source.identity);
  try {
    try { await agent.peer.command("bash", { command: "printf 'Pi committed change\\n' > code.txt; git add code.txt; git commit -m 'Pi preview'; printf 'retained draft\\n' > code.txt" }); }
    finally { await agent.stop(); }
    const input = await f.input(), before = await fingerprint(f.workspace.checkout), result = await f.preview(input);
    assert.equal(result.observation.baseline.capabilities.push, false); assert.equal(result.observation.baseline.tokenRevoked, true);
    assert.equal(result.observation.target.ref, f.ref); assert.equal(result.observation.target.observedOld, null);
    assert.equal(result.observationHash, digest(JSON.stringify(result.observation))); assert.equal(result.manifest.input.remoteBaseline.observationHash, result.observationHash);
    assert.equal(result.manifest.input.intent.newSha, input.head); assert.equal(result.manifest.input.remoteBaseline.captureId, input.exportId);
    assert.equal(f.api.state.issued, 1); assert.equal(f.api.state.revoked, 1); assert.ok(f.api.git.calls.upload > 0);
    assert.equal(f.api.git.calls.advertise, 0); assert.equal(f.api.git.calls.receive, 0); assert.equal(f.api.containsCredential(result), false);
    assert.deepEqual(await fingerprint(f.workspace.checkout), before); assert.equal(await git(f.baseline, ["rev-parse", "HEAD"]), f.base);
    const captured = path.join(f.root, "task-push-captures", input.exportId, "git");
    assert.equal(await git(captured, ["rev-parse", "HEAD"]), f.base); assert.equal(await git(captured, ["remote"]), "");
    const writer = await githubPushFixture(f.root, f.binding, f.ref);
    try {
      const prepared = await prepareExportedTaskPush(f.root, input.exportId, result.manifestHash);
      assert.equal((await writer.client.execute(prepared, f.binding, async () => true)).outcome?.status, "acknowledged");
      assert.equal(await git(f.remote, ["rev-parse", f.ref]), input.head); assert.equal(await git(f.remote, ["rev-parse", "main"]), f.base);
      assert.deepEqual(await fingerprint(f.workspace.checkout), before);
    } finally { await writer.close(); }
  } finally { await f.close(); }
});

test("a newer authenticated remote baseline need not exist in either the task checkout or shared local repository", async () => {
  const f = await fixture();
  try {
    await f.write("code.txt", "old-base task change\n"); await f.commit(); const input = await f.input(), newer = await f.advanceRemote();
    const before = await fingerprint(f.workspace.checkout), shared = await fingerprint(f.baseline), result = await f.preview(input);
    assert.equal(result.observation.target.defaultSha, newer); assert.equal(result.manifest.input.remoteBaseline.sha, newer);
    assert.deepEqual(await fingerprint(f.workspace.checkout), before); assert.deepEqual(await fingerprint(f.baseline), shared);
    for (const repo of [f.workspace.checkout, f.baseline]) await assert.rejects(git(repo, ["cat-file", "-e", newer]));
    assert.equal((await verifyTaskPushExport(f.root, input.exportId, result.manifestHash)).manifest.input.intent.newSha, input.head);
  } finally { await f.close(); }
});

test("an existing generated task ref supplies the exact expected-old commit independently from the default baseline", async () => {
  const f = await fixture();
  try {
    await f.write("code.txt", "task version one\n"); const old = await f.commit();
    await git(f.remote, ["-c", "protocol.file.allow=always", "fetch", "--no-tags", f.workspace.checkout, `${f.workspace.branch}:${f.ref}`]);
    await f.write("code.txt", "task version two\n"); await f.commit();
    const input = await f.input(), result = await f.preview(input);
    assert.equal(result.observation.target.observedOld, old); assert.equal(result.manifest.input.intent.expectedOld, old);
    assert.equal(result.manifest.input.remoteBaseline.sha, f.base); assert.equal(result.manifest.commits.length, 2);
    assert.equal((await prepareExportedTaskPush(f.root, input.exportId, result.manifestHash)).attempt.expectedOld, old);
  } finally { await f.close(); }
});

test("stale source input, an invalid scope or a protected destination cannot start a baseline transfer", async () => {
  for (const change of ["draft", "head", "owner", "default", "read-installation", "rules", "visibility"]) {
    const f = await fixture();
    try {
      await f.write("code.txt", "task\n"); await f.commit(); const input = await f.input();
      if (change === "draft") await f.write("code.txt", "later draft\n");
      else if (change === "head") input.head = f.base;
      else if (change === "owner") input.binding = { ...input.binding, ownerId: "888" };
      else if (change === "default") input.binding = { ...input.binding, defaultBranch: f.ref.slice("refs/heads/".length) };
      else if (change === "read-installation") f.api.state.installContents = "read";
      else if (change === "rules") f.api.state.rules = [{ type: "update" }];
      else f.api.state.visibility = "public";
      await assert.rejects(f.preview(input), /^Error: github_/); assert.equal(f.api.git.calls.upload, 0); assert.equal(f.api.git.calls.receive, 0);
      assert.equal(taskPushPreviewInput.safeParse({ ...input, remoteBaseline: { sha: input.head } }).success, false);
      if (["draft", "head", "owner", "default", "read-installation"].includes(change)) assert.equal(f.api.state.issued, 0);
      else assert.equal(f.api.state.revoked, 1);
    } finally { await f.close(); }
  }
});

test("remote ref, default SHA, rules, identity, visibility, suspension or source changes during upload prevent a usable preview", async () => {
  for (const change of ["ref", "baseline", "rules", "name", "privacy", "suspended", "source"]) {
    const f = await fixture();
    try {
      await f.write("code.txt", "task\n"); await f.commit(); const input = await f.input(); let changed = false;
      f.api.git.state.afterUpload = async () => {
        if (changed) return; changed = true;
        if (change === "ref") await git(f.remote, ["update-ref", f.ref, f.base]);
        else if (change === "baseline") await f.advanceRemote();
        else if (change === "rules") f.api.state.rules = [{ type: "update" }];
        else if (change === "name") f.api.state.name = "renamed";
        else if (change === "privacy") { f.api.state.private = false; f.api.state.visibility = "public"; }
        else if (change === "suspended") f.api.state.suspended = true;
        else await f.write("code.txt", "source changed while downloading\n");
      };
      await assert.rejects(f.preview(input)); assert.equal(changed, true); assert.equal(f.api.state.revoked, 1); assert.equal(f.api.git.calls.receive, 0);
      await assert.rejects(readFile(path.join(f.root, "task-push-exports", input.exportId, "manifest.json")), { code: "ENOENT" });
    } finally { await f.close(); }
  }
});

test("cancelled reads and failed credential cleanup cannot publish a completed history export", async () => {
  for (const cancel of [true, false]) {
    const f = await fixture(), stop = new AbortController();
    try {
      await f.write("code.txt", "task\n"); await f.commit(); const input = await f.input();
      if (cancel) f.api.git.state.afterUpload = async () => { stop.abort(); }; else f.api.state.fail = "revoke";
      await assert.rejects(f.preview(input, stop.signal)); assert.equal(f.api.git.calls.receive, 0);
      assert.equal(f.api.calls.filter(call => call.route === "/installation/token").length, 1);
      await assert.rejects(readFile(path.join(f.root, "task-push-exports", input.exportId, "manifest.json")), { code: "ENOENT" });
    } finally { await f.close(); }
  }
});

test("new history secrets still block the authenticated preview even when absent from the tip", async () => {
  const f = await fixture();
  try {
    await f.write("temporary.txt", `access_token = "${"z".repeat(24)}"\n`); await f.commit();
    await rm(path.join(f.workspace.checkout, "temporary.txt")); await f.commit(); const input = await f.input();
    await assert.rejects(f.preview(input), /task_push_export_secret_content/); assert.equal(f.api.state.revoked, 1); assert.ok(f.api.git.calls.upload > 0);
    await assert.rejects(readFile(path.join(f.root, "task-push-exports", input.exportId, "manifest.json")), { code: "ENOENT" });
  } finally { await f.close(); }
});

test("completed exports survive removal of the read capture and source changes; the same preview ID is never rebuilt", async () => {
  const f = await fixture();
  try {
    await f.write("code.txt", "confirmed history\n"); await f.commit(); const input = await f.input(), result = await f.preview(input);
    // A retry may inspect provider metadata but cannot overwrite the original
    // capture/export. The future SQL queue must deduplicate before this client.
    await assert.rejects(f.preview(input)); assert.equal(f.api.git.calls.receive, 0);
    await rm(path.join(f.root, "task-push-captures", input.exportId), { recursive: true });
    await f.write("code.txt", "later history\n"); await f.commit();
    const verified = await verifyTaskPushExport(f.root, input.exportId, result.manifestHash);
    assert.equal(verified.manifest.input.intent.newSha, input.head); assert.equal(await git(verified.directory, ["show", "HEAD:code.txt"]), "confirmed history");
  } finally { await f.close(); }
});
