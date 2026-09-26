import { measureArtifact } from "./runtime/artifact-storage";
import path from "node:path";
import { z } from "zod";
import { asUser } from "./database";
import { uuid } from "./projects";
import { DomainError } from "./policy";
import type { ExecutionStore } from "./execution-store";
import { captureSnapshot, readSnapshotManifest, snapshotSummary } from "./runtime/snapshots";
import { inspectContainerExit } from "./runtime/container-receipts";
import { inspectNativeExit } from "./runtime/receipts";

export const snapshotInput = z.object({ idempotencyKey: uuid, expectedRevision: z.string().regex(/^[1-9][0-9]{0,17}$/), note: z.string().trim().min(1).max(4000) }).strict();
export function requestSnapshot(userId: string, runId: string, raw: z.infer<typeof snapshotInput>) {
  uuid.parse(runId); const input = snapshotInput.parse(raw);
  return asUser(userId, async db => (await db.query("SELECT collab.request_snapshot($1,$2,$3,$4) AS result", [runId, input.idempotencyKey, input.expectedRevision, input.note])).rows[0].result);
}
export function listSnapshots(userId: string, taskId: string) {
  uuid.parse(taskId);
  return asUser(userId, async db => {
    if (!(await db.query("SELECT 1 FROM collab.tasks WHERE id=$1", [taskId])).rowCount) throw new DomainError("not_found", "任务不存在或不可访问。", 404);
    return { snapshots: (await db.query(`SELECT s.id,s.run_id,s.status,s.summary,s.error_code,s.payload->>'note' AS note,s.created_at,w.repository_id,w.base_sha
      FROM collab.snapshots s JOIN collab.workspaces w ON w.id=s.workspace_id WHERE s.task_id=$1 ORDER BY s.created_at DESC LIMIT 50`, [taskId])).rows };
  });
}
export function snapshotDetail(userId: string, snapshotId: string) {
  uuid.parse(snapshotId);
  return asUser(userId, async db => {
    const snapshot = (await db.query("SELECT id,manifest_hash FROM collab.snapshots WHERE id=$1 AND status='ready'", [snapshotId])).rows[0];
    if (!snapshot) throw new DomainError("not_found", "快照不存在或不可访问。", 404);
    let manifest;
    try { ({ manifest } = await readSnapshotManifest(process.env.PI_COLLAB_DATA_DIR ?? path.resolve(".local"), snapshotId, snapshot.manifest_hash)); }
    catch { throw new DomainError("snapshot_unavailable", "快照文件不可用或校验失败。", 409); }
    if (!(await db.query("SELECT 1 FROM collab.snapshots WHERE id=$1", [snapshotId])).rowCount) throw new DomainError("not_found", "快照不存在或不可访问。", 404);
    return { manifest, manifestHash: snapshot.manifest_hash };
  });
}
export async function processSnapshots(store: ExecutionStore, root: string) {
  for (const request of await store.pendingSnapshots()) {
    let hash: string | null = null, summary: unknown = null, failure: string | null = null;
    try {
      const inspectExit = request.runtime === "native" ? inspectNativeExit : inspectContainerExit;
      const proof = await inspectExit(root, request.workspaceId, { runId: request.runId, executorId: request.executorId, epoch: request.epoch });
      if (!proof.safe) throw { code: "snapshot_exit_unconfirmed" };
      const { id, runId, workspaceId, repositoryId, baseSha, note, context, parentSnapshot, dependencies, contracts, resolution } = request;
      const captured = await captureSnapshot(root, { id, runId, workspaceId, repositoryId, baseSha, note, context, parentSnapshot, dependencies, contracts, resolution });
      hash = captured.manifestHash; summary = snapshotSummary(captured.manifest);
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      failure = typeof code === "string" && code.startsWith("snapshot_") ? code.slice(0, 120) : "snapshot_failed";
    }
    const artifact = await store.artifactLimit("snapshot", request.id);
    if (artifact) {
      const usage = await measureArtifact(root, artifact); await store.recordArtifactUsage("snapshot", request.id, usage);
      if (usage.error || usage.bytes! > Number(artifact.limit_bytes)) { hash = null; summary = null; failure = "snapshot_storage_limit"; }
    }
    // A committed artifact can be loaded again after a lost DB response. Never
    // turn a database outage into a permanent capture failure.
    await store.completeSnapshot(request.id, hash, summary, failure);
  }
}
