import { Client, Query } from "pg";
import { createHash } from "node:crypto";
import { openResourcePassword } from "./credentials";
import { validateResourceSql } from "../resource-schema";
import { type ResourceJob, ResourceStore } from "./store";

export async function executeResourceJob(store: ResourceStore, job: ResourceJob, key: Buffer, external?: AbortSignal, heartbeatMs = 2000) {
  const controller = new AbortController(); let heartbeatWork: Promise<void> | undefined, controlLost = false, active = true, bound = false;
  let client: Client | undefined, outcome = "failed", code: string | null = null, evidence: unknown = null, commitAttempted = false;
  const cancel = () => controller.abort(); external?.addEventListener("abort", cancel, { once: true }); if (external?.aborted) cancel();
  const heartbeat = () => heartbeatWork ??= (async () => {
    try { if (!await store.heartbeat(job)) cancel(); } catch { controlLost = true; cancel(); }
  })().finally(() => { heartbeatWork = undefined; });
  let termination: Promise<void> | undefined;
  const stop = () => { if (bound) termination ??= store.terminate(job).catch(() => { controlLost = true; }); if (client) void client.end().catch(() => {}); };
  controller.signal.addEventListener("abort", stop);
  const timeout = setTimeout(cancel, 25_000), timer = setInterval(() => { if (active) void heartbeat(); }, heartbeatMs);
  try {
    validateResourceSql(job.sql); await heartbeat(); if (controller.signal.aborted) throw new Error("resource_cancelled");
    if (!/^pcr_[a-f0-9]{32}$/.test(job.roleName) || job.schemaName !== job.roleName) throw new Error("resource_identity_invalid");
    const url = new URL(store.connectionString); url.username = job.roleName; url.password = openResourcePassword(key, job.resourceId, job.projectId, job.sealed);
    client = new Client({ connectionString: url.toString(), application_name: `pi-collab-job:${job.id}`, connectionTimeoutMillis: 5000,
      options: `-c search_path=${job.schemaName} -c statement_timeout=20000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=15000` });
    client.on("error", () => { if (active) cancel(); });
    await client.connect(); await client.query("BEGIN");
    const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    bound = await store.bind(job, pid); if (!bound || controller.signal.aborted) throw new Error("resource_cancelled");
    const rows: unknown[] = []; let bytes = 0;
    const result = await new Promise<{ command: string; rowCount: number | null }>((resolve, reject) => {
      // A named prepared statement forces one extended-protocol statement; a
      // semicolon cannot escape the surrounding transaction with another command.
      const query = client!.query(new Query({ name: `job_${job.id}`, text: job.sql, values: [] }));
      query.on("row", row => {
        const encoded = JSON.stringify(row); bytes += Buffer.byteLength(encoded);
        if (rows.length >= 100 || bytes > 64 * 1024) { code = "resource_output_limit"; cancel(); } else rows.push(row);
      });
      query.once("error", reject); query.once("end", resolve);
    });
    if (!await store.heartbeat(job) || controller.signal.aborted) throw new Error("resource_cancelled");
    commitAttempted = true; await client.query("COMMIT");
    evidence = { command: result.command, rowCount: result.rowCount, rows, sqlHash: createHash("sha256").update(job.sql).digest("hex"), commitAcknowledged: true };
    outcome = "succeeded";
  } catch (error) {
    const value = error as { code?: string; message?: string };
    code ??= controller.signal.aborted ? "resource_cancelled" : value.message?.startsWith("resource_") ? value.message : value.code && /^[0-9A-Z]{5}$/.test(value.code) ? `postgres_${value.code}` : "resource_outcome_unknown";
    outcome = controlLost || commitAttempted || code === "resource_outcome_unknown" ? "unknown" : controller.signal.aborted ? "cancelled" : "failed";
  } finally {
    active = false; clearInterval(timer); clearTimeout(timeout); external?.removeEventListener("abort", cancel); controller.signal.removeEventListener("abort", stop);
    if (heartbeatWork) await heartbeatWork;
    if (client) { try { await client.end(); } catch { outcome = "unknown"; } }
    if (termination) await termination;
  }
  if (controlLost) { outcome = "unknown"; code = "resource_control_lost"; }
  // The SQL function independently verifies the registered backend has exited.
  return store.finish(job, outcome, evidence, code);
}
