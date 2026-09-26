import assert from "node:assert/strict";
import path from "node:path";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { z } from "zod";
import { localConfig, gitConnectionString } from "./local-config";
import { githubMasterKey, readPrivateGitHubFile } from "../lib/collab/git/github-credentials";
import { processGitSync } from "../lib/collab/git/sync-broker";
import { processGitImport } from "../lib/collab/git/import-broker";
import { githubGitFixture } from "../tests/collab/fixtures/github-git";
const dbName = process.env.PI_COLLAB_E2E_DATABASE ?? "", root = process.env.PI_COLLAB_E2E_DATA ?? "";
if (!/^pi_collab_test_[a-f0-9]+$/.test(dbName) || !path.basename(root).startsWith("identity-e2e-")) throw new Error("Isolated GitHub broker fixture required");
const config = await localConfig();
const pool = new Pool({ connectionString: gitConnectionString(config, dbName), connectionTimeoutMillis: 5000 });
const pem = await readPrivateGitHubFile(path.join(root, "github-fixture.pem")), privateKey = createPrivateKey(pem); pem.fill(0);
const importing = process.argv[2]?.includes("import") ?? false;
const fixture = await githubGitFixture(path.join(root, "github-http-fixture"), importing ? 1013 : 1012, { privateKey, publicKey: createPublicKey(privateKey) });
try {
  const metadata = z.object({ branch: z.string(), sha: z.string().regex(/^[a-f0-9]{40}$/) }).parse(JSON.parse(await readFile(path.join(root, "github-fixture.json"), "utf8")));
  fixture.api.state.branch = metadata.branch; fixture.api.state.sha = metadata.sha; fixture.api.state.name = "imported-repo";
  const result = importing ? await processGitImport(pool, root, () => githubMasterKey(path.join(root, "github-fixture-master.key")), {
    transport: fixture.transport, afterReceipt: process.argv[2] === "crash-import" ? async () => { process.kill(process.pid, "SIGKILL"); } : undefined,
    afterClaim: process.argv[2] === "crash-import-claim" ? async () => { process.kill(process.pid, "SIGKILL"); } : undefined,
  }) : await processGitSync(pool, root, () => githubMasterKey(path.join(root, "github-fixture-master.key")), {
    transport: fixture.transport, afterUpdate: process.argv[2] === "crash" ? async () => { process.kill(process.pid, "SIGKILL"); } : undefined,
  });
  if (["reconcile-import", "cancel-import"].includes(process.argv[2])) assert.equal(fixture.api.calls.length, 0);
  assert.ok(result); console.log(JSON.stringify(result));
} finally { await fixture.close(); await pool.end(); }
