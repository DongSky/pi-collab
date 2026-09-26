import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { runnerEnvironment } from "../../../lib/collab/runtime/workspace";
import type { TaskPushTransport } from "../../../lib/collab/git/task-push-protocol";
import type { GitHubGitRead } from "../../../lib/collab/git/github-client";

/** Disposable real Git receive-pack endpoint. No external GitHub account,
 * provider credentials, model inference or application data is involved. */
export async function taskPushFixture(root: string) {
  const calls = { advertise: 0, receive: 0, readAdvertise: 0, upload: 0 }, requests: Buffer[] = [];
  const state = { beforeReceive: undefined as (() => Promise<void>) | undefined, afterReceive: undefined as (() => void) | undefined, loseReply: false,
    afterUpload: undefined as (() => Promise<void>) | undefined };
  const processes = new Set<ReturnType<typeof spawn>>();
  const server = createServer((req, res) => { void (async () => {
    const kind = req.method === "GET" && req.url === "/source.git/info/refs?service=git-receive-pack" ? "advertise"
      : req.method === "POST" && req.url === "/source.git/git-receive-pack" ? "receive"
      : req.method === "GET" && req.url === "/source.git/info/refs?service=git-upload-pack" ? "readAdvertise"
      : req.method === "POST" && req.url === "/source.git/git-upload-pack" ? "upload" : null;
    if (!kind) { res.writeHead(404); res.end(); return; } calls[kind]++;
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk); const body = Buffer.concat(chunks);
    if (kind === "receive") { requests.push(body); await state.beforeReceive?.(); }
    const url = new URL(req.url!, "http://127.0.0.1");
    const child = spawn("git", ["-c", "core.hooksPath=/dev/null", "http-backend"], { env: {
      ...runnerEnvironment("/nonexistent", "/nonexistent"), GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: "1", REMOTE_USER: "fixture", REMOTE_ADDR: "127.0.0.1",
      PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: req.method!, CONTENT_TYPE: req.headers["content-type"] ?? "", CONTENT_LENGTH: String(body.length),
      ...(req.headers["git-protocol"] ? { HTTP_GIT_PROTOCOL: String(req.headers["git-protocol"]) } : {}),
    }, stdio: "pipe" });
    processes.add(child); const output: Buffer[] = [];
    child.stdout.on("data", chunk => output.push(chunk)); child.stderr.resume(); child.stdin.on("error", () => {}); child.stdin.end(body);
    child.once("error", () => { if (!res.headersSent) res.writeHead(500); res.end(); });
    child.once("close", () => { void (async () => {
      processes.delete(child);
      if (kind === "upload") await state.afterUpload?.();
      if (kind === "receive") state.afterReceive?.();
      if (kind === "receive" && state.loseReply) { res.destroy(); return; }
      const bytes = Buffer.concat(output), split = bytes.indexOf("\r\n\r\n");
      if (split < 0) { res.writeHead(500); res.end(); return; }
      const headers: Record<string, string> = {}; let status = 200;
      for (const row of bytes.subarray(0, split).toString().split("\r\n")) {
        const end = row.indexOf(":"), name = row.slice(0, end), value = row.slice(end + 1).trim();
        if (name.toLowerCase() === "status") status = parseInt(value); else headers[name] = value;
      }
      res.writeHead(status, headers); res.end(bytes.subarray(split + 4));
    })().catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); });
  })().catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/source.git`;
  const transport: TaskPushTransport = (kind, signal, body) => fetch(base + (kind === "advertise" ? "/info/refs?service=git-receive-pack" : "/git-receive-pack"), {
    method: kind === "advertise" ? "GET" : "POST", signal, redirect: "error",
    ...(kind === "receive" ? { headers: { "Content-Type": "application/x-git-receive-pack-request" }, body: new Uint8Array(body!) } : {}),
  });
  const readTransport: GitHubGitRead = (kind, body, compressed, signal) => fetch(base + (kind === "advertise" ? "/info/refs?service=git-upload-pack" : "/git-upload-pack"), {
    method: kind === "advertise" ? "GET" : "POST", signal, redirect: "error", headers: { "Git-Protocol": "version=2",
      ...(kind === "upload" ? { "Content-Type": "application/x-git-upload-pack-request", ...(compressed ? { "Content-Encoding": "gzip" } : {}) } : {}) },
    ...(body ? { body: new Uint8Array(body) } : {}),
  });
  return { calls, requests, state, transport, readTransport, async close() { for (const child of processes) child.kill("SIGKILL"); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
