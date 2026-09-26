import { z } from "zod";
import { asUser } from "../database";
import { pushDeliveryRequest, pushDeliveryAction, type PushDeliveryRecord } from "./push-delivery-schema";
export function requestTaskPushDelivery(userId: string, confirmationId: string, raw: z.input<typeof pushDeliveryRequest>) {
  z.uuid().parse(confirmationId); const { idempotencyKey, ...payload } = pushDeliveryRequest.parse(raw);
  return asUser(userId, async db => (await db.query<{ result: PushDeliveryRecord & { replayed: boolean } }>(
    "SELECT collab.request_task_push_delivery($1,$2,$3) AS result", [confirmationId, idempotencyKey, payload])).rows[0].result);
}
export function actOnTaskPushDelivery(userId: string, jobId: string, raw: z.input<typeof pushDeliveryAction>) {
  z.uuid().parse(jobId); const value = pushDeliveryAction.parse(raw);
  return asUser(userId, async db => (await db.query<{ result: PushDeliveryRecord & { replayed: boolean } }>(
    "SELECT collab.task_push_delivery_action($1,$2,$3,$4,$5) AS result", [jobId, value.idempotencyKey, value.action, value.reason, value.acknowledgeUnknown])).rows[0].result);
}
