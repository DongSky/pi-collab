import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { inspectWorkspaceGit, sourceSchema, commitIdentitySchema, workspaceStageSelection, type WorkspaceGitSource, type WorkspaceCommitIdentity, type WorkspaceStageSelection } from "./workspace-git-view";
import { runnerEnvironment } from "./workspace";
import { allocateOperation, encodeIndex, ensureControl, exited, fail, operationStateSchema, readControl, reviewHash, terminal, transition, type WorkspaceGitControl, type WorkspaceGitOperationState, type WorkspaceGitRequest } from "./workspace-git-operation-common";

export type WorkspaceGitAdmission = { operationId: string; source: WorkspaceGitSource; revision: string } & (
  { kind: "stage"; selections: WorkspaceStageSelection[] } | { kind: "commit"; identity: WorkspaceCommitIdentity }
);
export type WorkspaceGitReservation = { root: string; workspaceId: string; oid: string; mode: "execute" | "recover" };
/** Internal only. A database admission/final-authority transaction is still
 * required before a route or AI may call these primitives. */
export async function reserveWorkspaceGit(root: string, input: WorkspaceGitAdmission): Promise<WorkspaceGitReservation> {
  z.uuid().parse(input.operationId); sourceSchema.parse(input.source); z.string().regex(/^[a-f0-9]{64}$/).parse(input.revision);
  const where = await ensureControl(root, input.source.workspaceId), previous = await readControl(where.root, input.source.workspaceId);
  if (previous && (!terminal(previous.state) || !previous.state.released || !await exited(previous.state))) fail("occupied");
  if (previous?.state.request.operationId === input.operationId) fail("operation_reused");
  const view = await inspectWorkspaceGit(where.root, input.source);
  if (view.revision !== input.revision) fail("stale_revision");
  const base = { version: 1 as const, operationId: input.operationId, source: input.source, revision: input.revision, head: view.summary().head, indexHash: view.summary().indexHash };
  let request: WorkspaceGitRequest;
  if (input.kind === "stage") {
    const selections = z.array(workspaceStageSelection).min(1).max(200).parse(input.selections), plan = await view.planStaging(input.revision, selections);
    request = { ...base, kind: "stage", selections, identity: null, planHash: plan.planHash, afterIndexHash: reviewHash(encodeIndex(plan.manifest.entries)), commit: null };
  } else {
    const identity = commitIdentitySchema.parse(input.identity); if (identity.operationId !== input.operationId) fail("invalid_identity");
    const plan = view.planCommit(input.revision, identity);
    request = { ...base, kind: "commit", selections: null, identity, planHash: plan.planHash, afterIndexHash: null, commit: plan.manifest.commit };
  }
  await allocateOperation(where.root, input.source.workspaceId, request);
  const result = await transition(where.root, input.source.workspaceId, previous?.oid ?? null, { version: 1, request, phase: "reserved", attempt: null, locks: [], released: false, reason: null });
  return { root: where.root, workspaceId: input.source.workspaceId, oid: result.oid, mode: "execute" };
}
export async function observeWorkspaceGitOperation(root: string, workspaceId: string) {
  const control = await readControl(root, workspaceId); if (!control) return null;
  const writerExited = await exited(control.state);
  return { ...control, writerExited, settled: terminal(control.state) && control.state.released && writerExited };
}
export async function cancelReservedWorkspaceGit(reservation: WorkspaceGitReservation) {
  const before = await readControl(reservation.root, reservation.workspaceId);
  if (!before || before.oid !== reservation.oid || before.state.phase !== "reserved" || before.state.attempt) fail("stale_owner");
  return transition(reservation.root, reservation.workspaceId, before.oid, { ...before.state, phase: "aborted", released: true, reason: "cancelled_before_launch" });
}
export async function reserveWorkspaceGitRecovery(root: string, workspaceId: string): Promise<WorkspaceGitReservation> {
  const before = await readControl(root, workspaceId); if (!before || before.state.phase === "reserved") fail("not_started");
  if (!await exited(before.state)) fail("writer_present");
  return { root, workspaceId, oid: before.oid, mode: "recover" };
}
export type WorkspaceGitCheckpoint = { checkpoint: string; control: WorkspaceGitControl };
export type WorkspaceGitAuthorizer = (prepared: WorkspaceGitControl, effect: () => Promise<WorkspaceGitOperationState>) => Promise<void>;

/** A fresh process group owns every source mutation, including reconciliation.
 * No PID from disk is signalled; stop() uses only this spawn's live handle.
 * authorize can hold a final SQL transaction around effect(), including its
 * acknowledgement. The future broker must also persist that DB effect intent. */
export function launchWorkspaceGitOperation(reservation: WorkspaceGitReservation, options: {
  authorize: WorkspaceGitAuthorizer;
  checkpoint?: (value: WorkspaceGitCheckpoint, child: { pid: number; stop: () => void }) => Promise<void>;
}) {
  if (process.platform === "win32") fail("unsupported_launch");
  const worker = fileURLToPath(new URL("./workspace-git-operation-worker.ts", import.meta.url));
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), worker, reservation.root, reservation.workspaceId, reservation.oid, reservation.mode, randomUUID()], {
    env: runnerEnvironment("/nonexistent", "/nonexistent"), stdio: ["ignore", "ignore", "ignore", "ipc"], detached: true,
  });
  let settled = false, effectCalled = false, callerFailure: unknown;
  const stop = () => { if (settled || !child.pid) return; try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } };
  let completeEffect: ((state: WorkspaceGitOperationState) => void) | undefined, failEffect: ((error: Error) => void) | undefined;
  const effectResult = new Promise<WorkspaceGitOperationState>((resolve, reject) => { completeEffect = resolve; failEffect = reject; });
  void effectResult.catch(() => {});
  const authorizations: Promise<void>[] = [];
  const send = (event: WorkspaceGitCheckpoint, action: "continue" | "apply" | "abort") => {
    if (child.connected) child.send({ checkpoint: event.checkpoint, oid: event.control.oid, action }, () => {});
  };
  child.on("message", raw => {
    const event = z.object({ checkpoint: z.string(), control: z.object({ oid: z.string().regex(/^[a-f0-9]{40}$/), state: operationStateSchema }).strict() }).strict().safeParse(raw);
    if (!event.success) return;
    const handle = (async () => {
      const value = event.data;
      await options.checkpoint?.(value, { pid: child.pid!, stop });
      if (value.checkpoint === "prepared") {
        try {
          await options.authorize(value.control, async () => {
            if (effectCalled) fail("duplicate_apply"); effectCalled = true;
            send(value, "apply"); return effectResult;
          });
        } finally { if (!effectCalled) send(value, "abort"); }
      } else {
        if (value.checkpoint === "sealed") completeEffect?.(value.control.state);
        send(value, "continue");
      }
    })().catch(error => { callerFailure ??= error; send(event.data, "abort"); });
    authorizations.push(handle);
  });
  child.once("error", () => { failEffect?.(new Error("workspace_git_operation_launch_failed")); });
  const done = new Promise<Awaited<ReturnType<typeof observeWorkspaceGitOperation>>>((resolve, reject) => {
    child.once("close", async () => {
      settled = true; failEffect?.(new Error("workspace_git_operation_acknowledgement_lost"));
      try { await Promise.all(authorizations); if (callerFailure && !(callerFailure instanceof Error && callerFailure.message === "workspace_git_operation_acknowledgement_lost")) throw callerFailure; resolve(await observeWorkspaceGitOperation(reservation.root, reservation.workspaceId)); } catch (error) { reject(error); }
    });
  });
  return { pid: child.pid, done, stop };
}
