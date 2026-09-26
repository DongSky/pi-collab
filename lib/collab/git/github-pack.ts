import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { runnerEnvironment } from "../runtime/workspace";
import { GitHubError } from "./github-credentials";
import type { GitHubGitRead, GitHubReadObservation } from "./github-client";

const PACK_LIMIT = 256 * 1024 * 1024;
/** No project shell, inherited Git config, credentials, hook or helper input.
 * A separate process group is stopped on cancellation/output limits. */
export function managedGit(directory: string, args: string[], signal: AbortSignal, options: { environment?: Record<string, string>; input?: Buffer | string; limit?: number; codes?: number[] } = {}): Promise<{ code: number; bytes: Buffer }> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new GitHubError("github_request_cancelled")); return; }
    const child = spawn("git", ["--no-pager", "--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.attributesFile=/dev/null",
      "-c", "protocol.allow=never", "-c", "core.fsync=committed", "-c", "core.fsyncMethod=fsync", "-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args], {
      cwd: directory, env: { ...runnerEnvironment("/nonexistent", "/nonexistent"), GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_CEILING_DIRECTORIES: directory, ...options.environment },
      detached: process.platform !== "win32", stdio: ["pipe", "pipe", "ignore"],
    });
    let failed = false, bytes = 0; const chunks: Buffer[] = [];
    const kill = () => {
      failed = true;
      if (!child.pid) return;
      try { if (process.platform === "win32") child.kill("SIGKILL"); else process.kill(-child.pid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") failed = true; }
    };
    signal.addEventListener("abort", kill, { once: true }); const timer = setTimeout(kill, 180_000);
    child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > (options.limit ?? 64 * 1024)) kill(); else chunks.push(chunk); });
    child.stdin.on("error", () => {}); child.stdin.end(options.input);
    child.once("error", () => { failed = true; });
    child.once("close", async code => {
      clearTimeout(timer); signal.removeEventListener("abort", kill);
      // Never publish a receipt while a normal Git descendant may still write.
      if (process.platform !== "win32" && child.pid) {
        const alive = () => { try { process.kill(-child.pid!, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; } };
        if (alive()) { kill(); const deadline = Date.now() + 2000; while (alive() && Date.now() < deadline) await new Promise(r => setTimeout(r, 25)); }
        if (alive()) { reject(new GitHubError("github_git_exit_unconfirmed")); return; }
      }
      if (failed || code === null || !(options.codes ?? [0]).includes(code)) reject(new GitHubError(signal.aborted ? "github_request_cancelled" : "github_git_failed"));
      else resolve({ code, bytes: Buffer.concat(chunks) });
    });
  });
}

export async function importGit(directory: string, args: string[], signal: AbortSignal, extra: Record<string, string> = {}) {
  return (await managedGit(directory, args, signal, { environment: extra })).bytes.toString("utf8");
}

/** Per-transfer loopback relay: Git only receives a local one-time capability.
 * Only upload-pack advertisement/POST are forwarded, using a fixed upstream
 * callback; no GitHub token enters Git's argv, environment, config or stderr. */
export async function gitReadRelay(read: GitHubGitRead, signal: AbortSignal) {
  const secret = randomBytes(32).toString("hex"), expected = Buffer.from(`Bearer ${secret}`), stop = new AbortController();
  const active = new Set<Promise<void>>(); let host = "", remaining = PACK_LIMIT, requests = 0, failure: GitHubError | undefined;
  const server = createServer((req, res) => {
    const work = (async () => {
      const supplied = Buffer.from(req.headers.authorization ?? "");
      const kind = req.method === "GET" && req.url === "/repo.git/info/refs?service=git-upload-pack" ? "advertise"
        : req.method === "POST" && req.url === "/repo.git/git-upload-pack" ? "upload" : null;
      if (!kind || req.headers.host !== host || req.headers.origin || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(403); res.end(); return; }
      if (++requests > 16 || active.size >= 2 || (req.headers["content-encoding"] && req.headers["content-encoding"] !== "gzip")) { res.writeHead(429); res.end(); return; }
      const cancelled = new AbortController(), combined = AbortSignal.any([signal, stop.signal, cancelled.signal]);
      const abort = () => { if (!res.writableFinished) cancelled.abort(); }; res.once("close", abort); req.once("aborted", abort);
      try {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 4 * 1024 * 1024) throw new GitHubError("github_git_request_too_large"); chunks.push(chunk); }
        if (kind === "advertise" && size) throw new GitHubError("github_git_scope_invalid");
        const upstream = await read(kind, kind === "upload" ? Buffer.concat(chunks) : undefined, req.headers["content-encoding"] === "gzip", combined);
        if (!upstream.body || Number(upstream.headers.get("content-length")) > remaining) { await upstream.body?.cancel(); throw new GitHubError("github_git_pack_too_large"); }
        res.writeHead(200, { "Content-Type": upstream.headers.get("content-type")!, "Cache-Control": "no-store" });
        await pipeline(Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]), new Transform({ transform(chunk, _encoding, done) {
          remaining -= chunk.length; done(remaining < 0 ? new GitHubError("github_git_pack_too_large") : null, chunk);
        } }), res);
      } finally { res.removeListener("close", abort); req.removeListener("aborted", abort); cancelled.abort(); }
    })().catch(error => {
      failure ??= error instanceof GitHubError ? error : new GitHubError("github_git_transport_unavailable");
      if (!res.headersSent) { res.writeHead(502); res.end(); } else res.destroy();
    }).finally(() => { active.delete(work); });
    active.add(work);
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  host = `127.0.0.1:${(server.address() as { port: number }).port}`;
  const abort = () => { stop.abort(); server.closeAllConnections(); }; signal.addEventListener("abort", abort, { once: true });
  return { url: `http://${host}/repo.git`, environment: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${secret}` },
    assertHealthy() { if (failure) throw failure; }, async close() { signal.removeEventListener("abort", abort); abort(); await new Promise<void>(resolve => server.close(() => resolve())); await Promise.all(active); } };
}

export async function downloadGitHubGit(directory: string, evidence: Pick<GitHubReadObservation, "defaultBranch" | "targetSha">, read: GitHubGitRead, signal: AbortSignal) {
  await mkdir(directory, { mode: 0o700 });
  await importGit(directory, ["init", "--bare", "--object-format=sha1", "--template=", "git"], signal);
  const git = path.join(directory, "git"), ref = `refs/heads/${evidence.defaultBranch}`, relay = await gitReadRelay(read, signal);
  try {
    await importGit(git, ["-c", "protocol.http.allow=always", "-c", "protocol.version=2", "-c", "http.followRedirects=false", "-c", "http.proxy=", "-c", "credential.helper=",
      "-c", "fetch.fsckObjects=true", "-c", "transfer.fsckObjects=true", "fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--no-auto-maintenance", "--", relay.url, `${ref}:${ref}`], signal, relay.environment);
    relay.assertHealthy();
  } catch (error) { relay.assertHealthy(); throw error; }
  finally { await relay.close(); }
  await verifyImportedGit(directory, evidence, signal);
  await importGit(git, ["symbolic-ref", "HEAD", ref], signal);
}

export async function verifyImportedGit(directory: string, evidence: Pick<GitHubReadObservation, "defaultBranch" | "targetSha">, signal: AbortSignal) {
  const git = path.join(directory, "git");
  if ((await importGit(git, ["rev-parse", "--verify", `refs/heads/${evidence.defaultBranch}^{commit}`], signal)).trim() !== evidence.targetSha) throw new GitHubError("github_git_baseline_mismatch");
  if ((await importGit(git, ["rev-parse", "--is-shallow-repository"], signal)).trim() !== "false") throw new GitHubError("github_git_history_incomplete");
  await importGit(git, ["fsck", "--strict", "--full", "--no-reflogs"], signal);
}

// The transport-neutral verifier is also used by the GitLab adapter.
export { downloadGitHubGit as downloadVerifiedGit };
