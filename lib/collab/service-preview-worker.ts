import { lstat, rm } from "node:fs/promises";
import path from "node:path";
import type { ExecutionStore } from "./execution-store";
import { serviceConfig, type ServiceClaim, type ServiceResponse } from "./service-preview-schema";
import { loadSnapshot, restoreSnapshot, materializeDependencyInputs } from "./runtime/snapshots";
import { materializeContractInputs } from "./runtime/contract-inputs";
import { materializeResolutionInputs } from "./runtime/resolution-inputs";
import { startServiceBackend } from "./runtime/service-backend";
import type { AgentProcess } from "./runtime/backends";
import { watchArtifact } from "./runtime/artifact-storage";
import { inspectNativeExit } from "./runtime/receipts";
import { inspectContainerExit } from "./runtime/container-receipts";
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
async function cleanup(store: ExecutionStore, root: string, id: string) {
  const parent = path.join(root, "workspaces"); if ((await lstat(parent)).isSymbolicLink()) throw new Error("service_parent_changed");
  await rm(path.join(parent, id), { recursive: true, force: true }); await store.serviceCleaned(id);
}
export async function executeServicePreview(store: ExecutionStore, claim: ServiceClaim, root: string, external?: AbortSignal) {
  const controller = new AbortController(); let agent: AgentProcess | undefined, monitor: Awaited<ReturnType<typeof watchArtifact>> | undefined, heartbeatWork: Promise<void> | undefined;
  let ready = false, confirmed = false, failure: string | null = null, startedBackend = false;
  const cancel = () => { controller.abort(); void agent?.stop().catch(() => {}); }; external?.addEventListener("abort", cancel, { once: true }); if (external?.aborted) cancel();
  const heartbeat = () => heartbeatWork ??= (async () => {
    try {
      if (!await store.heartbeatService(claim)) return cancel();
      if (agent) {
        await agent.peer.command("service_heartbeat", {}, 3000);
        const state = (await agent.peer.command("get_state", {}, 3000)).data as { closed: boolean; outputTail: string; outputBytes: number };
        if (state.closed) { failure ??= "service_process_exited"; cancel(); }
        if (!await store.heartbeatService(claim, false, null, state.outputTail)) cancel();
      }
    } catch { failure ??= "service_control_lost"; cancel(); }
  })().finally(() => { heartbeatWork = undefined; });
  const timer = setInterval(() => void heartbeat(), 1000);
  try {
    claim.config = serviceConfig.parse(claim.config); await heartbeat();
    if (controller.signal.aborted) throw new Error("service_cancelled");
    monitor = await watchArtifact(store, root, "service", claim.id, cancel);
    const { manifest } = await loadSnapshot(root, claim.snapshotId, claim.manifestHash);
    if (manifest.repositoryId !== claim.repositoryId) throw new Error("service_source_mismatch");
    const workspace = await restoreSnapshot(root, claim.id, claim.snapshotId, claim.manifestHash);
    await materializeDependencyInputs(root, workspace.root, manifest.dependencies); await materializeContractInputs(workspace.root, manifest.contracts); await materializeResolutionInputs(workspace.root, manifest.resolution);
    workspace.port = claim.port;
    if (controller.signal.aborted) throw new Error("service_cancelled");
    agent = await startServiceBackend(workspace, { runId: claim.id, executorId: claim.executorId, epoch: "1" }, claim.runtime, () => { startedBackend = true; });
    await agent.peer.command("service_start", { config: claim.config }, 3_200_000);
    if (controller.signal.aborted) throw new Error("service_cancelled");
    ready = await store.heartbeatService(claim, true, { runtime: claim.runtime, snapshotHash: claim.manifestHash, config: claim.config, environment: agent.runtimeEvidence ?? { node: process.version, platform: process.platform, arch: process.arch } });
    if (!ready) throw new Error("service_authorization_changed");
    while (!controller.signal.aborted) {
      const requests = await store.serviceRequests(claim);
      await Promise.all(requests.map(async r => {
        let response: ServiceResponse;
        try { response = (await agent!.peer.command("service_http", { request: r }, 10000)).data as ServiceResponse; }
        catch { response = { status: 502, contentType: "text/plain", body: "" }; }
        await store.serviceRespond(claim, r.id, response);
      }));
      await delay(100);
    }
  } catch (e) { failure ??= e instanceof Error && /^service_[a-z_]+$/.test(e.message) ? e.message : "service_start_failed"; }
  finally {
    if (agent) { try { await agent.stop(); confirmed = true; } catch { failure = "service_exit_unconfirmed"; } }
    else if (!startedBackend) confirmed = true;
    else { const inspect = claim.runtime === "docker" ? inspectContainerExit : inspectNativeExit; confirmed = (await inspect(root, claim.id, { runId: claim.id, executorId: claim.executorId, epoch: "1" })).safe; }
    clearInterval(timer); external?.removeEventListener("abort", cancel); await heartbeatWork;
    const storageFailure = await monitor?.finish(); if (storageFailure) failure = storageFailure;
  }
  await store.finishService(claim, confirmed ? ready ? "stopped" : "failed" : "unknown", confirmed, failure);
  if (confirmed) await cleanup(store, root, claim.id);
  return confirmed ? ready ? "stopped" : "failed" : "unknown";
}
export async function reconcileServicePreviews(store: ExecutionStore, root: string, mode: "native" | "docker") {
  for (const row of await store.serviceRecovery(mode)) {
    if (!row.confirmed) {
      const proof = await (mode === "docker" ? inspectContainerExit : inspectNativeExit)(root, row.id, { runId: row.id, executorId: row.executorId, epoch: "1" });
      if (!proof.safe) continue;
      await store.finishService(row, "stopped", true, "service_reconciled_exit");
    }
    await cleanup(store, root, row.id);
  }
}
