import assert from "node:assert/strict";
import { randomBytes, verify, type KeyObject } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { managedGit } from "../../../lib/collab/git/github-pack";
import { GitHubTaskPullClient, type TaskPullAttempt } from "../../../lib/collab/git/github-task-pull";
import { config, pair } from "./github";

/** Generated authentication and an actual loopback REST server, reading real
 * Git refs. PRs are explicit protocol fixtures, not external GitHub objects. */
export async function githubPullFixture(root: string, attempt: TaskPullAttempt, purpose: "create" | "preview" | "observe" | "checks" | "ready" | "merge" = "create", keys: { privateKey: KeyObject; publicKey: KeyObject } = pair, app = config) {
  const binding = attempt.binding, token = `ghs_${randomBytes(72).toString("base64url")}.fixture`;
  const calls: { method: string; route: string; body: unknown }[] = [], created: Record<string, unknown>[] = [];
  const state = { releases: 0, rules: [] as unknown[], protection: { enforce_admins: { enabled: true }, required_status_checks: { strict: true, contexts: ["build"] }, required_pull_request_reviews: { dismiss_stale_reviews: true, required_approving_review_count: 1, require_last_push_approval: true, bypass_pull_request_allowances: { users: [], teams: [], apps: [] } } } as Record<string,unknown>, checkReads: 0, installChecks: "read", checks: [{ id: 71001, name: "build", head_sha: attempt.intent.headSha,
    app: { id: 41234 }, check_suite: { id: 81001 }, status: "completed", conclusion: "success",
    started_at: new Date(Date.now()-2000).toISOString(), completed_at: new Date(Date.now()-1000).toISOString() }] as Record<string, unknown>[],
    beforeChecks: undefined as (() => Promise<void>) | undefined, issued: 0, revoked: 0, creates: 0, reads: 0, repositoryId: Number(binding.githubRepositoryId), nodeId: binding.nodeId, ownerId: Number(binding.ownerId),
    owner: binding.ownerLogin, name: binding.name, private: binding.private, visibility: binding.visibility as string | undefined, defaultBranch: binding.defaultBranch,
    archived: false, disabled: false, repositoryCount: 1, accountId: Number(app.accountId), appId: Number(app.appId), suspended: false,
    permissions: { ...(purpose === "checks" ? { checks: "read" } : {}), ...(purpose === "merge" ? { administration: "read" } : {}), contents: purpose === "merge" ? "write" : "read", pull_requests: ["create","ready","merge"].includes(purpose) ? "write" : "read", metadata: "read" } as Record<string, string>, installPulls: "write", installContents: "write",
    expiresAt: new Date(Date.now() + 3600000).toISOString(), fail: "", existing: false, number: 17, refType: "commit", mutateCreate: {} as Record<string, unknown>, mutateRead: {} as Record<string, unknown>,
    afterList: undefined as (() => Promise<void>) | undefined, beforeCreate: undefined as (() => Promise<void>) | undefined,
    afterCreate: undefined as (() => Promise<void>) | undefined, beforeRead: undefined as (() => Promise<void>) | undefined };
  const repo = () => ({ id: state.repositoryId, node_id: state.nodeId, owner: { id: state.ownerId, login: state.owner }, name: state.name,
    default_branch: state.defaultBranch, archived: state.archived, disabled: state.disabled, private: state.private, visibility: state.visibility });
  const ref = async (name: string) => {
    const value = await managedGit(path.join(root, "source.git"), ["rev-parse", "--verify", name], AbortSignal.timeout(10000), { codes: [0, 128] });
    return value.code === 0 ? value.bytes.toString().trim() : null;
  };
  const pointer = async (branch: string) => ({ ref: branch, sha: await ref(`refs/heads/${branch}`), repo: repo() });
  const pull = async (body: Record<string, unknown>, number = 17) => ({ id: 9100 + number, node_id: `PR_fixture_${number}`, number,
    html_url: `https://github.com/${binding.ownerLogin}/${binding.name}/pull/${number}`, title: body.title, body: body.body,
    state: "open", draft: body.draft, merged: false, maintainer_can_modify: body.maintainer_can_modify,
    head: await pointer(String(body.head)), base: await pointer(String(body.base)), merge_commit_sha: null, updated_at: new Date().toISOString() });
  const server = createServer((req, res) => { void (async () => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null, route = req.url!, method = req.method!;
    calls.push({ method, route, body }); const bearer = (req.headers.authorization ?? "").slice(7);
    if (route === "/app" || route.startsWith("/app/installations/")) {
      const parts = bearer.split("."); assert.equal(parts.length, 3);
      assert.equal(verify("RSA-SHA256", Buffer.from(parts.slice(0, 2).join(".")), keys.publicKey, Buffer.from(parts[2], "base64url")), true);
      const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString()); assert.equal(claims.iss, app.appId); assert.ok(claims.exp > Date.now() / 1000);
    } else { assert.equal(bearer === token, true, "generated scoped fixture token required"); assert.equal(state.revoked, 0); }
    assert.equal(req.headers["x-github-api-version"], "2022-11-28");
    const send = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (state.fail === "redirect" && route === "/app") { res.writeHead(302, { Location: "https://untrusted.invalid/token" }); res.end(); return; }
    if (route === "/app") send(200, { id: state.appId, slug: "collaboration" });
    else if (route === `/app/installations/${app.installationId}`) send(200, { id: Number(app.installationId), app_id: state.appId, account: { id: state.accountId, login: state.owner, type: "Organization" },
      suspended_at: state.suspended ? new Date().toISOString() : null, repository_selection: "selected", permissions: { ...(purpose === "checks" ? { checks: state.installChecks } : {}), ...(purpose === "merge" ? { administration: "read" } : {}), contents: state.installContents, pull_requests: state.installPulls, metadata: "read" } });
    else if (route === `/app/installations/${app.installationId}/access_tokens` && method === "POST") {
      assert.deepEqual(body, { repository_ids: [Number(binding.githubRepositoryId)], permissions: { ...(purpose === "checks" ? { checks: "read" } : {}), ...(purpose === "merge" ? { administration: "read" } : {}), contents: purpose === "merge" ? "write" : "read", pull_requests: ["create","ready","merge"].includes(purpose) ? "write" : "read" } }); state.issued++;
      if (state.fail === "token-cut") { res.destroy(); return; }
      send(201, { token, expires_at: state.expiresAt, permissions: state.permissions });
    } else if (route === "/installation/token" && method === "DELETE") {
      if (state.fail.includes("revoke")) send(503, { token }); else { state.revoked++; res.writeHead(204); res.end(); }
    } else if (route === "/installation/repositories?per_page=2&page=1") send(200, { total_count: state.repositoryCount, repositories: [repo()] });
    else if (route === `/repositories/${binding.githubRepositoryId}`) send(state.fail === "repository-missing" ? 404 : 200, repo());
    else {
      const prefix = `/repos/${state.owner}/${state.name}`, pulls = `${prefix}/pulls`;
      if (purpose === "merge" && route === `${prefix}/rules/branches/${encodeURIComponent(attempt.request.base)}?per_page=100&page=1`) send(200,state.rules);
      else if (purpose === "merge" && route === `${prefix}/branches/${encodeURIComponent(attempt.request.base)}/protection`) send(200,state.protection);
      else if (purpose === "ready" && route === "/graphql" && method === "POST") {
        assert.equal(body.variables.id,created[0].node_id); state.releases++; created[0].draft=false;
        if(state.fail === "release-cut") { res.destroy(); return; }
        send(200,{data:{markPullRequestReadyForReview:{pullRequest:{id:created[0].node_id,isDraft:false,headRefOid:attempt.intent.headSha,baseRefOid:attempt.intent.baseSha}}}});
      } else if (purpose === "merge" && route === `${pulls}/${state.number}/merge` && method === "PUT") {
        state.releases++; assert.deepEqual(body,{sha:attempt.intent.headSha,merge_method:"merge"});
        if(state.fail === "merge-rejected") {send(405,{message:"Protected branch requirements not met"});return;}
        const directory=path.join(root,"source.git"), signal=AbortSignal.timeout(10000);
        const tree=(await managedGit(directory,["rev-parse",`${attempt.intent.headSha}^{tree}`],signal)).bytes.toString().trim();
        const merged=(await managedGit(directory,["-c","user.name=Merge fixture","-c","user.email=merge@test.invalid","commit-tree",tree,"-p",attempt.intent.baseSha,"-p",attempt.intent.headSha,"-m","Merge reviewed change"],signal)).bytes.toString().trim();
        await managedGit(directory,["update-ref",`refs/heads/${attempt.request.base}`,merged,attempt.intent.baseSha],signal);
        created[0].merged=true;created[0].state="closed";created[0].merge_commit_sha=merged;
        if(state.fail === "release-cut") {res.destroy();return;}
        send(200,{merged:true,sha:merged,message:"Merged"});
      } else if (purpose === "checks" && route.startsWith(`${prefix}/commits/${attempt.intent.headSha}/check-runs?`)) {
        assert.equal(method, "GET"); const url = new URL(route, "http://fixture");
        assert.equal(url.searchParams.get("filter"), "latest"); assert.equal(url.searchParams.get("per_page"), "100");
        const page = Number(url.searchParams.get("page")); assert.ok(page>=1 && page<=10); state.checkReads++; await state.beforeChecks?.();
        send(200, { total_count: state.checks.length, check_runs: state.checks.slice((page-1)*100,page*100) });
      } else if (route === `${prefix}/branches/${encodeURIComponent(attempt.request.base)}`) send(200, { name: state.defaultBranch, protected: true, commit: { sha: await ref(`refs/heads/${attempt.request.base}`) } });
      else if (route === `${prefix}/git/ref/heads/${encodeURIComponent(attempt.request.head)}`) {
        const oid = await ref(attempt.ref); send(oid ? 200 : 404, { ref: attempt.ref, object: { type: state.refType, sha: oid } });
      } else if (route === `${pulls}?state=open&head=${encodeURIComponent(`${binding.ownerLogin}:${attempt.request.head}`)}&base=${encodeURIComponent(attempt.request.base)}&per_page=2&page=1` && method === "GET") {
        const value = state.existing ? [await pull(attempt.request, 16)] : []; await state.afterList?.(); send(200, value);
      } else if (route === pulls && method === "POST") {
        assert.equal(purpose, "create");
        state.creates++; assert.deepEqual(body, attempt.request); await state.beforeCreate?.();
        if (state.fail === "validation") { send(422, { token, message: "fixture rejection" }); return; }
        if (state.fail === "create-forbidden") { send(403, { token, message: "fixture denial" }); return; }
        const value = await pull(body, state.number); created.push(value); await state.afterCreate?.();
        if (state.fail.includes("create-cut")) { res.destroy(); return; }
        if (state.fail === "create-redirect") { res.writeHead(302, { Location: "https://untrusted.invalid/pull" }); res.end(); return; }
        send(201, { ...value, ...state.mutateCreate });
      } else if (route === `${pulls}/${state.number}` && method === "GET") {
        state.reads++; await state.beforeRead?.();
        if (state.fail === "read-missing") { send(404, { token }); return; }
        if (state.fail === "read-cut") { res.destroy(); return; }
        if (state.fail === "read-large") { send(200, { body: "x".repeat(2 * 1024 * 1024) }); return; }
        assert.equal(created.length, 1); const value = created[0];
        send(200, { ...value, ...(purpose === "merge" ? { mergeable: true, mergeable_state: "clean" } : {}), head: await pointer(attempt.request.head), base: await pointer(attempt.request.base), ...state.mutateRead });
      } else send(404, { token });
    }
  })().catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); assert.equal(url.origin, "https://api.github.com"); assert.equal(init?.redirect, "error");
    return fetch(`${origin}${url.pathname}${url.search}`, init);
  };
  return { state, calls, created, transport, client: new GitHubTaskPullClient(app, keys.privateKey, transport),
    async seedObservation() { assert.ok(["observe", "checks", "ready", "merge"].includes(purpose)); assert.equal(created.length, 0); created.push(await pull(attempt.request, state.number)); },
    containsCredential(value: unknown) { return JSON.stringify(value).includes(token) || JSON.stringify(value).includes(keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString()); },
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
