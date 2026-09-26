import { z } from "zod";
import { asUser } from "../database";
import { pushPreviewRequest, pushPreviewCancel, type PushPreviewRecord, type PushPreviewDetail } from "./push-preview-schema";
export { pushPreviewRequest, pushPreviewCancel } from "./push-preview-schema";

export function requestTaskPushPreview(userId: string, runId: string, raw: z.input<typeof pushPreviewRequest>) {
  z.uuid().parse(runId); const { idempotencyKey, ...payload } = pushPreviewRequest.parse(raw);
  return asUser(userId, async db => (await db.query("SELECT collab.request_task_push_preview($1,$2,$3) AS result", [runId, idempotencyKey, payload])).rows[0].result);
}
export function listTaskPushPreviews(userId: string, runId: string) {
  z.uuid().parse(runId);
  return asUser(userId, async db => ({ previews: (await db.query<{ result: PushPreviewRecord[] }>("SELECT collab.task_push_previews($1) AS result", [runId])).rows[0].result }));
}
export function taskPushPreviewDetail(userId: string, previewId: string) {
  z.uuid().parse(previewId);
  return asUser(userId, async db => (await db.query<{ result: PushPreviewDetail }>("SELECT collab.task_push_preview_detail($1) AS result", [previewId])).rows[0].result);
}
export function cancelTaskPushPreview(userId: string, previewId: string, raw: z.input<typeof pushPreviewCancel>) {
  z.uuid().parse(previewId); const input = pushPreviewCancel.parse(raw);
  return asUser(userId, async db => (await db.query("SELECT collab.cancel_task_push_preview($1,$2,$3) AS result", [previewId, input.reason, input.idempotencyKey])).rows[0].result);
}
