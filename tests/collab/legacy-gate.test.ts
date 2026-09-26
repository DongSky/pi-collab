import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest } from "next/server.js";
import { proxy } from "../../proxy";

async function routes(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await routes(file));
    else if (entry.name === "route.ts") result.push(file);
  }
  return result;
}

test("every inherited API route is closed in default team mode for all supported methods", async () => {
  const previous = process.env.PI_COLLAB_MODE;
  delete process.env.PI_COLLAB_MODE;
  let count = 0;
  try {
    for (const route of await routes("app/api")) {
      if (route.startsWith("app/api/collab/")) continue;
      const source = await readFile(route, "utf8");
      const pathname = "/" + route.slice(4).replace(/\/route\.ts$/, "").replace(/\[[^\]]+\]/g, "fixture");
      const methods = [...source.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)].map(m => m[1]);
      assert.ok(methods.length, `Inventory could not identify methods for ${route}`);
      for (const method of methods) {
        const request = new NextRequest(`http://127.0.0.1:30142${pathname}`, { method, headers: { Host: "127.0.0.1:30142", Origin: "http://127.0.0.1:30142" } });
        const response = proxy(request);
        assert.equal(response.status, 404, `${method} ${pathname} must be gated`);
        assert.equal((await response.json()).error, "legacy_endpoint_disabled");
        count++;
      }
    }
    assert.ok(count > 50, "The inventory must cover the entire inherited API surface");
  } finally {
    if (previous === undefined) delete process.env.PI_COLLAB_MODE;
    else process.env.PI_COLLAB_MODE = previous;
  }
});
