import { randomUUID } from "node:crypto";
import path from "node:path";
import { Pool } from "pg";
import { localConfig, applicationEnvironment, connectionString } from "./local-config";
import { createTask } from "../lib/collab/tasks";
import { startRun } from "../lib/collab/runs";
import { database } from "../lib/collab/database";
const name = process.env.PI_COLLAB_E2E_DATABASE ?? "", root = process.env.PI_COLLAB_E2E_DATA ?? "";
if (!/^pi_collab_test_[a-f0-9]+$/.test(name) || !path.basename(root).startsWith("identity-e2e-")) throw new Error("Isolated scheduling fixture required");
const config = await localConfig();
Object.assign(process.env, applicationEnvironment(config), { DATABASE_URL: connectionString(config, false, name), PI_COLLAB_DATA_DIR: root });
const admin = new Pool({ connectionString: connectionString(config, true, name) });
try {
  const project = process.argv[2], owner = (await admin.query("SELECT created_by FROM collab.projects WHERE id=$1", [project])).rows[0].created_by;
  const repo = (await admin.query("SELECT id,base_sha FROM collab.repositories WHERE project_id=$1 ORDER BY created_at LIMIT 1", [project])).rows[0];
  for (const [title, minutes] of [["等待保护中的任务", 35], ["普通排队任务", 1]] as const) {
    const task = await createTask(owner, project, { title, description: "", acceptance: "Observe queue without starting a model" });
    const run = await startRun(owner, task.id, { repositoryId: repo.id, baseSha: repo.base_sha, expectedVersion: task.version, prompt: "Queued browser fixture only", idempotencyKey: randomUUID() });
    await admin.query("UPDATE collab.runs SET created_at=now()-($2::integer*interval '1 minute') WHERE id=$1", [run.runId, minutes]);
  }
  console.log(JSON.stringify({ queued: 2 }));
} finally { await admin.end(); await database().end(); }
