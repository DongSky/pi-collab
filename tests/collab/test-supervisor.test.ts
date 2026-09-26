import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("parallel suites reuse a supervisor-owned database until the last suite exits", { timeout: 45_000 }, async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--import", "tsx", "scripts/test-collab.ts",
    "tests/collab/fixtures/database-short.ts", "tests/collab/fixtures/database-long.ts",
  ], { timeout: 40_000 });
  assert.match(stdout, /# pass 2/);
  assert.match(stdout, /# fail 0/);
});
