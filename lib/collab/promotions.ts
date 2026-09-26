import type { z } from "zod";
import { asUser } from "./database";
import { uuid } from "./projects";
import { DomainError } from "./policy";
import { promotionRequestSchema, promotionActionSchema } from "./promotion-schema";

export function requestPromotion(userId: string, integrationId: string, raw: z.infer<typeof promotionRequestSchema>) {
  uuid.parse(integrationId); const input = promotionRequestSchema.parse(raw);
  return asUser(userId, async db => (await db.query("SELECT collab.request_promotion($1,$2,$3,$4,$5) AS result",
    [integrationId, input.revisionHash, input.acknowledgeExcluded, input.reason, input.idempotencyKey])).rows[0].result);
}
export function promotionAction(userId: string, id: string, raw: z.infer<typeof promotionActionSchema>) {
  uuid.parse(id); const input = promotionActionSchema.parse(raw);
  return asUser(userId, async db => (await db.query("SELECT collab.promotion_action($1,$2,$3,$4) AS result", [id, input.action, input.reason, input.idempotencyKey])).rows[0].result);
}
export function promotionDetail(userId: string, id: string) {
  uuid.parse(id);
  return asUser(userId, async db => {
    const promotion = (await db.query("SELECT id,integration_id,input,promotion_sha,request,requested_by,requested_at,status,epoch::text,stop_requested,effect_grant,effect_admitted_at,observation,error_code,finished_at FROM collab.promotions WHERE id=$1", [id])).rows[0];
    if (!promotion) throw new DomainError("not_found", "推进记录不存在或不可访问。", 404);
    return { promotion };
  });
}
