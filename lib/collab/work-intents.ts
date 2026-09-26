import path from "node:path";
import { z } from "zod";
import { asUser } from "./database";
import { uuid } from "./projects";
import { DomainError } from "./policy";
import { workIntentInput, overlappingPaths, pathCovered, type WorkDeclaration } from "./work-intent-schema";
import { snapshotBaselineChanges } from "./runtime/snapshots";
export { workIntentInput } from "./work-intent-schema";

export function declareWorkIntent(userId: string, runId: string, raw: z.input<typeof workIntentInput>) {
  uuid.parse(runId); const input = workIntentInput.parse(raw);
  return asUser(userId, async db => (await db.query("SELECT collab.declare_work_intent($1,$2,$3,$4) AS result", [runId, input.expectedRevision, input.idempotencyKey, input.declaration])).rows[0].result);
}
type Intent = { author_kind: "human" | "agent"; id: string; run_id: string; task_id: string; revision: number; declared_by: string; declaration: WorkDeclaration; created_at: string };
export function runWorkIntents(userId: string, runId: string) {
  uuid.parse(runId);
  return asUser(userId, async db => {
    const run = (await db.query("SELECT r.id,r.status,r.task_id,r.requested_by,w.repository_id FROM collab.runs r JOIN collab.workspaces w ON w.id=r.workspace_id WHERE r.id=$1", [runId])).rows[0];
    if (!run) throw new DomainError("not_found", "运行不存在或不可访问。", 404);
    const history = (await db.query<Intent>("SELECT id,run_id,task_id,revision,declared_by,author_kind,declaration,created_at FROM collab.work_intents WHERE run_id=$1 ORDER BY revision DESC LIMIT 50", [runId])).rows;
    const latest = history[0] ?? null;
    // Only each task's newest run participates. An old declaration must not
    // masquerade as the intent of a fresh run which has declared nothing.
    const peers = (await db.query<Intent & { title: string; status: string }>(`SELECT i.id,i.run_id,i.task_id,i.revision,i.declared_by,i.declaration,i.created_at,t.title,r.status
      FROM collab.tasks t JOIN LATERAL (SELECT * FROM collab.runs WHERE task_id=t.id ORDER BY created_at DESC,id DESC LIMIT 1) r ON true
      JOIN collab.workspaces w ON w.id=r.workspace_id
      JOIN LATERAL (SELECT * FROM collab.work_intents WHERE run_id=r.id ORDER BY revision DESC LIMIT 1) i ON true
      WHERE t.project_id=(SELECT project_id FROM collab.runs WHERE id=$1) AND t.id<>$2 AND t.status NOT IN ('done','cancelled')
        AND w.repository_id=$3 ORDER BY i.created_at DESC LIMIT 201`, [runId, run.task_id, run.repository_id])).rows;
    const overlaps = latest ? peers.slice(0, 200).flatMap(peer => {
      const paths = overlappingPaths(latest.declaration.paths, peer.declaration.paths);
      const symbols = latest.declaration.symbols.filter(symbol => peer.declaration.symbols.includes(symbol));
      return paths.length || symbols.length ? [{ taskId: peer.task_id, runId: peer.run_id, title: peer.title, status: peer.status, intentId: peer.id, revision: peer.revision, paths: paths.slice(0, 64), pathCount: paths.length, symbols }] : [];
    }) : [];
    return { run, latest, history, overlaps, peersTruncated: peers.length > 200 };
  });
}
export async function snapshotScopeReport(userId: string, snapshotId: string) {
  uuid.parse(snapshotId);
  return asUser(userId, async db => {
    const snapshot = (await db.query("SELECT id,run_id,manifest_hash FROM collab.snapshots WHERE id=$1 AND status='ready'", [snapshotId])).rows[0];
    if (!snapshot) throw new DomainError("not_found", "快照不存在或不可访问。", 404);
    const intent = (await db.query<Intent>("SELECT id,run_id,task_id,revision,declared_by,author_kind,declaration,created_at FROM collab.work_intents WHERE run_id=$1 ORDER BY revision DESC LIMIT 1", [snapshot.run_id])).rows[0] ?? null;
    let result;
    try { result = await snapshotBaselineChanges(process.env.PI_COLLAB_DATA_DIR ?? path.resolve(".local"), snapshotId, snapshot.manifest_hash); }
    catch { throw new DomainError("scope_report_unavailable", "快照或仓库基线不可用，无法核对修改范围。", 409); }
    const changes = result.changes.map(change => ({ ...change, declared: !!intent?.declaration.paths.some(scope => pathCovered(change.path, scope)) }));
    // Recheck current RLS after filesystem work; revocation must not return a report.
    if (!(await db.query("SELECT 1 FROM collab.snapshots WHERE id=$1", [snapshotId])).rowCount) throw new DomainError("not_found", "快照不存在或不可访问。", 404);
    return { ...result, runId: snapshot.run_id, intentId: intent?.id ?? null, intentRevision: intent?.revision ?? null, declaration: intent?.declaration ?? null,
      changes: changes.slice(0, 1000), changeCount: changes.length, undeclaredCount: changes.filter(change => !change.declared).length, changesTruncated: changes.length > 1000,
      excluded: result.excluded.slice(0, 1000), excludedCount: result.excluded.length, excludedTruncated: result.excluded.length > 1000 };
  });
}
