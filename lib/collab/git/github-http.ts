import { GitHubError } from "./github-credentials";

/** Internal fixed-host REST transport. Route/body inputs come only from typed
 * provider clients, never browser URLs. No redirects, mutation retries, provider
 * response bodies or credential-bearing transport errors escape this layer. */
export class GitHubHttp {
  constructor(private readonly transport: typeof fetch = fetch) {}
  async request(method: "GET" | "POST" | "PUT" | "DELETE", route: string, bearer: string, signal: AbortSignal, body?: unknown, allowMissing = false, expectedStatus?: 200 | 201) {
    if (!route.startsWith("/") || route.startsWith("//") || /[\r\n\x00]/.test(route) || (allowMissing && method !== "GET")) throw new GitHubError("github_invalid_route");
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(10000)]); let response: Response | undefined;
    try {
      response = await this.transport(`https://api.github.com${route}`, { method, signal: deadline, redirect: "error", headers: {
        Accept: "application/vnd.github+json", Authorization: `Bearer ${bearer}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "pi-collab/0.1",
        ...(body ? { "Content-Type": "application/json" } : {}),
      }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (allowMissing && response.status === 404) return null;
      if (!response.ok) {
        const rate = response.status === 429 || (response.status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after")));
        throw new GitHubError(rate ? "github_rate_limited" : response.status === 401 ? "github_authentication_failed" : [403, 404].includes(response.status) ? "github_access_unavailable" : "github_request_failed", response.status);
      }
      if (response.status !== (expectedStatus ?? (method === "POST" ? 201 : method === "DELETE" ? 204 : 200))) throw new GitHubError("github_invalid_response");
      if (method === "DELETE") return null;
      if (!/^application\/(?:json|[\w.+-]+\+json)(?:;|$)/i.test(response.headers.get("content-type") ?? "")) throw new GitHubError("github_invalid_response");
      if (Number(response.headers.get("content-length")) > 2 * 1024 * 1024 || !response.body) throw new GitHubError("github_response_too_large");
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      const stop = () => { void reader.cancel().catch(() => {}); }; deadline.addEventListener("abort", stop, { once: true });
      try {
        for (;;) {
          if (deadline.aborted) throw new GitHubError("github_request_cancelled");
          const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength; if (size > 2 * 1024 * 1024) throw new GitHubError("github_response_too_large"); chunks.push(part.value);
        }
        if (deadline.aborted) throw new GitHubError("github_request_cancelled");
      } finally { deadline.removeEventListener("abort", stop); await reader.cancel().catch(() => {}); }
      try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
      catch { throw new GitHubError("github_invalid_response"); }
    } catch (error) {
      if (error instanceof GitHubError) throw error;
      throw new GitHubError(deadline.aborted ? "github_request_cancelled" : "github_transport_unavailable");
    } finally { await response?.body?.cancel().catch(() => {}); }
  }
}
