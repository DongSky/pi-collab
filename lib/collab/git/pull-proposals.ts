import { z } from "zod";
import { asUser } from "../database";
import { pullProposalRequest, pullProposalCancel, type PullProposalRecord, type PullProposalContext } from "./pull-proposal-schema";

export function requestTaskPullProposal(userId: string, deliveryId: string, raw: z.input<typeof pullProposalRequest>) {
  z.uuid().parse(deliveryId); const { idempotencyKey, ...payload } = pullProposalRequest.parse(raw);
  return asUser(userId, async db => (await db.query<{ result: PullProposalRecord & { replayed: boolean } }>("SELECT collab.request_task_pull_proposal($1,$2,$3) AS result", [deliveryId, idempotencyKey, payload])).rows[0].result);
}
export function taskPullProposalContext(userId: string, deliveryId: string) {
  z.uuid().parse(deliveryId);
  return asUser(userId, async db => (await db.query<{ result: PullProposalContext }>("SELECT collab.task_pull_proposal_context($1) AS result", [deliveryId])).rows[0].result);
}
export function cancelTaskPullProposal(userId: string, proposalId: string, raw: z.input<typeof pullProposalCancel>) {
  z.uuid().parse(proposalId); const input = pullProposalCancel.parse(raw);
  return asUser(userId, async db => (await db.query<{ result: PullProposalRecord }>("SELECT collab.cancel_task_pull_proposal($1,$2,$3) AS result", [proposalId, input.idempotencyKey, input.reason])).rows[0].result);
}
