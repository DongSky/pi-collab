import { z } from "zod";
import { database, asUser } from "../database";
import { githubId } from "./github-schema";
export type PullRemoteContext = { configured: boolean; needsRefresh: boolean; codeVersion: string; checksVersion: string;
  events: { id: string; event: string; action: string | null; headSha: string; receivedAt: string }[] };
export function pullRemoteEvents(userId: string, changeId: string) {
  z.uuid().parse(changeId);
  return asUser(userId, async db => (await db.query<{ result: PullRemoteContext }>("SELECT collab.pull_remote_events($1) AS result", [changeId])).rows[0].result);
}
declare global { var __piWebhookInflight: number | undefined; }
/** No browser session grants webhook authority. SQL verifies the signature on
 * the exact bytes with a protected verification key before recording any hint. */
export async function githubWebhookResponse(request: Request, appId: string) {
  const response = (status: number, error?: string) => Response.json(error ? { error } : { accepted: true }, { status, headers: { "Cache-Control": "no-store", ...(status === 503 ? { "Retry-After": "2" } : {}) } });
  if (process.env.PI_COLLAB_MODE === "legacy") return response(404, "not_found");
  if (request.headers.has("cookie") || request.headers.has("authorization") || request.headers.has("origin") || request.headers.has("sec-fetch-site")) return response(403, "webhook_transport_rejected");
  const event = request.headers.get("x-github-event"), signature = request.headers.get("x-hub-signature-256"), delivery = request.headers.get("x-github-delivery");
  if (!githubId.safeParse(appId).success || !z.uuid().safeParse(delivery).success || !/^sha256=[a-f0-9]{64}$/.test(signature ?? "")
    || !["ping", "push", "pull_request", "check_run", "check_suite"].includes(event ?? "") || request.headers.get("content-encoding")
    || request.headers.get("content-type")?.split(";",1)[0].trim().toLowerCase() !== "application/json") return response(400, "invalid_webhook_request");
  if ((globalThis.__piWebhookInflight ?? 0) >= 4) return response(503, "webhook_busy");
  globalThis.__piWebhookInflight = (globalThis.__piWebhookInflight ?? 0) + 1;
  const reader = request.body?.getReader(), chunks: Buffer[] = []; let size = 0, timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!reader) return response(400, "invalid_webhook_request");
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("webhook_body_timeout")), 10000); });
    for (;;) {
      const chunk = await Promise.race([reader.read(), deadline]); if (chunk.done) break;
      size += chunk.value.byteLength; if (size > 2097152) { void reader.cancel().catch(() => {}); return response(413, "webhook_body_too_large"); }
      chunks.push(Buffer.from(chunk.value));
    }
    clearTimeout(timer); timer = undefined;
    const query = { text: "SELECT collab.receive_github_webhook($1,$2,$3,$4,$5)", values: [appId, delivery, event, signature, Buffer.concat(chunks)], query_timeout: 10000 };
    await database().query(query);
    return response(202);
  } catch (error) {
    void reader?.cancel().catch(() => {});
    const code = error instanceof Error ? error.message : "";
    if (code === "webhook_signature_rejected") return response(401, code);
    if (code === "webhook_delivery_conflict") return response(409, code);
    if (["invalid_webhook_request", "invalid_webhook_scope"].includes(code)) return response(400, code);
    if (code === "webhook_body_timeout") return response(408, code);
    // A lost COMMIT response gets a retryable response. Durable delivery/hash
    // de-duplication handles the retry without another version increment.
    return response(503, "webhook_unavailable");
  } finally { clearTimeout(timer); for (const chunk of chunks) chunk.fill(0); globalThis.__piWebhookInflight!--; }
}
