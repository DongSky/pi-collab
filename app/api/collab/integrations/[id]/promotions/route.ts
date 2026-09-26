import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { requestPromotion } from "@/lib/collab/promotions";
import { promotionRequestSchema } from "@/lib/collab/promotion-schema";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => requestPromotion((await identity(request)).user.id, (await context.params).id, promotionRequestSchema.parse(await jsonBody(request))), 201);
}
