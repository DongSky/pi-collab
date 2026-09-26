import { z } from "zod";
import { asUser } from "./database";
import { uuid } from "./projects";
import { DomainError } from "./policy";

const version = z.string().regex(/^[1-9][0-9]{0,17}$/);
export const controlRequestInput = z.object({ expectedVersion: version, idempotencyKey: uuid, note: z.string().trim().min(10).max(2000) }).strict();
export const controlDecisionInput = controlRequestInput.extend({ action: z.enum(["accept", "reject", "withdraw"]) }).strict();
export const runInstructionInput = z.object({ expectedVersion: version, idempotencyKey: uuid, kind: z.enum(["steer", "follow_up"]), message: z.string().trim().min(1).max(20000) }).strict();
export function runControl(userId: string, runId: string) {
  uuid.parse(runId);
  return asUser(userId, async db => {
    const run = (await db.query("SELECT id,execution_kind,status,requested_by,collab.control_state(id) AS control FROM collab.runs WHERE id=$1", [runId])).rows[0];
    if (!run) throw new DomainError("not_found", "运行不存在或不可访问。", 404);
    const requests = (await db.query(`SELECT q.id,q.requester_id,u.name AS requester_name,q.control_version::text,q.status,q.note,q.created_at,q.handled_at,h.name AS handler_name,q.decision->>'note' AS response
      FROM collab.control_requests q JOIN public."user" u ON u.id=q.requester_id LEFT JOIN public."user" h ON h.id=q.handled_by WHERE q.run_id=$1 ORDER BY q.created_at DESC,q.id DESC LIMIT 50`, [runId])).rows;
    const instructions = (await db.query(`SELECT i.id,i.author_id,u.name AS author_name,i.control_version::text,i.kind,i.message,i.status,i.created_at,
      CASE WHEN d.instruction_id IS NULL THEN NULL ELSE jsonb_build_object('threadId',d.thread_id,'title',d.source->>'title','messageIds',(SELECT jsonb_agg(m->>'id') FROM jsonb_array_elements(d.source->'messages') m),'sourceHash',d.source_hash) END AS discussion
      FROM collab.run_instructions i JOIN public."user" u ON u.id=i.author_id LEFT JOIN collab.instruction_discussions d ON d.instruction_id=i.id WHERE i.run_id=$1 ORDER BY i.sequence DESC LIMIT 50`, [runId])).rows;
    return { run, requests, instructions };
  });
}
export function requestRunControl(userId: string, runId: string, raw: z.infer<typeof controlRequestInput>) {
  uuid.parse(runId); const input = controlRequestInput.parse(raw);
  return asUser(userId, async db => (await db.query("SELECT collab.request_run_control($1,$2,$3,$4) AS result", [runId, input.expectedVersion, input.idempotencyKey, input.note])).rows[0].result);
}
export function decideRunControl(userId: string, requestId: string, raw: z.infer<typeof controlDecisionInput>) {
  uuid.parse(requestId); const input = controlDecisionInput.parse(raw);
  return asUser(userId, async db => (await db.query("SELECT collab.decide_run_control($1,$2,$3,$4,$5) AS result", [requestId, input.expectedVersion, input.idempotencyKey, input.action, input.note])).rows[0].result);
}
export function submitRunInstruction(userId: string, runId: string, raw: z.infer<typeof runInstructionInput>) {
  uuid.parse(runId); const input = runInstructionInput.parse(raw);
  return asUser(userId, async db => (await db.query("SELECT collab.submit_run_instruction($1,$2,$3,$4,$5) AS result", [runId, input.expectedVersion, input.idempotencyKey, input.kind, input.message])).rows[0].result);
}
