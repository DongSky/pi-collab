import assert from "node:assert/strict";
import { generateKeyPairSync, verify, randomBytes, type KeyObject } from "node:crypto";
import { createServer } from "node:http";
import { GitHubReadClient } from "../../../lib/collab/git/github-client";
export const config = { appId: "123", installationId: "456", accountId: "789" };
export const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
export async function githubFixture(repositoryId = 1011, keys: { privateKey: KeyObject; publicKey: KeyObject } = pair, app = config) {
  const secret = keys.privateKey.export({ type: "pkcs8", format: "pem" });
  const calls: { method: string; route: string; body: unknown }[] = [];
  const state = { accountId: Number(app.accountId), appId: Number(app.appId), repositoryId, repositoryCount: 1, visibility: "private" as string | undefined, permissions: { contents: "read", metadata: "read" } as Record<string, string>, expiresAt: new Date(Date.now() + 3600000).toISOString(), suspended: false, archived: false, owner: "example-org", name: "example-repo", branch: "feature/中文", sha: "a".repeat(40), fail: "", revoked: 0, afterInstallation: undefined as (() => Promise<void>) | undefined, afterBranch: undefined as (() => Promise<void>) | undefined };
  const token = randomBytes(32).toString("hex");
  const server = createServer((req, res) => { void (async () => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    calls.push({ method: req.method!, route: req.url!, body });
    const bearer = (req.headers.authorization ?? "").slice(7);
    const appRoute = req.url === "/app" || req.url?.startsWith("/app/installations/");
    if (appRoute) {
      const parts = bearer.split("."); assert.equal(parts.length, 3);
      assert.equal(verify("RSA-SHA256", Buffer.from(parts.slice(0, 2).join(".")), keys.publicKey, Buffer.from(parts[2], "base64url")), true);
      const p = JSON.parse(Buffer.from(parts[1], "base64url").toString()); assert.equal(p.iss, app.appId); assert.ok(p.iat < Date.now() / 1000 && p.exp > Date.now() / 1000);
    } else assert.equal(bearer === token, true, "Only the scoped token may call repository endpoints");
    assert.equal(req.headers["x-github-api-version"], "2022-11-28");
    const send = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (state.fail === "redirect" && req.url === "/app") { res.writeHead(302, { Location: "https://untrusted.invalid/credential" }); res.end(); return; }
    if (state.fail === "rate" && req.url === "/app") { res.writeHead(403, { "x-ratelimit-remaining": "0" }); res.end(token); return; }
    if (state.fail === "oversize" && req.url === "/app") { res.writeHead(200, { "Content-Type": "application/json" }); res.end('"' + "x".repeat(2 * 1024 * 1024) + '"'); return; }
    if (req.url === "/app") send(200, { id: state.appId, slug: "collaboration" });
    else if (req.url === `/app/installations/${app.installationId}`) { await state.afterInstallation?.(); send(200, { id: Number(app.installationId), app_id: state.appId, account: { id: state.accountId, login: state.owner, type: "Organization" }, suspended_at: state.suspended ? new Date().toISOString() : null, repository_selection: "selected", permissions: { contents: "write", pull_requests: "write", metadata: "read" } }); }
    else if (req.url === `/app/installations/${app.installationId}/access_tokens` && req.method === "POST") {
      assert.deepEqual(body, { repository_ids: [repositoryId], permissions: { contents: "read" } });
      if (state.fail === "token-cut") { res.destroy(); return; }
      send(201, { token, expires_at: state.expiresAt, permissions: state.permissions });
    } else if (req.url === "/installation/repositories?per_page=2&page=1") send(200, { total_count: state.repositoryCount, repositories: [{ id: state.repositoryId, node_id: "R_example", name: state.name, owner: { id: state.accountId, login: state.owner }, default_branch: state.branch, archived: state.archived, disabled: false, private: true, visibility: state.visibility, clone_url: "file:///forged/host/path" }] });
    else if (req.url?.includes("/branches/")) {
      await state.afterBranch?.();
      if (state.fail === "cancel") { await new Promise(resolve => setTimeout(resolve, 200)); }
      send(200, { name: state.branch, protected: true, commit: { sha: state.sha } });
    } else if (req.url === "/installation/token" && req.method === "DELETE") { if (state.fail === "revoke") send(503, { token }); else { state.revoked++; res.writeHead(204); res.end(); } }
    else send(404, {});
  })().catch(() => { res.writeHead(500); res.end(); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const transport: typeof fetch = (input, init) => { const url = new URL(String(input)); assert.equal(url.origin, "https://api.github.com"); return fetch(`${base}${url.pathname}${url.search}`, init); };
  return { state, calls, transport, client: new GitHubReadClient(app, keys.privateKey, transport), pem: Buffer.from(secret),
    authorizeGit(header: string | undefined) { return header === `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`; },
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
