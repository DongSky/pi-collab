import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { capturePullRevision, pullRevisionInput, readPullRevisionFile, verifyPullRevision, type PullRevisionInput } from "../../lib/collab/git/pull-revision";
import { managedGit } from "../../lib/collab/git/github-pack";
import { githubGitFixture } from "./fixtures/github-git";
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const git = async (cwd: string, args: string[], input?: string) => (await managedGit(cwd, args, AbortSignal.timeout(30000), { input })).bytes.toString().trim();
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "pi-collab-pull-revision-")), source = path.join(root, "source"), remote = path.join(root, "source.git");
  await mkdir(source); await git(source, ["init", "--template=", "-b", "main"]);
  await git(source, ["config", "user.name", "Fixed code fixture"]); await git(source, ["config", "user.email", "revision@test.invalid"]);
  await writeFile(path.join(source, "code.txt"), "common\n"); await writeFile(path.join(source, "deleted.txt"), "removed later\n");
  await git(source, ["add", "."]); await git(source, ["commit", "-m", "Common ancestor"]); const ancestor = await git(source, ["rev-parse", "HEAD"]);
  await git(source, ["checkout", "-b", "feature"]); await writeFile(path.join(source, "code.txt"), "source change\r\n");
  await rm(path.join(source, "deleted.txt")); await writeFile(path.join(source, "binary.bin"), Buffer.from([0, 255, 4, 9]));
  await writeFile(path.join(source, "script.sh"), "#!/bin/sh\nexit 0\n"); await chmod(path.join(source, "script.sh"), 0o755);
  await git(source, ["add", "."]); await git(source, ["commit", "-m", "Source work"]); const headSha = await git(source, ["rev-parse", "HEAD"]);
  await git(source, ["checkout", "main"]); await writeFile(path.join(source, "target-only.txt"), "target work\n");
  await git(source, ["add", "."]); await git(source, ["commit", "-m", "Target work"]); const baseSha = await git(source, ["rev-parse", "HEAD"]);
  await git(root, ["-c", "protocol.file.allow=always", "clone", "--bare", "--no-local", "--template=", source, remote]);
  const api = await githubGitFixture(root); api.api.state.sha = baseSha; api.api.state.branch = "main";
  const input: PullRevisionInput = { version: 1, revisionId: randomUUID(), changeId: randomUUID(), repositoryId: randomUUID(), githubRepositoryId: "1011", pullId: "2022", pullNumber: 17,
    observationId: randomUUID(), observationHash: hash("immutable provider observation fixture"), headSha, baseSha, headRef: "feature", baseRef: "main" };
  const capture = async (value = input, signal?: AbortSignal) => (await api.client.readGitRepository("1011", (_evidence, read, deadline) => capturePullRevision(root, value, read, deadline), signal)).value;
  return { root, source, remote, api, input, ancestor, capture, directory: (id = input.revisionId) => path.join(root, "pull-revisions", id),
    async close() { await api.close(); await rm(root, { recursive: true, force: true }); } };
}

test("PR revision downloads complete real histories and fixes merge-base changes, raw binary bytes and execution modes", async () => {
  const f = await fixture();
  try {
    const remoteBefore = await git(f.remote, ["show-ref"]), result = await f.capture(), m = result.manifest;
    assert.equal(m.mergeBase, f.ancestor); assert.equal(m.comparison, "merge-base-to-head"); assert.equal(m.input.baseSha, f.input.baseSha);
    assert.equal(m.files.some(file => file.path === "target-only.txt"), false);
    assert.deepEqual(m.files.map(file => file.path), ["binary.bin", "code.txt", "deleted.txt", "script.sh"]);
    assert.equal(m.files.find(file => file.path === "script.sh")?.after?.mode, "100755");
    assert.equal(m.files.find(file => file.path === "deleted.txt")?.after, null);
    const code = await readPullRevisionFile(f.root, f.input.revisionId, result.manifestHash, "code.txt", "after");
    assert.deepEqual(code.bytes, Buffer.from("source change\r\n")); assert.equal(code.hash, hash(code.bytes));
    assert.deepEqual((await readPullRevisionFile(f.root, f.input.revisionId, result.manifestHash, "binary.bin", "after")).bytes, Buffer.from([0, 255, 4, 9]));
    const verified = await verifyPullRevision(f.root, f.input.revisionId, result.manifestHash); assert.deepEqual(verified.manifest, m);
    const dir = path.join(f.directory(), "git"); assert.equal(await git(dir, ["rev-list", "--count", f.input.headSha, f.input.baseSha]), "3");
    assert.equal(await git(dir, ["remote"]), ""); assert.doesNotMatch(await readFile(path.join(dir, "config"), "utf8"), /Authorization|github.com|127.0.0.1|token|helper/);
    assert.equal(await git(f.remote, ["show-ref"]), remoteBefore); assert.equal(f.api.api.state.revoked, 1);
    assert.ok(f.api.calls.some(route => route.endsWith("git-upload-pack"))); assert.ok(f.api.calls.every(route => !route.includes("receive-pack")));
  } finally { await f.close(); }
});

test("exact observed commits survive moving or deleted source refs; new captures keep a stable diff identity", async () => {
  const f = await fixture();
  try {
    const first = await f.capture(); await git(f.remote, ["update-ref", "refs/heads/retained", f.input.headSha]);
    await git(f.remote, ["update-ref", "-d", "refs/heads/feature"]);
    const second = await f.capture({ ...f.input, revisionId: randomUUID(), observationId: randomUUID() });
    assert.equal(first.manifest.diffHash, second.manifest.diffHash); assert.notEqual(first.manifestHash, second.manifestHash);
    assert.deepEqual((await verifyPullRevision(f.root, f.input.revisionId, first.manifestHash)).manifest.files, first.manifest.files);
    await git(f.remote, ["update-ref", "refs/heads/feature", f.input.baseSha]);
    assert.equal((await f.capture({ ...f.input, revisionId: randomUUID() })).manifest.diffHash, first.manifest.diffHash);
  } finally { await f.close(); }
});

test("target changes invalidate revision identity even when source changes are identical; equal endpoints form an empty diff", async () => {
  const f = await fixture();
  try {
    const a = await f.capture(), b = await f.capture({ ...f.input, revisionId: randomUUID(), baseSha: f.ancestor });
    assert.deepEqual(a.manifest.files, b.manifest.files); assert.notEqual(a.manifest.diffHash, b.manifest.diffHash);
    const equal = await f.capture({ ...f.input, revisionId: randomUUID(), baseSha: f.input.headSha });
    assert.equal(equal.manifest.mergeBase, f.input.headSha); assert.deepEqual(equal.manifest.files, []);
  } finally { await f.close(); }
});

test("fresh capture IDs cannot reuse successful or partial directories; invalid identities and paths never start transport", async () => {
  const f = await fixture(); let calls = 0;
  try {
    for (const patch of [{ revisionId: "../outside" }, { headSha: "--all" }, { baseRef: "../bad" }, { extra: "ignored" }]) {
      assert.equal(pullRevisionInput.safeParse({ ...f.input, ...patch }).success, false);
      await assert.rejects(capturePullRevision(f.root, { ...f.input, ...patch } as PullRevisionInput, async () => { calls++; throw new Error(); }));
    }
    assert.equal(calls, 0); const a = await f.capture(); const requestCount = f.api.calls.length;
    await assert.rejects(f.capture(), /EEXIST/); assert.equal(f.api.calls.length, requestCount);
    const id = randomUUID(); await mkdir(f.directory(id));
    await assert.rejects(f.capture({ ...f.input, revisionId: id }), /EEXIST/);
    await assert.rejects(readPullRevisionFile(f.root, f.input.revisionId, a.manifestHash, "../config", "after"), /file_not_found/);
    await assert.rejects(verifyPullRevision(f.root, f.input.revisionId, "0".repeat(64)), /manifest_changed/);
  } finally { await f.close(); }
});

test("unrelated histories and criss-cross multiple merge bases never choose a misleading diff", async () => {
  const f = await fixture();
  try {
    const tree = await git(f.source, ["rev-parse", `${f.ancestor}^{tree}`]);
    const make = (parents: string[], message: string) => git(f.source, ["commit-tree", tree, ...parents.flatMap(id => ["-p", id]), "-m", message]);
    const unrelated = await make([], "Unrelated"), left = await make([f.ancestor], "Left"), right = await make([f.ancestor], "Right");
    const one = await make([left, right], "First crossed merge"), two = await make([right, left], "Second crossed merge");
    for (const [name, id] of Object.entries({ unrelated, one, two })) await git(f.source, ["update-ref", `refs/heads/${name}`, id]);
    await git(f.remote, ["-c", "protocol.file.allow=always", "fetch", f.source, "refs/heads/*:refs/heads/*"]);
    await assert.rejects(f.capture({ ...f.input, revisionId: randomUUID(), headSha: unrelated }), /unrelated_history/);
    await assert.rejects(f.capture({ ...f.input, revisionId: randomUUID(), headSha: one, baseSha: two }), /ambiguous_merge_base/);
    assert.equal(f.api.api.state.revoked, 2);
  } finally { await f.close(); }
});

test("manifest, pack, config and ref corruption cannot become another valid fixed revision", async () => {
  const f = await fixture();
  try {
    const result = await f.capture(), dir = f.directory(), packFile = path.join(dir, "git/objects/pack", `pack-${result.manifest.pack.id}.pack`);
    for (const file of [path.join(dir, "manifest.json"), packFile, path.join(dir, "git/config")]) {
      const original = await readFile(file); await chmod(file, 0o600); await writeFile(file, Buffer.concat([original, Buffer.from("corruption")]));
      await assert.rejects(verifyPullRevision(f.root, f.input.revisionId, result.manifestHash)); await writeFile(file, original);
    }
    await git(path.join(dir, "git"), ["update-ref", "refs/heads/revision/head", f.input.baseSha]);
    await assert.rejects(verifyPullRevision(f.root, f.input.revisionId, result.manifestHash), /artifact_changed/);
    await git(path.join(dir, "git"), ["update-ref", "refs/heads/revision/head", f.input.headSha]);
    await rm(packFile); await assert.rejects(verifyPullRevision(f.root, f.input.revisionId, result.manifestHash));
  } finally { await f.close(); }
});

test("shallow, grafts, alternates and symbolic links are refused", async () => {
  const f = await fixture();
  try {
    const result = await f.capture(), dir = f.directory();
    for (const file of ["shallow", "info/grafts", "commondir", "objects/info/alternates", "objects/info/http-alternates"]) {
      await mkdir(path.dirname(path.join(dir, "git", file)), { recursive: true });
      await writeFile(path.join(dir, "git", file), f.ancestor + "\n");
      await assert.rejects(verifyPullRevision(f.root, f.input.revisionId, result.manifestHash)); await rm(path.join(dir, "git", file));
    }
    await symlink(f.root, path.join(dir, "git/objects/outside"));
    await assert.rejects(verifyPullRevision(f.root, f.input.revisionId, result.manifestHash)); await rm(path.join(dir, "git/objects/outside"));
    await rename(path.join(dir, "manifest.json"), path.join(dir, "original.json")); await symlink(path.join(dir, "original.json"), path.join(dir, "manifest.json"));
    await assert.rejects(verifyPullRevision(f.root, f.input.revisionId, result.manifestHash));
  } finally { await f.close(); }
});

test("secret/excluded paths, symlinks and gitlinks remain recorded but cannot be read through the file API", async () => {
  const f = await fixture();
  try {
    await git(f.source, ["checkout", "feature"]);
    await writeFile(path.join(f.source, ".env"), "PRIVATE_FIXTURE=value\n");
    await writeFile(path.join(f.source, "credential.txt"), "-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----\n");
    await symlink("/outside/never-follow", path.join(f.source, "outside"));
    await git(f.source, ["add", "."]); await git(f.source, ["update-index", "--add", "--cacheinfo", `160000,${f.ancestor},module`]);
    await git(f.source, ["commit", "-m", "Special objects"]); const headSha = await git(f.source, ["rev-parse", "HEAD"]);
    await git(f.remote, ["-c", "protocol.file.allow=always", "fetch", f.source, "feature:feature"]);
    const result = await f.capture({ ...f.input, headSha });
    for (const name of [".env", "credential.txt", "outside", "module"]) {
      assert.ok(result.manifest.files.find(file => file.path === name)?.omitted);
      await assert.rejects(readPullRevisionFile(f.root, f.input.revisionId, result.manifestHash, name, "after"), /file_omitted/);
    }
    assert.equal(result.manifest.files.find(file => file.path === "module")?.after?.hash, null);
    assert.ok(result.manifest.files.find(file => file.path === "credential.txt")?.after?.hash);
  } finally { await f.close(); }
});

test("cancelled, unavailable, redirected, truncated or oversized transfers never publish a manifest and revoke credentials", async () => {
  const f = await fixture();
  try {
    for (const mode of ["redirect", "cut", "oversize", "cancel", "missing"]) {
      const id = randomUUID(), stop = new AbortController(); f.api.state.fail = mode;
      f.api.state.beforeGit = mode === "cancel" ? async () => { stop.abort(); } : undefined;
      await assert.rejects(f.capture({ ...f.input, revisionId: id, ...(mode === "missing" ? { headSha: "a".repeat(40) } : {}) }, stop.signal));
      await assert.rejects(readFile(path.join(f.directory(id), "manifest.json")), { code: "ENOENT" });
    }
    assert.equal(f.api.api.state.revoked, 5);
  } finally { await f.close(); }
});

test("oversized changed content refuses a partial revision instead of silently omitting its hash", async () => {
  const f = await fixture();
  try {
    await git(f.source, ["checkout", "feature"]); await writeFile(path.join(f.source, "large.bin"), Buffer.alloc(2 * 1024 * 1024 + 1, 1));
    await git(f.source, ["add", "."]); await git(f.source, ["commit", "-m", "Large change"]); const headSha = await git(f.source, ["rev-parse", "HEAD"]);
    await git(f.remote, ["-c", "protocol.file.allow=always", "fetch", f.source, "feature:feature"]);
    await assert.rejects(f.capture({ ...f.input, headSha }), /content_limit/);
    await assert.rejects(readFile(path.join(f.directory(), "manifest.json")), { code: "ENOENT" });
    assert.equal(f.api.api.state.revoked, 1);
  } finally { await f.close(); }
});

test("project hooks, attributes, filters and source working files never execute or change during capture", async () => {
  const f = await fixture();
  try {
    await git(f.source, ["checkout", "feature"]); await writeFile(path.join(f.source, ".gitattributes"), "* filter=fixture diff=fixture\n");
    await git(f.source, ["add", "."]); await git(f.source, ["commit", "-m", "Untrusted attributes"]); const headSha = await git(f.source, ["rev-parse", "HEAD"]);
    await git(f.remote, ["-c", "protocol.file.allow=always", "fetch", f.source, "feature:feature"]);
    const marker = path.join(f.root, "must-not-execute");
    await mkdir(path.join(f.remote, "hooks"), { recursive: true });
    await writeFile(path.join(f.remote, "hooks/post-checkout"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    await git(f.source, ["config", "filter.fixture.smudge", `touch '${marker}'`]); await git(f.source, ["config", "diff.fixture.command", `touch '${marker}'`]);
    await writeFile(path.join(f.source, "code.txt"), "private uncommitted work\n");
    const result = await f.capture({ ...f.input, headSha });
    assert.equal((await readPullRevisionFile(f.root, f.input.revisionId, result.manifestHash, "code.txt", "after")).bytes.toString(), "source change\r\n");
    assert.equal(await readFile(path.join(f.source, "code.txt"), "utf8"), "private uncommitted work\n");
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    assert.ok((await readdir(f.directory())).includes("manifest.json"));
  } finally { await f.close(); }
});
