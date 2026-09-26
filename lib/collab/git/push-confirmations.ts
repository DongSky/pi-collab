import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { asUser } from "../database";
import { DomainError } from "../policy";
import { withTaskPushHistory } from "./push-preview-history";
import { pushConfirmationRequest, pushConfirmationWithdrawal, type PushConfirmationContext, type PushConfirmationRecord } from "./push-confirmation-schema";

export function taskPushConfirmationContext(userId: string, previewId: string) {
  z.uuid().parse(previewId);
  return asUser(userId, async db => (await db.query<{ result: PushConfirmationContext }>("SELECT collab.task_push_confirmation_context($1) AS result", [previewId])).rows[0].result);
}
export async function confirmTaskPush(userId: string, previewId: string, raw: z.input<typeof pushConfirmationRequest>, signal?: AbortSignal) {
  z.uuid().parse(previewId); const { idempotencyKey, ...payload } = pushConfirmationRequest.parse(raw);
  const prior = await asUser(userId, async db => (await db.query<{ result: (PushConfirmationRecord & { replayed: boolean }) | null }>(
    "SELECT collab.lookup_task_push_confirmation($1,$2,$3) AS result", [previewId, idempotencyKey, payload])).rows[0].result);
  if (prior) return prior;
  await withTaskPushHistory(userId, previewId, payload.manifestHash, async reader => {
    if (!isDeepStrictEqual(reader.confirmationCommits(), payload.commits)) throw new DomainError("invalid_task_push_confirmation", "必须确认原导出的每个提交及完整版本。", 400);
  }, signal);
  signal?.throwIfAborted();
  // Final SQL checks and records CURRENT authority/destination under locks.
  // Re-reading an existing record never re-acquires its withdrawn reservation.
  return asUser(userId, async db => (await db.query<{ result: PushConfirmationRecord & { replayed: boolean } }>(
    "SELECT collab.confirm_task_push($1,$2,$3) AS result", [previewId, idempotencyKey, payload])).rows[0].result);
}
export function withdrawTaskPushConfirmation(userId: string, confirmationId: string, raw: z.input<typeof pushConfirmationWithdrawal>) {
  z.uuid().parse(confirmationId); const input = pushConfirmationWithdrawal.parse(raw);
  return asUser(userId, async db => (await db.query<{ result: PushConfirmationRecord & { replayed: boolean } }>(
    "SELECT collab.withdraw_task_push_confirmation($1,$2,$3) AS result", [confirmationId, input.idempotencyKey, input.reason])).rows[0].result);
}
