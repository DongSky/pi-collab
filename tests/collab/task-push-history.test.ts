import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { managedGit } from "../../lib/collab/git/github-pack";
import { createWorkspace } from "../../lib/collab/runtime/workspace";
import { beginNativeReceipt } from "../../lib/collab/runtime/receipts";
import { NativeRuntimeBackend } from "../../lib/collab/runtime/backends";
import { inspectWorkspaceGit } from "../../lib/collab/runtime/workspace-git-view";
import { exportTaskPush } from "../../lib/collab/git/task-push-export";
import { TaskPushHistoryReader } from "../../lib/collab/git/task-push-history";

const root = await mkdtemp(path.join(tmpdir(), "pi-collab-push-history-")), repositoryId = randomUUID();
const source = path.join(root, "source"), baseline = path.join(root, "repositories", repositoryId, "git");
const signal = () => AbortSignal.timeout(60000), digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const git = async (cwd: string, args: string[], input?: string) => (await managedGit(cwd, args, signal(), { input })).bytes.toString().trim();
let base: string;
before(async () => {
  await mkdir(source); await git(source, ["init", "--template=", "-b", "main"]);
  await git(source, ["config", "user.name", "History fixture"]); await git(source, ["config", "user.email", "history@test.invalid"]);
  await writeFile(path.join(source, "code.txt"), "baseline\r\n"); await writeFile(path.join(source, ".env"), "KNOWN_REMOTE_PLACEHOLDER=yes\n");
  await writeFile(path.join(source, "old-settings.txt"), `password = "${"x".repeat(24)}"\n`);
  await writeFile(path.join(source, "old-utf16.txt"), Buffer.from(`password = "${"y".repeat(24)}"\n`, "utf16le"));
  await git(source, ["add", "."]); await git(source, ["commit", "-m", "Known remote baseline"]); base = await git(source, ["rev-parse", "HEAD"]);
  await mkdir(path.dirname(baseline), { recursive: true }); await git(root, ["-c", "protocol.file.allow=always", "clone", "--bare", "--no-local", "--template=", source, baseline]);
});
after(async () => { await rm(root, { recursive: true, force: true }); });
async function scenario(stopped = true) {
  const workspace = await createWorkspace(root, randomUUID(), baseline, base);
  const identity = { runId: randomUUID(), executorId: randomUUID(), epoch: "1" }, inputSource = { workspaceId: workspace.id, identity };
  if (stopped) await (await beginNativeReceipt(workspace, identity)).stopped();
  const runGit = (args: string[], input?: string) => git(workspace.checkout, args, input);
  const write = (name: string, data: Buffer | string) => writeFile(path.join(workspace.checkout, name), data);
  const commit = async (message = "History change") => { await runGit(["add", "."]); await runGit(["commit", "-q", "--allow-empty", "--file=-"], message); return runGit(["rev-parse", "HEAD"]); };
  const exportHistory = async () => {
    const view = await inspectWorkspaceGit(root, inputSource), id = randomUUID();
    const result = await exportTaskPush(root, { version: 1, exportId: id, source: inputSource, revision: view.revision,
      intent: { operationId: randomUUID(), repositoryId, taskId: randomUUID(), workspaceId: workspace.id, expectedOld: null, newSha: view.summary().head },
      remoteBaseline: { sha: base, observationHash: digest("generated-history-fixture") } });
    const open = () => TaskPushHistoryReader.open(root, id, result.manifestHash, signal());
    return { ...result, id, open, reader: await open(), query: { manifestHash: result.manifestHash } };
  };
  return { workspace, identity, write, commit, git: runGit, exportHistory };
}

test("real Pi intermediate and later-deleted content is reviewable from the fixed export after the original source changes", async () => {
  const s = await scenario(false), agent = await new NativeRuntimeBackend().start(s.workspace, undefined, s.identity);
  try { await agent.peer.command("bash", { command: "printf 'intermediate bytes\\n' > temporary.txt; git add temporary.txt; git commit -m 'Intermediate checkpoint'; rm temporary.txt; printf 'final code\\r\\n' > code.txt; git add .; git commit -m 'Final checkpoint'; printf 'retained draft\\n' > code.txt" }); }
  finally { await agent.stop(); }
  const e = await s.exportHistory(), history = await e.reader.read({ ...e.query, kind: "commits" }); assert.equal(history.kind, "commits"); if (history.kind !== "commits") return;
  assert.equal(history.total, 2); assert.match(history.commits[1].text!, /Intermediate checkpoint/); assert.equal(history.identity.head, history.commits[0].oid);
  const initial = history.commits[1].oid, file = await e.reader.read({ ...e.query, kind: "file", commit: initial, path: "temporary.txt" });
  assert.equal(file.kind, "file"); if (file.kind !== "file") return; assert.equal(file.after?.text, "intermediate bytes\n");
  assert.equal(await readFile(path.join(s.workspace.checkout, "code.txt"), "utf8"), "retained draft\n");
  await rm(s.workspace.checkout, { recursive: true, force: true });
  const reopened = await e.open(); assert.deepEqual(await reopened.read({ ...e.query, kind: "file", commit: initial, path: "temporary.txt" }), file);
  await assert.rejects(reopened.read({ ...e.query, kind: "file", commit: history.identity.head, path: "temporary.txt" }), /不属于/);
});

test("all merge parents and an empty final tree remain listed; a clean final diff cannot hide a merged side version", async () => {
  const s = await scenario(); await s.write("side.txt", "side version\n"); const side = await s.commit();
  const tree = await s.git(["rev-parse", `${base}^{tree}`]), head = await s.git(["commit-tree", tree, "-p", base, "-p", side], "Empty-looking merge\n");
  await s.git(["update-ref", "HEAD", head]); await s.git(["read-tree", head]);
  const e = await s.exportHistory(), list = await e.reader.read({ ...e.query, kind: "commits" }); assert.equal(list.kind, "commits"); if (list.kind !== "commits") return;
  assert.equal(list.total, 2); assert.deepEqual(list.commits[0].parents, [base, side]);
  const changes = await e.reader.read({ ...e.query, kind: "changes", commit: head }); assert.equal(changes.kind, "changes"); if (changes.kind !== "changes") return; assert.equal(changes.total, 0);
  const file = await e.reader.read({ ...e.query, kind: "file", commit: side, path: "side.txt" }); assert.equal(file.kind, "file"); if (file.kind === "file") assert.equal(file.after?.text, "side version\n");
});

test("raw downloads preserve binary, UTF-16, CRLF, missing final newline and executable mode without HTML rendering or text conversion", async () => {
  const s = await scenario(), binary = Buffer.from([0, 1, 10, 13, 10, 255]), unicode = Buffer.from("safe UTF-16 text", "utf16le");
  await s.write("binary.bin", binary); await s.write("utf16.txt", unicode); await s.write("code.txt", "first\r\nsecond"); await chmod(path.join(s.workspace.checkout, "code.txt"), 0o755);
  const head = await s.commit("Literal <script>untrusted</script>\u202E"), e = await s.exportHistory();
  for (const [name, bytes] of [["binary.bin", binary], ["utf16.txt", unicode]] as const) {
    const file = await e.reader.read({ ...e.query, kind: "file", commit: head, path: name }); assert.equal(file.kind, "file"); if (file.kind !== "file") continue;
    assert.equal(file.omitted, "non_text_or_large"); assert.equal(file.after?.text, null); assert.equal(file.after?.downloadable, true);
    if (name === "binary.bin") assert.deepEqual(file.after?.lineEndings, { lf: 2, crlf: 1 });
    const download = await e.reader.download({ ...e.query, kind: "file", commit: head, path: name, side: "after" });
    assert.deepEqual(Buffer.from(download.bytesBase64, "base64"), bytes); assert.equal(download.hash, digest(bytes));
  }
  const code = await e.reader.read({ ...e.query, kind: "file", commit: head, path: "code.txt" }); assert.equal(code.kind, "file"); if (code.kind !== "file") return;
  assert.equal(code.after?.mode, "100755"); assert.deepEqual(code.after?.lineEndings, { lf: 1, crlf: 1 }); assert.equal(code.after?.trailingNewline, false);
  const history = await e.reader.read({ ...e.query, kind: "commits" }); if (history.kind !== "commits") throw new Error("Wrong page");
  assert.match(history.commits[0].text!, /⟦U\+202E⟧/); assert.equal(history.commits[0].escapedControls, true);
  const raw = await e.reader.download({ ...e.query, kind: "commit", commit: head }); assert.equal(Buffer.from(raw.bytesBase64, "base64").includes(Buffer.from("\u202E")), true);
});

test("historical excluded deletions stay explicit and old UTF-8/UTF-16 secrets cannot escape through either text or raw downloads", async () => {
  const s = await scenario(); for (const name of [".env", "old-settings.txt", "old-utf16.txt"]) await rm(path.join(s.workspace.checkout, name));
  const head = await s.commit(), e = await s.exportHistory();
  const list = await e.reader.read({ ...e.query, kind: "changes", commit: head }); assert.equal(list.kind, "changes"); if (list.kind !== "changes") return;
  assert.equal(list.total, 3); assert.equal(list.files.find(f => f.path === ".env")?.kind, "deleted");
  for (const name of [".env", "old-settings.txt", "old-utf16.txt"]) {
    const file = await e.reader.read({ ...e.query, kind: "file", commit: head, path: name }); if (file.kind !== "file") throw new Error("Wrong file");
    assert.ok(file.omitted); assert.equal(file.before, null); assert.equal(file.after, null);
    await assert.rejects(e.reader.download({ ...e.query, kind: "file", commit: head, path: name, side: "before" }));
  }
});

test("bounded pages preserve every commit and changed path, with explicit full-byte fallback for long text and commit metadata", async () => {
  const s = await scenario(); for (let i = 0; i < 103; i++) await s.write(`file-${String(i).padStart(3, "0")}.txt`, "new file\n");
  await s.write("large.txt", "a".repeat(270000)); let head = await s.commit("Long message\n" + "b".repeat(270000));
  for (let i = 0; i < 50; i++) head = await s.commit(`Empty checkpoint ${i}`);
  const e = await s.exportHistory(), first = await e.reader.read({ ...e.query, kind: "commits" }); if (first.kind !== "commits") throw new Error("Wrong page");
  assert.equal(first.commits.length, 50); assert.equal(first.total, 51); assert.equal(first.nextOffset, 50);
  const last = await e.reader.read({ ...e.query, kind: "commits", offset: 50 }); if (last.kind !== "commits") throw new Error("Wrong page");
  assert.equal(last.commits.length, 1); assert.equal(last.commits[0].text, null); assert.equal(last.commits[0].omitted, true);
  const meta = await e.reader.download({ ...e.query, kind: "commit", commit: last.commits[0].oid }); assert.ok(meta.size > 270000);
  const page = await e.reader.read({ ...e.query, kind: "changes", commit: head }); if (page.kind !== "changes") throw new Error("Wrong page");
  assert.equal(page.total, 104); assert.equal(page.files.length, 100); assert.equal(page.nextOffset, 100);
  const rest = await e.reader.read({ ...e.query, kind: "changes", commit: head, offset: 100 }); if (rest.kind !== "changes") throw new Error("Wrong page");
  assert.equal(rest.files.length, 4); assert.equal(rest.nextOffset, null);
  const large = await e.reader.read({ ...e.query, kind: "file", commit: head, path: "large.txt" }); if (large.kind !== "file") throw new Error("Wrong file");
  assert.equal(large.after?.text, null); assert.equal(large.after?.downloadable, true); assert.equal((await e.reader.download({ ...e.query, kind: "file", commit: head, path: "large.txt", side: "after" })).size, 270000);
});

test("wrong hashes, baseline/unlisted commits, arbitrary objects, unchanged paths and traversal cannot turn review into a repository file browser", async () => {
  const s = await scenario(); await s.write("new.txt", "new\n"); const head = await s.commit(), e = await s.exportHistory();
  await assert.rejects(e.reader.read({ ...e.query, kind: "commits", manifestHash: "0".repeat(64) }), /版本不匹配/);
  for (const commit of [base, "1".repeat(40)]) await assert.rejects(e.reader.read({ ...e.query, kind: "changes", commit }), /不属于/);
  for (const name of ["code.txt", "../manifest.json", "/etc/passwd"]) await assert.rejects(e.reader.read({ ...e.query, kind: "file", commit: head, path: name }));
  await assert.rejects(e.reader.download({ ...e.query, kind: "commit", commit: base }), /不属于/);
  await assert.rejects(e.reader.read({ ...e.query, kind: "commits", oid: head }));
});

test("manifest, pack, object and path corruption fail without recreating artifacts or falling back to the original workspace", async () => {
  for (const change of ["manifest", "pack", "object", "symlink"]) {
    const s = await scenario(); await s.write("new.txt", "new\n"); const head = await s.commit(), e = await s.exportHistory();
    const directory = path.join(root, "task-push-exports", e.id);
    if (change === "manifest") await writeFile(path.join(directory, "manifest.json"), "{}");
    else if (change === "pack") { const pack = path.join(directory, "git", "objects", "pack", `pack-${e.manifest.basePack.id}.pack`); await chmod(pack, 0o600); await writeFile(pack, "bad pack"); }
    else if (change === "object") await writeFile(path.join(directory, "git", "objects", head.slice(0, 2), head.slice(2)), "bad object");
    else await symlink(s.workspace.checkout, path.join(directory, "git", "unexpected-link"));
    await assert.rejects(e.open()); assert.equal(await s.git(["rev-parse", "HEAD"]), head);
  }
});

test("cancelled readers cannot return metadata or downloads", async () => {
  const s = await scenario(); await s.commit(); const e = await s.exportHistory(), stop = new AbortController();
  const reader = await TaskPushHistoryReader.open(root, e.id, e.manifestHash, stop.signal); stop.abort();
  await assert.rejects(reader.read({ ...e.query, kind: "commits" }));
  await assert.rejects(reader.download({ ...e.query, kind: "commit", commit: e.manifest.input.intent.newSha }));
});
