import { z } from "zod";
import { asUser } from "./database";
import { uuid } from "./projects";
import type { ExecutionStore } from "./execution-store";
import { inspectContainerExit } from "./runtime/container-receipts";
import { inspectNativeExit } from "./runtime/receipts";

export const runActionInput = z.object({
  action: z.enum(["recover", "archive"]), idempotencyKey: uuid,
  expectedRevision: z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= BigInt("9223372036854775807")),
  reason: z.string().trim().min(10).max(2000),
}).strict();
export function manageRun(userId: string, runId: string, raw: z.infer<typeof runActionInput>) {
  uuid.parse(runId); const input = runActionInput.parse(raw);
  return asUser(userId, async db => (await db.query("SELECT collab.manage_run($1,$2,$3,$4,$5) AS result", [runId, input.action, input.idempotencyKey, input.expectedRevision, input.reason])).rows[0].result);
}

/** Single-node recovery worker; disk inspection has no side effects and may safely repeat. */
export async function processRecoveries(store: ExecutionStore, dataRoot: string) {
  for (const request of await store.pendingRecoveries()) {
    const evidence = request.runtime === "native"
      ? await inspectNativeExit(dataRoot, request.workspaceId, { runId: request.runId, executorId: request.executorId, epoch: request.epoch })
      : await inspectContainerExit(dataRoot, request.workspaceId, { runId: request.runId, executorId: request.executorId, epoch: request.epoch });
    await store.resolveRecovery(request.actionId, evidence.code, evidence.receiptHash);
  }
}
