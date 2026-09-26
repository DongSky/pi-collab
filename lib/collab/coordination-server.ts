import { createServer, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { z } from "zod";
import type { ExecutionStore } from "./execution-store";
import { coordinationSchemas, type CoordinationMethod } from "./coordination-schema";
import { overlappingPaths, type WorkDeclaration } from "./work-intent-schema";

class CoordinationError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
const requestSchema = z.object({ version: z.literal(1), method: z.enum(["ask_user", "propose_subtask", "propose_memory", "get_context", "declare_intent", "propose_contract", "send_note", "request_resource", "release_resource", "execute_resource", "cancel_resource_job"]), input: z.unknown() }).strict();
const knownErrors = new Set(["invalid_question", "question_pending", "question_closed", "invalid_subtask", "subtask_source_unavailable", "subtask_principal_required", "subtask_limit", "invalid_memory", "invalid_memory_source", "stale_memory", "memory_limit", "invalid_resource", "resource_limit", "resource_busy", "resource_request_active", "stale_resource_lease", "stale_lease", "run_not_executable", "invalid_coordination", "invalid_note", "unrelated_task", "idempotency_conflict", "coordination_limit", "coordination_rate_limit", "stale_revision", "stale_contract", "invalid_work_intent", "invalid_contract", "contract_owner_mismatch", "contract_limit", "not_found", "forbidden", "mfa_required", "intent_run_closed"]);
type Peer = { taskId: string; title: string; runId: string; revision: number; declaration: WorkDeclaration };
export async function coordinate(store: ExecutionStore, executorId: string, runId: string, epoch: string, method: CoordinationMethod, raw: unknown) {
  const input = coordinationSchemas[method].parse(raw);
  const result = (await store.pool.query("SELECT collab_worker.coordinate($1,$2,$3,$4,$5) AS result", [executorId, runId, epoch, method, JSON.stringify(input)])).rows[0].result;
  if (method !== "get_context") return result;
  const peers: Peer[] = result.peers;
  const declaration: WorkDeclaration | undefined = result.intent?.declaration;
  const overlaps = declaration ? peers.slice(0, 200).flatMap(peer => {
    const paths = overlappingPaths(declaration.paths, peer.declaration.paths), symbols = declaration.symbols.filter(s => peer.declaration.symbols.includes(s));
    return paths.length || symbols.length ? [{ taskId: peer.taskId, title: peer.title, runId: peer.runId, revision: peer.revision, paths: paths.slice(0, 64), pathCount: paths.length, symbols }] : [];
  }) : [];
  const notes = result.notes.slice(0, 5);
  result.resources.jobs = result.resources.jobs.map((job: { result: unknown }) => ({ ...job, result: JSON.stringify(job.result).length > 2048 ? { truncated: true, message: "Result stored in project UI. Query a smaller result with SELECT/LIMIT if needed." } : job.result }));
  return { ...result, peers: undefined, contracts: result.contracts.map((pin: { contractId: string; key: string; revisionId: string; version: number; bodyHash: string }) => ({ contractId: pin.contractId, key: pin.key, revisionId: pin.revisionId, version: pin.version, bodyHash: pin.bodyHash })), contractInputFile: "../contracts.json",
    overlaps: overlaps.slice(0, 20).map(peer => ({ ...peer, paths: peer.paths.slice(0, 8), symbols: peer.symbols.slice(0, 8) })), overlapCount: overlaps.length,
    peersTruncated: peers.length > 200, relatedTasks: result.relatedTasks.slice(0, 100), relatedTasksTruncated: result.relatedTasks.length > 100,
    currentContracts: result.currentContracts.slice(0, 100), currentContractsTruncated: result.currentContracts.length > 100,
    notes, notesHaveMore: result.notes.length > 5, nextNoteSequence: notes.at(-1)?.sequence ?? (input as { afterSequence: string }).afterSequence };
}
export type CoordinationAccess = { url: string; token: string };
/** One ephemeral endpoint per run. Every call rechecks the DB lease and authority. */
export async function startCoordinationServer(store: ExecutionStore, executorId: string, runId: string, epoch: string) {
  const token = randomBytes(32).toString("hex"), expected = Buffer.from(token);
  let closed = false, active = 0, windowAt = Date.now(), count = 0, host = "";
  let loaded = false;
  const reply = (res: ServerResponse, status: number, value: unknown) => {
    if (!res.destroyed && !res.writableEnded) { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); }
  };
  const server = createServer((req, res) => {
    void (async () => {
      if (closed) throw new CoordinationError(503, "coordination_unavailable");
      if (req.method !== "POST" || req.url !== "/v1/coordinate") throw new CoordinationError(404, "unsupported_endpoint");
      if (req.headers.origin || req.headers.cookie || req.headers.host !== host || req.headers["content-type"]?.split(";")[0] !== "application/json") throw new CoordinationError(403, "invalid_request");
      const supplied = Buffer.from(/^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? "")?.[1] ?? "");
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new CoordinationError(401, "coordination_access_denied");
      if (Date.now() - windowAt > 60_000) { windowAt = Date.now(); count = 0; }
      if (active >= 4 || ++count > 120) throw new CoordinationError(429, "coordination_rate_limit");
      active++;
      try {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 64 * 1024) throw new CoordinationError(413, "request_too_large"); chunks.push(chunk); }
        let parsed: unknown;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new CoordinationError(400, "invalid_json"); }
        if (JSON.stringify(parsed) === JSON.stringify({ version: 1, method: "ready", input: {} })) { loaded = true; reply(res, 200, { protocolVersion: 1 }); return; }
        const request = requestSchema.parse(parsed);
        reply(res, 200, await coordinate(store, executorId, runId, epoch, request.method, request.input));
      } finally { active--; }
    })().catch(error => {
      if (error instanceof CoordinationError) reply(res, error.status, { error: error.code });
      else if (error instanceof z.ZodError) reply(res, 400, { error: "invalid_coordination" });
      else if ((error as { code?: string }).code === "P0001" && knownErrors.has(error.message)) reply(res, ["stale_lease", "run_not_executable", "forbidden", "mfa_required"].includes(error.message) ? 403 : 409, { error: error.message });
      else reply(res, 503, { error: "coordination_unavailable", outcome: "unknown", retry: "Reuse the same idempotencyKey and payload; do not assume a write failed." });
    });
  });
  server.requestTimeout = 10_000; server.headersTimeout = 5000; server.timeout = 10_000; server.maxConnections = 16;
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  host = `127.0.0.1:${(server.address() as { port: number }).port}`;
  return { access: { url: `http://${host}/v1/coordinate`, token }, assertLoaded() { if (!loaded) throw new Error("Managed Pi coordination extension did not load"); }, async close() {
    closed = true;
    const done = new Promise<void>(resolve => server.close(() => resolve())); server.closeAllConnections(); await done;
  } };
}
