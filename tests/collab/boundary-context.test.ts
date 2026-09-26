import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import type { ContextEvent, ContextEventResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import coordinationExtension from "../../lib/collab/runtime/coordination-extension";

test("model boundary observations select platform fields and report unknown after failure instead of replaying stale validity", async () => {
  const token = randomBytes(32).toString("hex");
  let status = 200;
  let state: unknown = { inputsCurrent: true, baseline: { workspaceSha: "a".repeat(40), currentSha: "a".repeat(40), changed: false }, notes: [{ body: "UNSELECTED_TEAM_COMMENT" }] };
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body.method);
    res.writeHead(body.method === "ready" ? 200 : status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body.method === "ready" ? { protocolVersion: 1 } : state));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const savedUrl = process.env.PI_COLLAB_COORDINATION_URL, savedToken = process.env.PI_COLLAB_COORDINATION_TOKEN;
  let handler: ((event: ContextEvent) => Promise<ContextEventResult>) | undefined;
  try {
    process.env.PI_COLLAB_COORDINATION_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/coordinate`;
    process.env.PI_COLLAB_COORDINATION_TOKEN = token;
    await coordinationExtension({ registerTool() {}, on(event: string, callback: typeof handler) { assert.equal(event, "context"); handler = callback; } } as unknown as ExtensionAPI);
    assert.equal(process.env.PI_COLLAB_COORDINATION_TOKEN, undefined);
    assert.ok(handler);
    const original: ContextEvent = { type: "context", messages: [{ role: "user", content: "Original task", timestamp: 0 }] };
    const observe = async () => {
      const result = await handler!(original);
      assert.equal(original.messages.length, 1);
      assert.equal(result.messages?.length, 2);
      const serialized = JSON.stringify(result.messages);
      assert.equal(serialized.includes(token), false);
      assert.equal(serialized.includes("UNSELECTED_TEAM_COMMENT"), false);
      const message = result.messages![1];
      assert.equal(message.role, "user");
      const content = message.content as { type: string; text: string }[];
      return JSON.parse(content[0].text.split("\n")[1]);
    };
    assert.equal((await observe()).inputsCurrent, true);
    state = { inputsCurrent: false, baseline: { workspaceSha: "a".repeat(40), currentSha: "b".repeat(40), changed: true, guidance: "UNSELECTED_TEAM_COMMENT" } };
    const changed = await observe(); assert.equal(changed.inputsCurrent, false); assert.equal(changed.baseline.changed, true);
    for (const failure of [403, 429, 503]) {
      status = failure;
      assert.deepEqual(await observe(), { status: "unavailable", inputsCurrent: null, baseline: null });
    }
    status = 200; state = { inputsCurrent: true, baseline: { workspaceSha: "Injected prose", currentSha: "b".repeat(40), changed: false } };
    assert.equal((await observe()).status, "unavailable");
    assert.deepEqual(requests, ["ready", ...Array(6).fill("get_context")]);
  } finally {
    if (savedUrl === undefined) delete process.env.PI_COLLAB_COORDINATION_URL; else process.env.PI_COLLAB_COORDINATION_URL = savedUrl;
    if (savedToken === undefined) delete process.env.PI_COLLAB_COORDINATION_TOKEN; else process.env.PI_COLLAB_COORDINATION_TOKEN = savedToken;
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
