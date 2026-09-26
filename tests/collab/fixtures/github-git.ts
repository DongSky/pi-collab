import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { githubFixture, config, pair } from "./github";
import { GitHubReadClient } from "../../../lib/collab/git/github-client";
import { runnerEnvironment } from "../../../lib/collab/runtime/workspace";

/** Real smart HTTP Git, not a fake downloaded file or precomputed verdict. */
export async function githubGitFixture(source: string, repositoryId = 1011, keys = pair) {
  const api = await githubFixture(repositoryId, keys), calls: string[] = [];
  const state = { fail: "", beforeGit: undefined as (() => Promise<void>) | undefined };
  const processes = new Set<ReturnType<typeof spawn>>();
  const server = createServer((req, res) => { void (async () => {
    assert.equal(api.authorizeGit(req.headers.authorization), true); assert.equal(req.headers["git-protocol"], "version=2");
    calls.push(req.url!); await state.beforeGit?.();
    if (state.fail === "redirect") { res.writeHead(302, { Location: "https://untrusted.invalid/pack" }); res.end(); return; }
    if (state.fail === "cut") { res.destroy(); return; }
    if (state.fail === "oversize") { res.writeHead(200, { "Content-Type": "application/x-git-upload-pack-advertisement", "Content-Length": String(300 * 1024 * 1024) }); res.flushHeaders(); return; }
    const url = new URL(req.url!, "http://localhost"), chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk); const body = Buffer.concat(chunks);
    const child = spawn("git", ["http-backend"], { env: { ...runnerEnvironment("/nonexistent", "/nonexistent"), GIT_PROJECT_ROOT: source, GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: req.method!, CONTENT_TYPE: req.headers["content-type"] ?? "", CONTENT_LENGTH: String(body.length), HTTP_GIT_PROTOCOL: "version=2", REMOTE_USER: "fixture", REMOTE_ADDR: "127.0.0.1" }, stdio: "pipe" });
    processes.add(child); let headers = Buffer.alloc(0), sent = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (sent) { res.write(chunk); return; }
      headers = Buffer.concat([headers, chunk]); const end = headers.indexOf("\r\n\r\n"); if (end < 0) return;
      const values: Record<string, string> = {}; let status = 200;
      for (const line of headers.subarray(0, end).toString().split("\r\n")) { const split = line.indexOf(":"); const name = line.slice(0, split), value = line.slice(split + 1).trim(); if (name.toLowerCase() === "status") status = parseInt(value); else values[name] = value; }
      res.writeHead(status, values); res.write(headers.subarray(end + 4)); sent = true;
    });
    child.stderr.resume(); child.stdin.on("error", () => {}); child.stdin.end(body);
    child.once("close", () => { processes.delete(child); res.end(); }); res.once("close", () => { if (!res.writableFinished) child.kill("SIGKILL"); });
  })().catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const transport: typeof fetch = (input, init) => {
    const url = new URL(String(input)); if (url.origin === "https://api.github.com") return api.transport(input, init);
    assert.equal(url.origin, "https://github.com"); assert.ok(url.pathname.startsWith(`/${api.state.owner}/${api.state.name}.git/`));
    const route = url.pathname.slice(`/${api.state.owner}/${api.state.name}.git`.length);
    return fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/source.git${route}${url.search}`, init);
  };
  return { api, calls, state, transport, client: new GitHubReadClient(config, keys.privateKey, transport),
    async close() { for (const process of processes) process.kill("SIGKILL"); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await api.close(); } };
}
