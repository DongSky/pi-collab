import { z } from "zod";
import { asUser } from "../database";
import { pullDeliveryRequest, pullDeliveryAction, type PullDeliveryContext, type PullDeliveryRecord } from "./pull-delivery-schema";
export function taskPullDeliveryContext(userId: string, proposalId: string) {
  z.uuid().parse(proposalId);
  return asUser(userId, async db => (await db.query<{ result: PullDeliveryContext }>(
    "SELECT collab.task_pull_delivery_context($1) AS result", [proposalId])).rows[0].result);
}
export function requestTaskPullDelivery(userId: string, proposalId: string, raw: z.input<typeof pullDeliveryRequest>) {
  z.uuid().parse(proposalId); const { idempotencyKey, ...payload } = pullDeliveryRequest.parse(raw);
  return asUser(userId, async db => (await db.query<{ result: PullDeliveryRecord & { replayed: boolean } }>(
    "SELECT collab.request_task_pull_delivery($1,$2,$3) AS result", [proposalId, idempotencyKey, payload])).rows[0].result);
}
export function actOnTaskPullDelivery(userId: string, jobId: string, raw: z.input<typeof pullDeliveryAction>) {
  z.uuid().parse(jobId); const value = pullDeliveryAction.parse(raw);
  return asUser(userId, async db => (await db.query<{ result: PullDeliveryRecord & { replayed: boolean } }>(
    "SELECT collab.task_pull_delivery_action($1,$2,$3,$4,$5) AS result", [jobId, value.idempotencyKey, value.action, value.reason, value.acknowledgeUnknown])).rows[0].result);
}
