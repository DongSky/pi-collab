import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import coordinationExtension from "../../lib/collab/runtime/coordination-extension";

test("question tool retries uncertain creation with identical input, waits through pending and supports cancellation", { timeout: 10000 }, async () => {
  let execute: ((id: string, input: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>) | undefined;
  const requests: unknown[] = [], abort = new AbortController(); let cancel = false;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (body.method === "ready") { res.writeHead(200); res.end("{}"); return; }
    assert.equal(body.method, "ask_user"); requests.push(body.input);
    const round = requests.length;
    res.writeHead(round === 1 ? 503 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(round === 1 ? { outcome: "unknown" } : { status: round === 2 || cancel ? "pending" : "answered", answer: "Durable human answer" }));
    if (cancel) setTimeout(() => abort.abort(), 25);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const oldUrl = process.env.PI_COLLAB_COORDINATION_URL, oldToken = process.env.PI_COLLAB_COORDINATION_TOKEN;
  try {
    process.env.PI_COLLAB_COORDINATION_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/coordinate`;
    process.env.PI_COLLAB_COORDINATION_TOKEN = randomBytes(32).toString("hex");
    await coordinationExtension({ on() {}, registerTool(tool: { name: string; execute: typeof execute }) { if (tool.name === "collab_ask_user") execute = tool.execute; } } as unknown as ExtensionAPI);
    assert.ok(execute);
    const input = { question: "Choose an approach", choices: [], idempotencyKey: randomUUID() };
    const result = await execute("call", input, abort.signal);
    assert.ok(JSON.stringify(result).includes("Durable human answer"));
    assert.equal(requests.length, 3); for (const request of requests) assert.deepEqual(request, input);
    cancel = true; await assert.rejects(execute("cancelled-call", { ...input, idempotencyKey: randomUUID() }, abort.signal), /abort/i);
    assert.equal(requests.length, 4);
  } finally {
    if (oldUrl === undefined) delete process.env.PI_COLLAB_COORDINATION_URL; else process.env.PI_COLLAB_COORDINATION_URL = oldUrl;
    if (oldToken === undefined) delete process.env.PI_COLLAB_COORDINATION_TOKEN; else process.env.PI_COLLAB_COORDINATION_TOKEN = oldToken;
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
