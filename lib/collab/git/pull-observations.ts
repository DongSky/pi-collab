import { z } from "zod";
import { asUser } from "../database";
import { pullObservationRequest, pullObservationCancel, type PullObservationContext, type PullObservationRecord } from "./pull-observation-schema";
export function pullObservationContext(userId: string, changeId: string) {
  z.uuid().parse(changeId);
  return asUser(userId, async db => (await db.query<{ result: PullObservationContext }>("SELECT collab.pull_observation_context($1) AS result", [changeId])).rows[0].result);
}
export function requestPullObservation(userId: string, changeId: string, raw: z.input<typeof pullObservationRequest>) {
  z.uuid().parse(changeId); const { idempotencyKey, ...payload } = pullObservationRequest.parse(raw);
  return asUser(userId, async db => (await db.query<{ result: PullObservationRecord & { replayed: boolean } }>(
    "SELECT collab.request_pull_observation($1,$2,$3) AS result", [changeId, idempotencyKey, payload])).rows[0].result);
}
export function cancelPullObservation(userId: string, jobId: string, raw: z.input<typeof pullObservationCancel>) {
  z.uuid().parse(jobId); const value = pullObservationCancel.parse(raw);
  return asUser(userId, async db => (await db.query<{ result: PullObservationRecord & { replayed: boolean } }>(
    "SELECT collab.cancel_pull_observation($1,$2,$3) AS result", [jobId, value.idempotencyKey, value.reason])).rows[0].result);
}
