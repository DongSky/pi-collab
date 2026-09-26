import type { RevertInput } from "./runtime/revert";
import type { ServiceClaim, ServiceRequest, ServiceResponse } from "./service-preview-schema";
import type { ArtifactKind, ArtifactDescriptor, ArtifactCleanup } from "./runtime/artifact-storage";
import { Pool } from "pg";
import type { PromotionClaim, PromotionObservation } from "./promotion-schema";
import type { ModelProfile } from "./gateway/store";
import type { SnapshotSource } from "./runtime/snapshots";
import type { ValidationClaim, ValidationEvidence } from "./runtime/validation";
import type { DependencyPin } from "./dependency-inputs";
import type { ContractPin } from "./contract-schema";
import type { IntegrationClaim, IntegrationEvidence } from "./integration-schema";
import type { ResolutionInput } from "./resolution-schema";

export interface ClaimedRun {
  limits?: { timeoutSeconds: number; workspaceBytes: number; policyVersion: number };
  revert?: RevertInput | null;
  resolution?: ResolutionInput | null;
  dependencies?: DependencyPin[];
  contracts?: ContractPin[];
  run: { execution_kind?: "ai" | "terminal"; id: string; task_id: string; project_id: string; workspace_id: string; requested_by: string; prompt: string; epoch: string; status: string; model_profile_id?: string | null };
  workspace: { id: string; repository_id: string; base_sha: string; runtime: "native" | "docker"; epoch: string; source_snapshot_id?: string | null };
}
export interface RecoveryRequest {
  actionId: string; runId: string; workspaceId: string; executorId: string; epoch: string; runtime: "native" | "docker";
}
export type SnapshotRequest = SnapshotSource & { executorId: string; epoch: string; runtime: "native" | "docker" };
export type RunInstruction = { id: string; kind: "steer" | "follow_up"; message: string; authorId: string; authorName: string; controlVersion: string };

/** Trusted supervisor only. This connection and its credentials never reach Pi. */
export class ExecutionStore {
  readonly pool: Pool;
  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30_000, query_timeout: 5000, statement_timeout: 5000 });
    // pg removes broken idle clients. Without a listener an idle network failure
    // terminates the supervisor before its active-run watchdog can stop Pi.
    this.pool.on("error", () => console.error("[pi-collab] Executor database connection lost; lease watchdogs remain active."));
  }
  async claimService(executor: string, runtime: "native" | "docker"): Promise<ServiceClaim | null> { return (await this.pool.query("SELECT collab_worker.claim_service($1,$2) AS result", [executor,runtime])).rows[0].result; }
  async heartbeatService(claim: ServiceClaim, ready = false, evidence: unknown = null, tail: string | null = null): Promise<boolean> { return (await this.pool.query("SELECT collab_worker.heartbeat_service($1,$2,$3,$4,$5) AS result", [claim.executorId,claim.id,ready,evidence,tail])).rows[0].result; }
  async finishService(claim: Pick<ServiceClaim,"id"|"executorId">, outcome: string, confirmed: boolean, failure: string | null) { await this.pool.query("SELECT collab_worker.finish_service($1,$2,$3,$4,$5)", [claim.executorId,claim.id,outcome,confirmed,failure]); }
  async serviceRecovery(runtime: "native" | "docker"): Promise<{id:string;executorId:string;runtime:"native"|"docker";confirmed:boolean}[]> { return (await this.pool.query("SELECT collab_worker.service_recovery($1) AS result",[runtime])).rows[0].result; }
  async serviceCleaned(id: string) { await this.pool.query("SELECT collab_worker.service_cleaned($1)",[id]); }
  async serviceRequests(claim: ServiceClaim): Promise<ServiceRequest[]> { return (await this.pool.query("SELECT collab_worker.service_requests($1,$2) AS result",[claim.executorId,claim.id])).rows[0].result; }
  async serviceRespond(claim: ServiceClaim, id: string, response: ServiceResponse) { await this.pool.query("SELECT collab_worker.service_respond($1,$2,$3,$4)",[claim.executorId,claim.id,id,response]); }
  async artifactScanCandidates(): Promise<ArtifactDescriptor[]> { return (await this.pool.query("SELECT collab_worker.artifact_scan_candidates() AS result")).rows[0].result; }
  async artifactLimit(kind: ArtifactKind, id: string): Promise<ArtifactDescriptor | null> { return (await this.pool.query("SELECT collab_worker.artifact_limit($1,$2) AS result", [kind,id])).rows[0].result; }
  async recordArtifactUsage(kind: ArtifactKind, id: string, usage: { bytes: number | null; error: string | null }) { await this.pool.query("SELECT collab_worker.artifact_measurement($1,$2,$3,$4)", [kind,id,usage.bytes,usage.error]); }
  async claimArtifactCleanup(worker: string): Promise<ArtifactCleanup | null> { return (await this.pool.query("SELECT collab_worker.claim_artifact_cleanup($1) AS result", [worker])).rows[0].result; }
  async finishArtifactCleanup(worker: string, id: string, failure: string | null) { await this.pool.query("SELECT collab_worker.finish_artifact_cleanup($1,$2,$3)", [worker,id,failure]); }
  async recordWorkspaceUsage(workspace: string, epoch: string, usage: { bytes: number | null; error: string | null }) {
    await this.pool.query("SELECT collab_worker.record_workspace_usage($1,$2,$3,$4)", [workspace, epoch, usage.bytes, usage.error]);
  }
  async storageScanCandidates(runtime: "native" | "docker"): Promise<{ id: string; epoch: string }[]> {
    return (await this.pool.query("SELECT collab_worker.storage_scan_candidates($1) AS result", [runtime])).rows[0].result;
  }
  async claim(executor: string, runtime: "native" | "docker"): Promise<ClaimedRun | null> {
    return (await this.pool.query("SELECT collab_worker.claim_revert_aware($1,$2) AS result", [executor, runtime])).rows[0].result;
  }
  async environmentSetup(executor:string,run:string,epoch:string,proof:unknown=null):Promise<{recipe:{install:string;requiredRuntime?:Record<string,unknown>|null};status:string}> {
    return (await this.pool.query("SELECT collab_worker.environment_setup($1,$2,$3,$4) AS result",[executor,run,epoch,proof])).rows[0].result;
  }
  async runEnvironment(executor:string,run:string,epoch:string):Promise<{port:number;resourceId:string;state:string}|null> {
    return (await this.pool.query("SELECT collab_worker.run_environment($1,$2,$3) AS result",[executor,run,epoch])).rows[0].result;
  }
  async claimValidation(executor: string, runtime: "native" | "docker" = process.env.PI_COLLAB_RUNTIME === "docker" ? "docker" : "native"): Promise<ValidationClaim | null> {
    return (await this.pool.query("SELECT collab_worker.claim_revert_validation($1,$2) AS result", [executor,runtime])).rows[0].result;
  }
  async claimPromotion(executor: string): Promise<PromotionClaim | null> { return (await this.pool.query("SELECT collab_worker.claim_promotion($1) AS result", [executor])).rows[0].result; }
  async heartbeatPromotion(c: PromotionClaim): Promise<boolean> { return (await this.pool.query("SELECT collab_worker.heartbeat_promotion($1,$2,$3) AS result", [c.executorId,c.id,c.epoch])).rows[0].result; }
  async admitPromotion(c: PromotionClaim): Promise<boolean> { return (await this.pool.query("SELECT collab_worker.admit_promotion($1,$2,$3) AS result", [c.executorId,c.id,c.epoch])).rows[0].result; }
  async finishPromotion(c: PromotionClaim, result: PromotionObservation | null, failure: string | null): Promise<string> { return (await this.pool.query("SELECT collab_worker.finish_promotion($1,$2,$3,$4,$5) AS result", [c.executorId,c.id,c.epoch,result === null ? null : JSON.stringify(result),failure])).rows[0].result; }
  /** Held only around the bounded Git write and SQL settlement. A lost socket
   * aborts Git; the committed intent remains for reconciliation after rollback. */
  async openPromotionGate(c: PromotionClaim, lost: () => void) {
    const client = await this.pool.connect(); let released = false;
    const fail = () => lost(); client.on("error", fail);
    const release = (destroy = false) => { if (!released) { released = true; client.removeListener("error", fail); client.release(destroy); } };
    const rollback = async () => { if (!released) { try { await client.query("ROLLBACK"); } finally { release(true); } } };
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL idle_in_transaction_session_timeout = '135s'");
      const allowed = (await client.query("SELECT collab_worker.gate_promotion($1,$2,$3) AS result", [c.executorId,c.id,c.epoch])).rows[0].result;
      if (!allowed) { await rollback(); return null; }
      return { rollback, async finish(result: PromotionObservation) {
        try {
          const status: string = (await client.query("SELECT collab_worker.finish_promotion($1,$2,$3,$4,NULL) AS result", [c.executorId,c.id,c.epoch,JSON.stringify(result)])).rows[0].result;
          await client.query("COMMIT"); release(); return status;
        } catch (error) { lost(); await rollback().catch(() => {}); throw error; }
      } };
    } catch (error) { lost(); await rollback().catch(() => {}); throw error; }
  }
  async claimIntegration(executor: string, runtime: "native" | "docker" = process.env.PI_COLLAB_RUNTIME === "docker" ? "docker" : "native"): Promise<IntegrationClaim | null> { return (await this.pool.query("SELECT collab_worker.claim_integration_compatible($1,true,$2) AS result", [executor,runtime])).rows[0].result; }
  async heartbeatIntegration(claim: IntegrationClaim, checking = false): Promise<boolean> { return (await this.pool.query("SELECT collab_worker.heartbeat_integration($1,$2,$3,$4) AS result", [claim.executorId,claim.id,claim.epoch,checking])).rows[0].result; }
  async finishIntegration(claim: IntegrationClaim, outcome: IntegrationEvidence["outcome"], evidence: IntegrationEvidence | null, failure: string | null): Promise<string> { return (await this.pool.query("SELECT collab_worker.finish_integration($1,$2,$3,$4,$5,$6) AS result", [claim.executorId,claim.id,claim.epoch,outcome,evidence===null?null:JSON.stringify(evidence),failure])).rows[0].result; }
  async heartbeatValidation(claim: ValidationClaim): Promise<boolean> {
    return (await this.pool.query("SELECT collab_worker.heartbeat_validation($1,$2,$3) AS result", [claim.executorId, claim.id, claim.epoch])).rows[0].result;
  }
  async finishValidation(claim: ValidationClaim, outcome: ValidationEvidence["outcome"], evidence: ValidationEvidence | null, failure: string | null): Promise<string> {
    return (await this.pool.query("SELECT collab_worker.finish_validation($1,$2,$3,$4,$5,$6) AS result", [claim.executorId, claim.id, claim.epoch, outcome, evidence === null ? null : JSON.stringify(evidence), failure])).rows[0].result;
  }
  async heartbeat(executor: string, run: string, epoch: string): Promise<{ canExecute: boolean; status: string }> {
    return (await this.pool.query("SELECT collab_worker.heartbeat($1,$2,$3) AS result", [executor, run, epoch])).rows[0].result;
  }
  async issueModelCapability(executor: string, run: string, epoch: string, hash: string): Promise<ModelProfile> {
    return (await this.pool.query("SELECT collab_worker.issue_model_capability($1,$2,$3,$4) AS result", [executor, run, epoch, hash])).rows[0].result;
  }
  async renewResources(executor: string, run: string, epoch: string) { await this.pool.query("SELECT collab_worker.renew_resources($1,$2,$3)", [executor, run, epoch]); }
  async running(executor: string, run: string, epoch: string) { await this.pool.query("SELECT collab_worker.mark_running($1,$2,$3)", [executor, run, epoch]); }
  async claimInstruction(executor: string, run: string, epoch: string): Promise<RunInstruction | null> {
    return (await this.pool.query("SELECT collab_worker.claim_run_instruction($1,$2,$3) AS result", [executor, run, epoch])).rows[0].result;
  }
  async finishInstruction(executor: string, run: string, epoch: string, instruction: string, outcome: "delivered" | "rejected" | "unknown"): Promise<string> {
    return (await this.pool.query("SELECT collab_worker.finish_run_instruction($1,$2,$3,$4,$5) AS result", [executor, run, epoch, instruction, outcome])).rows[0].result;
  }
  async closeInstructionChannel(executor: string, run: string, epoch: string) { await this.pool.query("SELECT collab_worker.close_instruction_channel($1,$2,$3)", [executor, run, epoch]); }
  async output(executor: string, run: string, epoch: string, batch: string, events: unknown): Promise<string> {
    return (await this.pool.query("SELECT collab_worker.append_output($1,$2,$3,$4,$5) AS sequence", [executor, run, epoch, batch, JSON.stringify(events)])).rows[0].sequence;
  }
  async finish(executor: string, run: string, epoch: string, outcome: "completed" | "failed" | "cancelled", result: unknown) {
    await this.pool.query("SELECT collab_worker.finish($1,$2,$3,$4,$5)", [executor, run, epoch, outcome, JSON.stringify(result)]);
  }
  async reconcileExpired(): Promise<number> { return (await this.pool.query("SELECT collab_worker.reconcile_expired() AS count")).rows[0].count; }
  async pendingRecoveries(): Promise<RecoveryRequest[]> { return (await this.pool.query("SELECT collab_worker.pending_recoveries() AS result")).rows[0].result; }
  async pendingSnapshots(): Promise<SnapshotRequest[]> { return (await this.pool.query("SELECT collab_worker.pending_snapshots_with_resolutions() AS result")).rows[0].result; }
  async completeSnapshot(id: string, hash: string | null, summary: unknown, failure: string | null): Promise<string> {
    return (await this.pool.query("SELECT collab_worker.complete_snapshot($1,$2,$3,$4) AS result", [id, hash, summary === null ? null : JSON.stringify(summary), failure])).rows[0].result;
  }
  async runEditorVersion(executor: string, run: string, epoch: string, applied: string | null = null): Promise<import("./editor-schema").EditorVersion | null> {
    return (await this.pool.query("SELECT collab_worker.run_editor_version($1,$2,$3,$4) AS result", [executor,run,epoch,applied])).rows[0].result;
  }
  async runSuggestion(executor: string, run: string, epoch: string, applied: string | null = null): Promise<import("./discussion-schema").RunSuggestion | null> {
    return (await this.pool.query("SELECT collab_worker.run_suggestion($1,$2,$3,$4) AS result", [executor,run,epoch,applied])).rows[0].result;
  }
  async restoreSnapshot(executor: string, run: string, epoch: string): Promise<{ id: string; manifestHash: string } | null> {
    return (await this.pool.query("SELECT collab_worker.restore_snapshot($1,$2,$3) AS result", [executor, run, epoch])).rows[0].result;
  }
  async resolveRecovery(actionId: string, code: string, hash?: string): Promise<string> {
    return (await this.pool.query("SELECT collab_worker.resolve_recovery($1,$2,$3) AS result", [actionId, code, hash ?? null])).rows[0].result;
  }
  async quarantine(executor: string, run: string, epoch: string, reason: string) {
    await this.pool.query("SELECT collab_worker.quarantine($1,$2,$3,$4)", [executor, run, epoch, reason]);
  }
  async inspect(executor: string, run: string, epoch: string): Promise<{ status: string; summary: unknown } | null> {
    return (await this.pool.query("SELECT collab_worker.inspect($1,$2,$3) AS result", [executor, run, epoch])).rows[0].result;
  }
  close() { return this.pool.end(); }
}
