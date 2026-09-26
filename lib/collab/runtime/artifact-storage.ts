import { lstat, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ExecutionStore } from "../execution-store";
import { measureDirectory } from "./storage-meter";
import { inspectNativeExit } from "./receipts";
import { inspectContainerExit } from "./container-receipts";
export type ArtifactKind = "workspace" | "snapshot" | "validation" | "integration" | "repository" | "service";
export type ArtifactDescriptor = { kind: ArtifactKind; id: string; limit_bytes: string; details: { checkId?: string; runId?: string; executorId?: string | null; epoch?: string } };
export type ArtifactCleanup = Omit<ArtifactDescriptor, "limit_bytes"> & { jobId: string; runtime: "native" | "docker" };
export function artifactPaths(root: string, a: Pick<ArtifactDescriptor, "kind" | "id" | "details">) {
  z.uuid().parse(a.id);
  const part = (category: string, id = a.id) => path.join(root, category, z.uuid().parse(id));
  switch (a.kind) {
    case "service":
    case "workspace": return [part("workspaces")];
    case "snapshot": return [part("snapshots")];
    case "validation": return [part("workspaces"), part("validation-executions")];
    case "integration": return [part("workspaces"), part("snapshots"), part("integrations"), part("workspaces", z.uuid().parse(a.details.checkId)), part("validation-executions", a.details.checkId)];
    case "repository": return [part("repositories")];
    default: throw new Error("artifact_kind_unavailable");
  }
}
export async function measureArtifact(root: string, a: Pick<ArtifactDescriptor, "kind" | "id" | "details">) {
  let bytes = 0;
  for (const directory of artifactPaths(root, a)) {
    const value = await measureDirectory(directory, undefined, true);
    if (value.error) return { bytes: bytes + (value.bytes ?? 0), error: value.error };
    bytes += value.bytes!;
  }
  return { bytes, error: null };
}
export async function scanArtifacts(store: ExecutionStore, root: string) {
  for (const a of await store.artifactScanCandidates()) {
    const usage = await measureArtifact(root, a); await store.recordArtifactUsage(a.kind, a.id, usage);
  }
}
export async function watchArtifact(store: ExecutionStore, root: string, kind: ArtifactKind, id: string, cancel: () => void) {
  const artifact = await store.artifactLimit(kind, id); if (!artifact) throw new Error("artifact_unavailable");
  let pending: Promise<void> | undefined, reason: string | null = null;
  const sample = () => pending ??= (async () => {
    const usage = await measureArtifact(root, artifact); await store.recordArtifactUsage(kind, id, usage);
    if (usage.error) { reason = "artifact_measurement_unavailable"; cancel(); }
    else if (usage.bytes! > Number(artifact.limit_bytes)) { reason = "artifact_storage_exhausted"; cancel(); }
  })().catch(() => { reason = "artifact_measurement_unavailable"; cancel(); }).finally(() => { pending = undefined; });
  const timer = setInterval(() => void sample(), 2000);
  return { async finish() { clearInterval(timer); await pending; await sample(); return reason; } };
}
/** Fixed paths are retired in SQL before deletion. A crashed deletion can only
 * retry those same paths; no source status is restored and no project code runs. */
export async function processArtifactCleanup(store: ExecutionStore, root: string, worker: string) {
  const job = await store.claimArtifactCleanup(worker); if (!job) return;
  let failure: string | null = null;
  try {
    if (job.kind === "repository" || job.kind === "service") throw new Error("protected_repository");
    const paths = artifactPaths(root, job);
    if (job.kind === "workspace") {
      if (job.details.executorId) {
        const inspect = job.runtime === "docker" ? inspectContainerExit : inspectNativeExit;
        const proof = await inspect(root, job.id, { runId: z.uuid().parse(job.details.runId), executorId: z.uuid().parse(job.details.executorId), epoch: z.string().regex(/^[1-9][0-9]*$/).parse(job.details.epoch) });
        if (!proof.safe) throw new Error("artifact_exit_unconfirmed");
      } else {
        for (const directory of paths) { try { await lstat(directory); throw new Error("artifact_exit_unconfirmed"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
      }
    }
    // Parent categories are supervisor-owned. Never traverse a replaced parent.
    for (const directory of paths) {
      const parent = path.dirname(directory); await mkdir(parent, { recursive: true, mode: 0o700 });
      if ((await lstat(parent)).isSymbolicLink()) throw new Error("artifact_parent_changed");
      await rm(directory, { recursive: true, force: true });
    }
  } catch { failure = "artifact_cleanup_attention"; }
  await store.finishArtifactCleanup(worker, job.jobId, failure);
  return { id: job.jobId, status: failure ? "attention" : "deleted" };
}
