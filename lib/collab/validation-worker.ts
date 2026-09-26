import { watchArtifact } from "./runtime/artifact-storage";
import type { ExecutionStore } from "./execution-store";
import { validateSnapshot, type ValidationClaim, type ValidationEvidence } from "./runtime/validation";

export async function executeValidation(store: ExecutionStore, claim: ValidationClaim, root: string, external?: AbortSignal, heartbeatMs = 5000) {
  const controller = new AbortController(); let heartbeatWork: Promise<void> | undefined, controlLost = false;
  const cancel = () => controller.abort(); external?.addEventListener("abort", cancel, { once: true });
  if (external?.aborted) cancel();
  const heartbeat = () => heartbeatWork ??= (async () => {
    try { if (!await store.heartbeatValidation(claim)) cancel(); }
    catch { controlLost = true; cancel(); }
  })().finally(() => { heartbeatWork = undefined; });
  let evidence: ValidationEvidence | null = null, outcome: ValidationEvidence["outcome"] = "unknown", failure: string | null = null;
  let storage: Awaited<ReturnType<typeof watchArtifact>> | undefined;
  const timer = setInterval(() => void heartbeat(), heartbeatMs);
  try {
    storage = await watchArtifact(store, root, "validation", claim.id, cancel);
    await heartbeat();
    if (controller.signal.aborted) outcome = "cancelled";
    else { evidence = await validateSnapshot(root, claim, controller.signal); outcome = evidence.outcome; failure = evidence.steps.find(step => step.error)?.error ?? null; }
  } catch (error) {
    // Only known provisioning failures prove that commands were not started.
    const rawCode = (error as { code?: unknown })?.code;
    const code = typeof rawCode === "string" ? rawCode : error instanceof Error ? error.message : "";
    const beforeLaunch = code.startsWith("snapshot_") || ["validation_runtime_unsupported", "validation_source_mismatch", "validation_npm_unavailable"].includes(code);
    outcome = beforeLaunch ? "failed" : "unknown";
    failure = code === "snapshot_resolution_markers_present" ? "validation_resolution_markers_present" : beforeLaunch ? "validation_provisioning_failed" : "validation_outcome_unknown";
  } finally {
    const storageFailure = await storage?.finish();
    if (storageFailure) { failure = storageFailure; if (outcome !== "unknown") { outcome = "cancelled"; if (evidence) evidence.outcome = "cancelled"; } }
    clearInterval(timer); external?.removeEventListener("abort", cancel);
    if (heartbeatWork) await heartbeatWork;
  }
  if (controlLost) { outcome = "unknown"; failure = "validation_control_lost"; }
  // A lost acknowledgement is left for the durable lease sweeper. Never rerun.
  return store.finishValidation(claim, outcome, evidence, failure);
}
