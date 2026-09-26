import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { localConfig, connectionString, executorConnectionString } from "./local-config";
import { ExecutionStore } from "../lib/collab/execution-store";
import { processArtifactCleanup } from "../lib/collab/runtime/artifact-storage";
const name = process.env.PI_COLLAB_E2E_DATABASE ?? "", root = process.env.PI_COLLAB_E2E_DATA ?? "";
if (!/^pi_collab_test_[a-f0-9]+$/.test(name) || !path.basename(root).startsWith("identity-e2e-")) throw new Error("Isolated artifact fixture required");
const config = await localConfig(), admin = new Pool({ connectionString: connectionString(config, true, name) }), store = new ExecutionStore(executorConnectionString(config, name));
try {
  if (process.argv[2] === "cleanup") {
    console.log(JSON.stringify(await processArtifactCleanup(store, root, randomUUID())));
  } else {
    const project = process.argv[3], client = await admin.connect();
    try {
      const run = (await client.query("SELECT * FROM collab.runs WHERE project_id=$1 AND status='completed' ORDER BY created_at LIMIT 1", [project])).rows[0]; assert.ok(run);
      await client.query("BEGIN"); await client.query("SELECT set_config('collab.user_id',$1,true)", [run.requested_by]);
      const requested = (await client.query("SELECT collab.request_snapshot($1,$2,$3,$4) AS result", [run.id, randomUUID(), run.revision, "Failed capture material for browser retention acceptance"])).rows[0].result;
      await client.query("COMMIT");
      const id = requested.snapshotId; await mkdir(path.join(root, "snapshots", id), { recursive: true }); await writeFile(path.join(root, "snapshots", id, "partial"), "partial capture");
      await store.completeSnapshot(id, null, null, "snapshot_failed"); await store.recordArtifactUsage("snapshot", id, { bytes: 15, error: null });
      await admin.query("UPDATE collab_worker.artifacts SET born_at=now()-interval '400 days',retain_until=now()-interval '1 day' WHERE kind='snapshot' AND id=$1", [id]);
      await admin.query("INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail,created_at) VALUES($1,$2::uuid,$3,'old.browser.fixture',$2::text,'{}',now()-interval '181 days')", [run.organization_id, project, run.requested_by]);
      console.log(JSON.stringify({ snapshotId: id }));
    } finally { client.release(); }
  }
} finally { await admin.end(); await store.close(); }
