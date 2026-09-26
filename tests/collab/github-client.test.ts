import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify, randomBytes, randomUUID } from "node:crypto";
import { config, pair, githubFixture } from "./fixtures/github";
import { mkdtemp, writeFile, chmod, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { githubAppJwt } from "../../lib/collab/git/github-client";
import { privateKey, sealGitHubKey, openGitHubKey, publicKeyFingerprint, githubMasterKey, readPrivateGitHubFile } from "../../lib/collab/git/github-credentials";
import { githubId, githubBranch } from "../../lib/collab/git/github-schema";

test("RSA app JWT uses verified claims; credentials are authenticated to organization, installation and connection identity", async () => {
  const jwt = githubAppJwt(config, pair.privateKey, 1700000000000), parts = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(parts[1], "base64url").toString()), { iat: 1699999940, exp: 1700000540, iss: "123" });
  assert.equal(verify("RSA-SHA256", Buffer.from(parts.slice(0, 2).join(".")), pair.publicKey, Buffer.from(parts[2], "base64url")), true);
  const master = randomBytes(32), context = { ...config, organizationId: randomUUID(), connectionId: randomUUID() }, sealed = sealGitHubKey(master, context, pair.privateKey);
  assert.equal(publicKeyFingerprint(openGitHubKey(master, context, sealed)), publicKeyFingerprint(pair.privateKey));
  for (const change of [{ organizationId: randomUUID() }, { connectionId: randomUUID() }, { installationId: "999" }, { accountId: "999" }, { appId: "999" }]) assert.throws(() => openGitHubKey(master, { ...context, ...change }, sealed), /github_credential_unavailable/);
  assert.throws(() => openGitHubKey(randomBytes(32), context, sealed), /github_credential_unavailable/);
  assert.throws(() => privateKey(generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ type: "pkcs8", format: "pem" })), /github_invalid_private_key/);
  assert.throws(() => privateKey(generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" })), /github_invalid_private_key/);
  for (const id of ["01", "9007199254740992", "-1", "1/../../app", ""]) assert.equal(githubId.safeParse(id).success, false);
  for (const branch of ["../x", "a.lock/x", "a//b", "a@{b", "a b", "a\\b", ".x", "a/."]) assert.equal(githubBranch.safeParse(branch).success, false);
});

test("explicit private files reject symlinks, broad permissions and wrong master lengths without reading personal configuration", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-collab-github-key-"));
  try {
    const file = path.join(root, "master"), key = await githubMasterKey(file, true); assert.equal(key.length, 32); assert.deepEqual(await githubMasterKey(file), key);
    await symlink(file, path.join(root, "link")); await assert.rejects(readPrivateGitHubFile(path.join(root, "link")));
    await chmod(file, 0o644); await assert.rejects(githubMasterKey(file), /github_private_file_required/); await chmod(file, 0o600);
    await writeFile(file, Buffer.alloc(31)); await assert.rejects(githubMasterKey(file), /github_master_key_unavailable/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("real HTTP fixture verifies app identity, one-repository read scope, exact default SHA and token revocation; protected boolean never grants merge", async () => {
  const f = await githubFixture();
  try {
    const result = await f.client.inspectRepository("1011");
    assert.equal(result.targetSha, f.state.sha); assert.equal(result.repositoryId, "1011"); assert.equal(result.htmlUrl, "https://github.com/example-org/example-repo");
    assert.equal(result.capabilities.protectedMerge, false); assert.equal(result.capabilities.push, false); assert.equal(result.branchProtected, true); assert.equal(f.state.revoked, 1);
    assert.ok(f.calls.some(c => c.route === "/repos/example-org/example-repo/branches/feature%2F%E4%B8%AD%E6%96%87"));
    assert.equal(JSON.stringify(result).includes("BEGIN PRIVATE KEY"), false); assert.equal("token" in result, false);
    f.state.visibility = undefined; assert.equal((await f.client.inspectRepository("1011")).visibility, "unknown");
    f.state.name = "renamed-repo"; const renamed = await f.client.inspectRepository("1011"); assert.equal(renamed.repositoryId, result.repositoryId); assert.equal(renamed.htmlUrl, "https://github.com/example-org/renamed-repo");
  } finally { await f.close(); }
});

test("wrong installation, suspension, repository scope, extra permissions, expiry and inactive repositories fail closed", async () => {
  for (const mutation of [
    { accountId: 999 }, { appId: 999 }, { suspended: true }, { repositoryId: 1012 }, { repositoryCount: 2 },
    { permissions: { contents: "write" } }, { permissions: { contents: "read", issues: "write" } },
    { expiresAt: new Date(0).toISOString() }, { archived: true },
  ]) {
    const f = await githubFixture(); Object.assign(f.state, mutation);
    try { await assert.rejects(f.client.inspectRepository("1011"), /^Error: github_/); if (f.calls.some(c => c.method === "POST")) assert.equal(f.state.revoked, 1); }
    finally { await f.close(); }
  }
});

test("redirects, rate limits, oversized replies, lost token responses and revocation failures do not leak responses or automatically retry", async () => {
  for (const mode of ["redirect", "rate", "oversize", "token-cut", "revoke"]) {
    const f = await githubFixture(); f.state.fail = mode;
    try {
      await assert.rejects(f.client.inspectRepository("1011"), error => /^github_[a-z_]+$/.test((error as Error).message));
      assert.ok(f.calls.filter(c => c.method === "POST").length <= 1); assert.ok(f.calls.every(c => !c.route.includes("credential")));
    } finally { await f.close(); }
  }
});

test("caller cancellation stops the read and still revokes the scoped token using an independent cleanup signal", async () => {
  const f = await githubFixture(), controller = new AbortController();
  f.state.fail = "cancel"; f.state.afterBranch = async () => controller.abort();
  try { await assert.rejects(f.client.inspectRepository("1011", controller.signal), /github_request_cancelled/); assert.equal(f.state.revoked, 1); }
  finally { await f.close(); }
});
