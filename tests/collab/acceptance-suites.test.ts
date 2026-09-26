import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { collabSuites, collabMatrix, resolveCollabSuite } from "../../e2e/collab-suites.mjs";

test("acceptance catalogue covers every browser dispatch branch and rejects unknown suites", async () => {
 const source = await readFile("e2e/collab-identity.mjs", "utf8");
 const dispatched = [...source.matchAll(/PI_COLLAB_E2E_FOCUS === '([^']+)'/g)].map(match => match[1]);
 assert.deepEqual(new Set(collabSuites), new Set(["core", ...dispatched]));
 assert.equal(collabSuites.length, new Set(collabSuites).size);
 assert.equal(resolveCollabSuite(undefined), "core");
 assert.deepEqual(collabMatrix(), { suite: collabSuites });
 for (const suite of collabSuites) assert.deepEqual(collabMatrix(suite), { suite: [suite] });
 assert.throws(() => resolveCollabSuite("run-contorl"), /Unknown collaboration acceptance suite/);
});

test("an invalid suite fails at the real launcher before creating config or starting services", async () => {
 const directory = await mkdtemp(path.join(tmpdir(), "pi-collab-invalid-suite-"));
 try {
  await assert.rejects(promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/e2e-identity.ts"], {
   env: { ...process.env, PI_COLLAB_DATA_DIR: directory, PI_COLLAB_E2E_FOCUS: "run-contorl" }, timeout: 15000,
  }), (error: unknown) => {
   const failure = error as { stderr: string; code: number };
   assert.equal(failure.code, 1);
   assert.match(failure.stderr, /Unknown collaboration acceptance suite/);
   return true;
  });
  assert.deepEqual(await readdir(directory), []);
 } finally { await rm(directory, { recursive: true, force: true }); }
});
