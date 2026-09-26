import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { commitIdentitySchema, inspectWorkspaceGit, sourceSchema, workspaceStageSelection } from "../runtime/workspace-git-view";
import type { WorkspaceGitCheckpoint } from "../runtime/workspace-git-operation";
import { operationRequestSchema, type WorkspaceGitControl } from "../runtime/workspace-git-operation-common";

const common = { operationId: z.uuid(), source: sourceSchema, revision: z.string().regex(/^[a-f0-9]{64}$/) };
const admissionSchema = z.discriminatedUnion("kind", [
  z.object({ ...common, kind: z.literal("stage"), selections: z.array(workspaceStageSelection).min(1).max(200) }).strict(),
  z.object({ ...common, kind: z.literal("commit"), identity: commitIdentitySchema }).strict(),
]);
const claimSchema = z.object({ jobId: z.uuid(), claimId: z.uuid(), mode: z.enum(["execute", "reconcile"]), admission: admissionSchema,
  launchIntent: z.boolean(), effectRequest: operationRequestSchema.nullable() }).strict();
type Claim = z.infer<typeof claimSchema>;
type Options = { signal?: AbortSignal; afterClaim?: (id: string) => Promise<void>; afterReservation?: (id: string) => Promise<void>;
  beforeGate?: (id: string) => Promise<void>; beforeAckCommit?: (id: string) => Promise<void>; beforeFinish?: (id: string) => Promise<void>;
  checkpoint?: (value: WorkspaceGitCheckpoint, child: { pid: number; stop: () => void }) => Promise<void> };
async function transaction<T>(db: PoolClient, work: () => Promise<T>) {
  try { await db.query("BEGIN"); const result = await work(); await db.query("COMMIT"); return result; }
  catch (error) { await db.query("ROLLBACK").catch(() => {}); throw error; }
}
function matches(claim: Claim, value: WorkspaceGitControl) {
  const { operationId, source, revision, kind } = value.state.request, request = value.state.request;
  const admission = { operationId, source, revision, kind, ...(kind === "stage" ? { selections: request.selections } : { identity: request.identity }) };
  if (!isDeepStrictEqual(admission, claim.admission) || (claim.effectRequest && !isDeepStrictEqual(request, claim.effectRequest))) throw new Error("workspace_git_evidence_mismatch");
}

/** Dedicated Git role, one pinned SQL connection, one live child handle. An
 * unknown acknowledgement never causes this attempt to reconnect or replay.
 * Native control CAS and SQL authority are independent, both are required. */
export async function processWorkspaceGit(pool: Pool, root: string, options: Options = {}) {
  // Preserve the native launcher's ESM import.meta resolution when this service
  // is loaded by tsx from the application's CommonJS package scope.
  const { cancelReservedWorkspaceGit, launchWorkspaceGitOperation, observeWorkspaceGitOperation, reserveWorkspaceGit, reserveWorkspaceGitRecovery } = await import("../runtime/workspace-git-operation");
  const db = await pool.connect(), lost = new AbortController();
  const signal = AbortSignal.any([lost.signal, options.signal ?? AbortSignal.timeout(300000), AbortSignal.timeout(300000)]);
  let claim: Claim | undefined, child: ReturnType<typeof launchWorkspaceGitOperation> | undefined;
  const disconnected = () => lost.abort(), stop = () => child?.stop();
  db.on("error", disconnected); signal.addEventListener("abort", stop);
  const check = () => { if (signal.aborted) throw new Error("workspace_git_cancelled"); };
  try {
    check(); const raw = (await db.query("SELECT collab_git.claim_workspace() AS result")).rows[0].result;
    if (!raw) return null;
    if (raw.attentionJob) return { jobId: z.uuid().parse(raw.attentionJob), status: "attention" };
    claim = claimSchema.parse(raw); const active = claim, { jobId, claimId, admission } = active;
    if (jobId !== admission.operationId) throw new Error("workspace_git_evidence_mismatch");
    await db.query("SELECT set_config('application_name',$1,false)", [`pi-collab-workspace-git:${jobId}`]);
    await options.afterClaim?.(jobId); check();
    const finish = async (observed: Awaited<ReturnType<typeof observeWorkspaceGitOperation>>) => {
      if (!observed) throw new Error("workspace_git_evidence_missing"); matches(active, observed);
      if (!observed.settled || !observed.writerExited) throw new Error("workspace_git_exit_unconfirmed");
      await options.beforeFinish?.(jobId); check();
      return (await db.query("SELECT collab_git.finish_workspace($1,$2,$3) AS result", [jobId, claimId, observed])).rows[0].result;
    };
    if (active.mode === "reconcile") {
      return await transaction(db, async () => {
        await db.query("SELECT collab_git.gate_workspace($1,$2)", [jobId, claimId]); check();
        if (!active.launchIntent) return (await db.query("SELECT collab_git.fail_workspace($1,$2,'workspace_git_not_launched') AS result", [jobId, claimId])).rows[0].result;
        let observed = await observeWorkspaceGitOperation(root, admission.source.workspaceId);
        // Absence may mean an old reservation is delayed before its CAS. Do not
        // release occupancy without a durable matching cancellation/exit fence.
        if (!observed) throw new Error("workspace_git_evidence_missing"); matches(active, observed);
        if (!observed.settled) {
          if (observed.state.phase === "reserved" && !observed.state.attempt) {
            await cancelReservedWorkspaceGit({ root, workspaceId: admission.source.workspaceId, oid: observed.oid, mode: "execute" });
            observed = await observeWorkspaceGitOperation(root, admission.source.workspaceId);
          } else {
            check(); const reservation = await reserveWorkspaceGitRecovery(root, admission.source.workspaceId); check();
            child = launchWorkspaceGitOperation(reservation, { authorize: async () => { throw new Error("workspace_git_replay_forbidden"); }, checkpoint: options.checkpoint });
            if (signal.aborted) child.stop(); observed = await child.done;
          }
        }
        return finish(observed);
      });
    }
    // Reject ordinary stale previews/invalid selections before durable launch
    // intent. Reservation repeats these checks, closing the later race safely.
    const view = await inspectWorkspaceGit(root, admission.source, signal);
    if (view.revision !== admission.revision) throw new Error("workspace_git_stale_revision");
    if (admission.kind === "stage") await view.planStaging(admission.revision, admission.selections);
    else view.planCommit(admission.revision, admission.identity);
    const admitted = admissionSchema.parse((await db.query("SELECT collab_git.begin_workspace($1,$2) AS result", [jobId, claimId])).rows[0].result);
    if (!isDeepStrictEqual(admitted, admission)) throw new Error("workspace_git_evidence_mismatch");
    check(); const reservation = await reserveWorkspaceGit(root, admitted); await options.afterReservation?.(jobId); check();
    child = launchWorkspaceGitOperation(reservation, {
      checkpoint: options.checkpoint,
      authorize: async (prepared, effect) => {
        matches(active, prepared); check();
        await db.query("SELECT collab_git.admit_workspace_effect($1,$2,$3)", [jobId, claimId, prepared.state.request]);
        active.effectRequest = prepared.state.request;
        await options.beforeGate?.(jobId); check();
        await transaction(db, async () => {
          const allowed = (await db.query("SELECT collab_git.gate_workspace($1,$2) AS result", [jobId, claimId])).rows[0].result;
          check(); if (!allowed) return;
          const receipt = await effect(); check();
          matches(active, { oid: prepared.oid, state: receipt });
          await db.query("SELECT collab_git.ack_workspace($1,$2,$3)", [jobId, claimId, receipt]);
          await options.beforeAckCommit?.(jobId);
        });
      },
    });
    if (signal.aborted) child.stop();
    // effect() resolves before cleanup/exit. Only done plus fresh exit evidence
    // permits SQL settlement; final permission locks need not span cleanup.
    return await finish(await child.done);
  } catch (error) {
    child?.stop(); await child?.done.catch(() => {});
    if (claim && !lost.signal.aborted) {
      const code = error instanceof Error && /^workspace_git_[a-z_]{1,95}$/.test(error.message) ? error.message : "workspace_git_broker_failed";
      const result = await db.query("SELECT collab_git.fail_workspace($1,$2,$3) AS result", [claim.jobId, claim.claimId, code]).catch(() => null);
      if (result) return result.rows[0].result;
    }
    throw new Error("workspace_git_outcome_unknown");
  } finally {
    lost.abort(); signal.removeEventListener("abort", stop); db.removeListener("error", disconnected); db.release(true);
  }
}
