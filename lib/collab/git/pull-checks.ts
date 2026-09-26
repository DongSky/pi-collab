import { z } from "zod";
import { asUser } from "../database";
import { checksPolicyInput, pullChecksRequest, pullChecksCancel, type PullChecksContext, type PullChecksRecord } from "./pull-checks-schema";
export function pullChecksContext(userId: string, revisionId: string) {
  z.uuid().parse(revisionId);
  return asUser(userId, async db => (await db.query<{ result: PullChecksContext }>("SELECT collab.pull_checks_context($1) AS result", [revisionId])).rows[0].result);
}
export function publishPullChecksPolicy(userId: string, revisionId: string, raw: z.input<typeof checksPolicyInput>) {
  z.uuid().parse(revisionId); const { idempotencyKey, ...payload } = checksPolicyInput.parse(raw);
  return asUser(userId, async db => (await db.query<{ result: { policyId: string; replayed: boolean } }>("SELECT collab.publish_pull_check_policy($1,$2,$3) AS result", [revisionId, idempotencyKey, payload])).rows[0].result);
}
export function requestPullChecks(userId: string, revisionId: string, raw: z.input<typeof pullChecksRequest>) {
  z.uuid().parse(revisionId); const { idempotencyKey, ...payload } = pullChecksRequest.parse(raw);
  return asUser(userId, async db => (await db.query<{ result: PullChecksRecord & { replayed: boolean } }>("SELECT collab.request_pull_checks($1,$2,$3) AS result", [revisionId, idempotencyKey, payload])).rows[0].result);
}
export function cancelPullChecks(userId: string, jobId: string, raw: z.input<typeof pullChecksCancel>) {
  z.uuid().parse(jobId); const value = pullChecksCancel.parse(raw);
  return asUser(userId, async db => (await db.query<{ result: PullChecksRecord & { replayed: boolean } }>("SELECT collab.cancel_pull_checks($1,$2,$3) AS result", [jobId, value.idempotencyKey, value.reason])).rows[0].result);
}
