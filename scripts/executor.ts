import { executeServicePreview, reconcileServicePreviews } from "../lib/collab/service-preview-worker";
import { randomUUID } from "node:crypto";
import { ExecutionStore } from "../lib/collab/execution-store";
import { executeClaim } from "../lib/collab/executor";
import { runtimeBackend } from "../lib/collab/runtime/backends";
import { processRecoveries } from "../lib/collab/recovery";
import { scanArtifacts, processArtifactCleanup } from "../lib/collab/runtime/artifact-storage";
import { measureStoppedWorkspaces } from "../lib/collab/runtime/storage-meter";
import { processSnapshots } from "../lib/collab/snapshots";
import { executeValidation } from "../lib/collab/validation-worker";
import { executePromotion } from "../lib/collab/promotion-worker";
import { executeIntegration } from "../lib/collab/integration-worker";
import { dataRoot, executorConnectionString, localConfig } from "./local-config";

if (process.env.NODE_ENV === "production" && !process.env.PI_COLLAB_EXECUTOR_DATABASE_URL) throw new Error("Configure the restricted executor database role");
const connection = process.env.PI_COLLAB_EXECUTOR_DATABASE_URL ?? executorConnectionString(await localConfig());
const mode = process.env.PI_COLLAB_RUNTIME ?? "native";
if (mode !== "native" && mode !== "docker") throw new Error("Unknown runtime backend");
const capacity = Number(process.env.PI_COLLAB_EXECUTOR_CAPACITY ?? 8);
if (!Number.isInteger(capacity) || capacity < 1 || capacity > 32) throw new Error("Executor capacity must be between 1 and 32");
const store = new ExecutionStore(connection), executorId = randomUUID(), shutdown = new AbortController();
const running = new Map<string, Promise<unknown>>();
const services = new Map<string, Promise<unknown>>();
let validation: Promise<unknown> | undefined;
let integration: Promise<unknown> | undefined;
let promotion: Promise<unknown> | undefined;
const stop = () => shutdown.abort();
process.on("SIGINT", stop); process.on("SIGTERM", stop);
console.log(`pi-collab executor ${executorId}: ${mode}, capacity ${capacity}`);
try {
  while (!shutdown.signal.aborted) {
    try {
      await store.reconcileExpired();
      await reconcileServicePreviews(store, dataRoot, mode);
      while (!shutdown.signal.aborted && services.size < 4) {
        const claim = await store.claimService(executorId, mode); if (!claim) break;
        const work = executeServicePreview(store, claim, dataRoot, shutdown.signal).catch(() => console.error("Service preview awaits exit reconciliation")).finally(() => services.delete(claim.id));
        services.set(claim.id, work);
      }
      await processRecoveries(store, dataRoot);
      await processSnapshots(store, dataRoot);
      await measureStoppedWorkspaces(store, dataRoot, mode);
      await scanArtifacts(store, dataRoot);
      await processArtifactCleanup(store, dataRoot, executorId);
      if (!promotion && !shutdown.signal.aborted) {
        const claim = await store.claimPromotion(executorId);
        if (claim) promotion = executePromotion(store, claim, dataRoot, shutdown.signal)
          .then(outcome => console.log(`Promotion ${claim.id}: ${outcome}`))
          .catch(() => console.error(`Promotion ${claim.id}: outcome awaits lease reconciliation`))
          .finally(() => { promotion = undefined; });
      }
      if (!integration && !shutdown.signal.aborted) {
        const claim = await store.claimIntegration(executorId, mode);
        if (claim) integration = executeIntegration(store, claim, dataRoot, shutdown.signal)
          .then(outcome => console.log(`Integration ${claim.id}: ${outcome}`))
          .catch(() => console.error(`Integration ${claim.id}: outcome awaits lease reconciliation`))
          .finally(() => { integration = undefined; });
      }
      if (!validation && !shutdown.signal.aborted) {
        const claim = await store.claimValidation(executorId, mode);
        if (claim) validation = executeValidation(store, claim, dataRoot, shutdown.signal)
          .then(outcome => console.log(`Validation ${claim.id}: ${outcome}`))
          .catch(() => console.error(`Validation ${claim.id}: outcome awaits lease reconciliation`))
          .finally(() => { validation = undefined; });
      }
      while (!shutdown.signal.aborted && running.size < capacity) {
        const claim = await store.claim(executorId, mode);
        if (!claim) break;
        const work = executeClaim(store, executorId, claim, { dataRoot, backend: runtimeBackend(mode), signal: shutdown.signal })
          .then(outcome => console.log(`Run ${claim.run.id}: ${outcome}`))
          .catch(() => console.error(`Run ${claim.run.id}: supervisor failure; lease recovery required`))
          .finally(() => running.delete(claim.run.id));
        running.set(claim.run.id, work);
      }
    } catch { console.error("Executor cannot reach authoritative queue; active runs will stop through their lease watchdogs."); }
    if (!shutdown.signal.aborted) await new Promise(resolve => setTimeout(resolve, 1000));
  }
} finally {
  shutdown.abort(); await Promise.allSettled([...services.values(), ...running.values(), ...(validation ? [validation] : []), ...(integration ? [integration] : []), ...(promotion ? [promotion] : [])]); await store.close();
}
