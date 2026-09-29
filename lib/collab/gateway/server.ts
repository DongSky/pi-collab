import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { z } from "zod";
import { openCredential } from "./credentials";
import type { GatewayStore, ModelProfile } from "./store";

class GatewayError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
const textPart = z.object({ type: z.enum(["input_text", "output_text"]), text: z.string(), annotations: z.array(z.unknown()).optional() }).strict();
const inputItem = z.union([
  z.object({ type: z.literal("message").optional(), role: z.enum(["user", "assistant", "system", "developer"]), content: z.union([z.string(), z.array(textPart)]), id: z.string().optional(), phase: z.enum(["commentary", "final_answer"]).optional(), status: z.enum(["completed", "in_progress", "incomplete"]).optional() }).strict(),
  z.object({ type: z.literal("function_call"), call_id: z.string(), name: z.string(), arguments: z.string(), id: z.string().optional(), status: z.enum(["completed", "in_progress", "incomplete"]).optional() }).strict(),
  z.object({ type: z.literal("function_call_output"), call_id: z.string(), output: z.string(), id: z.string().optional() }).strict(),
  z.object({ type: z.literal("reasoning"), id: z.string(), encrypted_content: z.string().nullable().optional(), format: z.string().optional(), summary: z.array(z.object({ type: z.literal("summary_text"), text: z.string() }).strict()), content: z.array(z.object({ type: z.literal("reasoning_text"), text: z.string() }).strict()).optional(), status: z.string().optional() }).strict(),
]);
const bodySchema = z.object({
  model: z.string(), input: z.union([z.string(), z.array(inputItem).max(2000)]), instructions: z.string().optional(),
  stream: z.literal(true), store: z.literal(false).optional(), max_output_tokens: z.number().int().min(16).optional(),
  tools: z.array(z.object({ type: z.literal("function"), name: z.string().min(1).max(128), description: z.string().optional(), parameters: z.record(z.string(), z.unknown()).nullable().optional(), strict: z.boolean().nullable().optional() }).strict()).max(64).optional(),
  tool_choice: z.union([z.enum(["auto", "none", "required"]), z.object({ type: z.literal("function"), name: z.string() }).strict()]).optional(),
  parallel_tool_calls: z.boolean().optional(), temperature: z.number().min(0).max(2).optional(), top_p: z.number().min(0).max(1).optional(),
  reasoning: z.object({ effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]).optional(), summary: z.enum(["auto", "concise", "detailed"]).optional() }).strict().optional(),
  include: z.array(z.literal("reasoning.encrypted_content")).max(1).optional(),
  prompt_cache_key: z.string().max(200).optional(), prompt_cache_retention: z.enum(["in-memory", "24h"]).optional(),
  text: z.object({ verbosity: z.enum(["low", "medium", "high"]).optional() }).strict().optional(),
}).strict();

export function constrainedRequest(raw: unknown, profile: ModelProfile) {
  const body = bodySchema.parse(raw);
  if (body.model !== profile.model_id) throw new GatewayError(403, "model_mismatch");
  if (body.max_output_tokens && body.max_output_tokens > profile.max_output_tokens) throw new GatewayError(400, "model_request_limit");
  // Full configured context is reserved for every call. Reject large serialized
  // text inputs early; token usage is finalized from the terminal provider event.
  if (Buffer.byteLength(JSON.stringify(body)) > Math.max(1024, profile.context_window - 8192)) throw new GatewayError(413, "model_request_limit");
  return { ...body, model: profile.model_id, store: false, max_output_tokens: body.max_output_tokens ?? profile.max_output_tokens,
    prompt_cache_key: undefined, prompt_cache_retention: undefined };
}

function fail(res: ServerResponse, status: number, code: string) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify({ error: { type: "pi_collab_gateway", code, message: code } }));
}
async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw new GatewayError(413, "request_too_large"); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new GatewayError(400, "invalid_json"); }
}

export function createModelGateway(store: GatewayStore, key: Buffer | (() => Promise<Buffer>), options: { checkIntervalMs?: number; requestTimeoutMs?: number; preview?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean> } = {}) {
  const active = new Set<AbortController>();
  const server = createServer((req, res) => {
    void (async () => {
      if (options.preview && await options.preview(req, res)) return;
      if (req.method === "GET" && req.url === "/health") { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"service":"pi-collab-model-gateway"}'); return; }
      if (req.method !== "POST" || req.url !== "/v1/responses") throw new GatewayError(404, "unsupported_endpoint");
      // This endpoint uses a run capability only, never browser cookies or CORS.
      if (req.headers.origin || req.headers["content-type"]?.split(";")[0] !== "application/json") throw new GatewayError(403, "invalid_request_origin_or_type");
      const match = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? "");
      if (!match) throw new GatewayError(401, "model_access_denied");
      const digest = createHash("sha256").update(match[1]).digest("hex"), controller = new AbortController();
      const abort = () => controller.abort();
      active.add(controller); req.once("aborted", abort); res.once("close", abort);
      const timeout = setTimeout(abort, options.requestTimeoutMs ?? 120_000);
      let interval: ReturnType<typeof setInterval> | undefined, check: Promise<void> | undefined;
      const requestId = randomUUID();
      let admitted = false, completed = false, usage: { input: number; output: number } | undefined;
      try {
        const profile = await store.profile(digest), body = constrainedRequest(await readBody(req), profile);
        if (controller.signal.aborted) throw new GatewayError(499, "request_cancelled");
        const grant = await store.admit(digest, requestId, profile.context_window, body.max_output_tokens); admitted = true;
        const material = typeof key === "function" ? await key() : key;
        let secret;
        try { secret = openCredential(material, grant.profile.id, grant.profile.project_id, grant.sealed); }
        finally { if (typeof key === "function") material.fill(0); }
        interval = setInterval(() => {
          if (check) return;
          check = store.valid(digest).then(valid => { if (!valid) abort(); }, abort).finally(() => { check = undefined; });
        }, options.checkIntervalMs ?? 1000);
        const upstream = await fetch(`${secret.baseUrl}/responses`, {
          method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret.apiKey}`, Accept: "text/event-stream" },
          body: JSON.stringify(body), signal: controller.signal, redirect: "error",
        });
        // Do not expose upstream error bodies, redirects, headers or endpoints.
        if (!upstream.ok || !upstream.headers.get("content-type")?.startsWith("text/event-stream") || !upstream.body) {
          await upstream.body?.cancel();
          // Preserve useful status categories without forwarding provider text,
          // credentials or headers. Do not retry an admitted request here.
          const code = upstream.status === 429 ? "provider_rate_limited"
            : [401, 403].includes(upstream.status) ? "provider_authentication_failed"
            : upstream.status >= 500 ? "provider_unavailable" : "provider_request_failed";
          throw new GatewayError(502, code);
        }
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
        const reader = upstream.body.getReader(), decoder = new TextDecoder(); let buffer = "", bytes = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength; if (bytes > 64 * 1024 * 1024) throw new GatewayError(502, "provider_stream_limit");
            buffer += decoder.decode(value, { stream: true });
            // Normalize CRLF without corrupting a CR/LF split across chunks.
            let boundary: RegExpExecArray | null;
            while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
              const frame = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length);
              if (frame.length > 2 * 1024 * 1024) throw new GatewayError(502, "provider_frame_limit");
              const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
              if (!data || data === "[DONE]") continue;
              const event = JSON.parse(data);
              if (typeof event.type !== "string" || !event.type.startsWith("response.") || event.type === "response.failed" || event.type === "response.error") throw new GatewayError(502, "provider_stream_failed");
              if (event.type === "response.completed" || event.type === "response.incomplete") {
                const rawUsage = event.response?.usage;
                if (Number.isSafeInteger(rawUsage?.input_tokens) && rawUsage.input_tokens >= 0 && Number.isSafeInteger(rawUsage?.output_tokens) && rawUsage.output_tokens >= 0 && rawUsage.input_tokens + rawUsage.output_tokens <= profile.context_window + body.max_output_tokens) {
                  usage = { input: rawUsage.input_tokens, output: rawUsage.output_tokens }; completed = true;
                }
              }
              if (controller.signal.aborted) throw new GatewayError(403, "model_access_denied");
              if (!res.write(`data: ${JSON.stringify(event)}\n\n`)) await once(res, "drain", { signal: controller.signal });
            }
            if (buffer.length > 2 * 1024 * 1024) throw new GatewayError(502, "provider_frame_limit");
          }
          if (buffer.trim() || !completed) throw new GatewayError(502, "provider_stream_incomplete");
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        await store.settle(requestId, "completed", usage!.input, usage!.output); admitted = false;
        res.end();
      } finally {
        if (interval) clearInterval(interval); clearTimeout(timeout); abort(); active.delete(controller);
        req.off("aborted", abort); res.off("close", abort);
        if (admitted) await store.settle(requestId, "unknown").catch(() => { /* Reservation remains durable and blocks a second in-flight call. */ });
      }
    })().catch(error => {
      const code = error instanceof Error ? error.message : "gateway_unavailable";
      if (error instanceof GatewayError) fail(res, error.status, error.code);
      else if (error instanceof z.ZodError) fail(res, 400, "unsupported_model_request");
      else if (["model_access_denied", "model_unavailable"].includes(code)) fail(res, 403, code);
      else if (["model_budget_exhausted", "model_request_inflight", "model_money_exhausted", "model_price_unknown"].includes(code)) fail(res, 429, code);
      else if (code === "model_request_limit") fail(res, 400, code);
      else fail(res, 503, "gateway_unavailable");
    });
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.maxHeadersCount = 32;
  return { server, async close() { for (const controller of active) controller.abort(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
