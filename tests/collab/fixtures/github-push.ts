import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes, verify, type KeyObject } from "node:crypto";
import { managedGit } from "../../../lib/collab/git/github-pack";
import { GitHubTaskPushClient, type GitHubPushBinding } from "../../../lib/collab/git/github-task-push";
import { GitHubReadClient } from "../../../lib/collab/git/github-client";
import { taskPushFixture } from "./task-push";
import { config, pair } from "./github";
import path from "node:path";

/** Generated credentials and a real HTTP REST fixture wrap a real Git receiver.
 * No personal auth source, external account or returned success stub is used. */
export async function githubPushFixture(root: string, binding: GitHubPushBinding, ref: string, scope: "read" | "write" = "write", keys: { privateKey: KeyObject; publicKey: KeyObject } = pair, app = config) {
  const git = await taskPushFixture(root), calls: { method: string; route: string; body: unknown }[] = [];
  const token = `ghs_123_${randomBytes(72).toString("base64url")}.fixture`, keyText = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const state = { repositoryId: Number(binding.githubRepositoryId), nodeId: binding.nodeId, ownerId: Number(binding.ownerId), owner: binding.ownerLogin, name: binding.name,
    accountId: Number(app.accountId), appId: Number(app.appId), repositoryCount: 1, private: binding.private, visibility: binding.visibility as string | undefined, defaultBranch: binding.defaultBranch,
    archived: false, disabled: false, suspended: false, installContents: "write", protected: false, rules: [] as unknown[], refType: "commit", fail: "", revoked: 0, issued: 0,
    permissions: { contents: scope, metadata: "read" } as Record<string, string>, expiresAt: new Date(Date.now() + 3600000).toISOString(),
    afterAdvertise: undefined as (() => Promise<void>) | undefined };
  const repo = () => ({ id: state.repositoryId, node_id: state.nodeId, owner: { id: state.ownerId, login: state.owner }, name: state.name,
    default_branch: state.defaultBranch, archived: state.archived, disabled: state.disabled, private: state.private, visibility: state.visibility, clone_url: "file:///untrusted/credential" });
  const readRef = async (name: string) => {
    const result = await managedGit(path.join(root, "source.git"), ["rev-parse", "--verify", name], AbortSignal.timeout(10000), { codes: [0, 128] });
    return result.code === 0 ? result.bytes.toString().trim() : null;
  };
  const server = createServer((req, res) => { void (async () => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null, route = req.url!;
    calls.push({ method: req.method!, route, body });
    const bearer = (req.headers.authorization ?? "").slice(7);
    if (route === "/app" || route.startsWith("/app/installations/")) {
      const parts = bearer.split("."); assert.equal(parts.length, 3);
      assert.equal(verify("RSA-SHA256", Buffer.from(parts.slice(0, 2).join(".")), keys.publicKey, Buffer.from(parts[2], "base64url")), true);
      const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString()); assert.equal(claims.iss, app.appId); assert.ok(claims.exp > Date.now() / 1000);
    } else assert.equal(bearer === token, true, "scoped fixture token required");
    assert.equal(req.headers["x-github-api-version"], "2022-11-28");
    const send = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (state.fail === "redirect" && route === "/app") { res.writeHead(302, { Location: "https://untrusted.invalid/token" }); res.end(); return; }
    if (state.fail === "rate" && route === "/app") { res.writeHead(403, { "x-ratelimit-remaining": "0" }); res.end(token); return; }
    if (route === "/app") send(200, { id: state.appId, slug: "collaboration" });
    else if (route === `/app/installations/${app.installationId}`) send(200, { id: Number(app.installationId), app_id: state.appId, account: { id: state.accountId, login: state.owner, type: "Organization" },
      suspended_at: state.suspended ? new Date().toISOString() : null, repository_selection: "selected", permissions: { contents: state.installContents, pull_requests: "write", metadata: "read" } });
    else if (route === `/app/installations/${app.installationId}/access_tokens` && req.method === "POST") {
      assert.deepEqual(body, { repository_ids: [Number(binding.githubRepositoryId)], permissions: { contents: scope } }); state.issued++;
      if (state.fail === "token-cut") { res.destroy(); return; }
      send(201, { token, expires_at: state.expiresAt, permissions: state.permissions });
    } else if (route === "/installation/token" && req.method === "DELETE") {
      if (state.fail === "revoke") send(503, { token }); else { state.revoked++; res.writeHead(204); res.end(); }
    } else if (route === "/installation/repositories?per_page=2&page=1") send(200, { total_count: state.repositoryCount, repositories: [repo()] });
    else if (route === `/repositories/${binding.githubRepositoryId}`) send(state.fail === "repository-missing" ? 404 : 200, repo());
    else {
      const prefix = `/repos/${state.owner}/${state.name}`, branch = ref.slice("refs/heads/".length);
      if (route === `${prefix}/branches/${encodeURIComponent(state.defaultBranch)}`) send(200, { name: state.defaultBranch, protected: true, commit: { sha: await readRef(`refs/heads/${state.defaultBranch}`) } });
      else if (route === `${prefix}/git/ref/heads/${encodeURIComponent(branch)}`) {
        const oid = await readRef(ref); send(oid ? 200 : 404, oid ? { ref, object: { type: state.refType, sha: oid } } : {});
      } else if (route === `${prefix}/branches/${encodeURIComponent(branch)}`) {
        const oid = await readRef(ref); send(oid ? 200 : 404, oid ? { name: branch, protected: state.protected, commit: { sha: oid } } : {});
      } else if (route === `${prefix}/rules/branches/${encodeURIComponent(branch)}?per_page=100&page=1`) {
        if (state.fail === "rules-missing") send(404, { token });
        else if (state.fail === "rules-large") send(200, ["x".repeat(2 * 1024 * 1024)]);
        else send(200, state.rules);
      } else send(404, {});
    }
  })().catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const api = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); assert.equal(init?.redirect, "error");
    if (url.origin === "https://api.github.com") return fetch(`${api}${url.pathname}${url.search}`, init);
    assert.equal(url.origin, "https://github.com"); assert.equal(new Headers(init?.headers).get("authorization") === `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`, true);
    const prefix = `/${state.owner}/${state.name}.git/`;
    assert.equal(url.pathname.startsWith(prefix), true); assert.equal(state.revoked, 0);
    if (scope === "read") {
      assert.equal(new Headers(init?.headers).get("git-protocol"), "version=2");
      const kind = url.pathname === `${prefix}info/refs` && url.search === "?service=git-upload-pack" ? "advertise"
        : url.pathname === `${prefix}git-upload-pack` && !url.search ? "upload" : null;
      assert.ok(kind); assert.equal(init?.method, kind === "advertise" ? "GET" : "POST");
      return git.readTransport(kind, init?.body ? new Uint8Array(init.body as Uint8Array) : undefined,
        new Headers(init?.headers).get("content-encoding") === "gzip", init!.signal!);
    }
    assert.equal(new Headers(init?.headers).has("git-protocol"), false);
    const kind = url.pathname === `${prefix}info/refs` && url.search === "?service=git-receive-pack" ? "advertise"
      : url.pathname === `${prefix}git-receive-pack` && !url.search ? "receive" : null;
    assert.ok(kind); assert.equal(init?.method, kind === "advertise" ? "GET" : "POST");
    const response = await git.transport(kind, init!.signal!, kind === "receive" ? new Uint8Array(init!.body as Uint8Array) : undefined);
    if (kind === "advertise") await state.afterAdvertise?.(); return response;
  };
  return { state, calls, git, transport, client: new GitHubTaskPushClient(app, keys.privateKey, transport), readClient: new GitHubReadClient(app, keys.privateKey, transport),
    containsCredential(value: unknown) { const text = JSON.stringify(value); return text.includes(token) || text.includes(keyText) || text.includes(Buffer.from(`x-access-token:${token}`).toString("base64")); },
    async close() { await git.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
