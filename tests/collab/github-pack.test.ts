import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gitSource } from "./fixtures/git-source";
import { githubGitFixture } from "./fixtures/github-git";
import { downloadGitHubGit, gitReadRelay } from "../../lib/collab/git/github-pack";
const exec = promisify(execFile);

test("real smart HTTP fetch preserves original commits and history with no credentials, remote, checkout or project hooks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-collab-git-http-")), sha = await gitSource(root), f = await githubGitFixture(root);
  try {
    f.api.state.sha = sha; f.api.state.branch = "main"; const directory = path.join(root, "download");
    const result = await f.client.readGitRepository("1011", (evidence, read, signal) => downloadGitHubGit(directory, evidence, read, signal));
    assert.equal(result.evidence.targetSha, sha); assert.equal(f.api.state.revoked, 1); assert.equal(result.evidence.tokenRevoked, true);
    assert.equal((await exec("git", ["rev-parse", "HEAD"], { cwd: path.join(directory, "git") })).stdout.trim(), sha);
    assert.equal((await exec("git", ["rev-list", "--count", "HEAD"], { cwd: path.join(directory, "git") })).stdout.trim(), "2");
    assert.equal((await exec("git", ["remote"], { cwd: path.join(directory, "git") })).stdout.trim(), "");
    assert.doesNotMatch(await readFile(path.join(directory, "git", "config"), "utf8"), /Authorization|github.com|127.0.0.1|token|helper/);
    assert.ok(f.calls.some(c => c === "/source.git/git-upload-pack"));
  } finally { await f.close(); await rm(root, { recursive: true, force: true }); }
});
test("drifting refs, redirects, broken transfers and oversized packs refuse imported code and still revoke the token", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-collab-git-fail-")), sha = await gitSource(root);
  try { for (const mode of ["drift", "redirect", "cut", "oversize"]) {
    const f = await githubGitFixture(root); f.api.state.sha = mode === "drift" ? "b".repeat(40) : sha; f.api.state.branch = "main"; f.state.fail = mode;
    try { await assert.rejects(f.client.readGitRepository("1011", (e, r, s) => downloadGitHubGit(path.join(root, mode), e, r, s)), /^Error: github_/); assert.equal(f.api.state.revoked, 1); }
    finally { await f.close(); }
  } } finally { await rm(root, { recursive: true, force: true }); }
});
test("loopback relay refuses missing capability, browser origins, receive-pack and arbitrary paths before any upstream request", async () => {
  let calls = 0; const relay = await gitReadRelay(async () => { calls++; throw new Error(); }, new AbortController().signal);
  try {
    for (const [suffix, auth, origin] of [["/info/refs?service=git-upload-pack", false, false], ["/git-receive-pack", true, false], ["/../secret", true, false], ["/info/refs?service=git-upload-pack", true, true]] as const) {
      const res = await fetch(relay.url + suffix, { headers: { ...(auth ? { Authorization: relay.environment.GIT_CONFIG_VALUE_0.slice("Authorization: ".length) } : {}), ...(origin ? { Origin: "http://127.0.0.1" } : {}) } }); assert.equal(res.status, 403);
    }
    assert.equal(calls, 0);
  } finally { await relay.close(); }
});

test("cancellation during actual Git transfer stops its process group and independently revokes the token", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-collab-git-cancel-")), sha = await gitSource(root), f = await githubGitFixture(root), stop = new AbortController();
  try {
    f.api.state.sha = sha; f.api.state.branch = "main"; f.state.beforeGit = async () => { stop.abort(); };
    await assert.rejects(f.client.readGitRepository("1011", (e, r, s) => downloadGitHubGit(path.join(root, "cancelled"), e, r, s), stop.signal), /^Error: github_/);
    assert.ok(f.calls.length); assert.equal(f.api.state.revoked, 1);
  } finally { await f.close(); await rm(root, { recursive: true, force: true }); }
});
