import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { promotionAction, promotionDetail } from "@/lib/collab/promotions";
import { promotionActionSchema } from "@/lib/collab/promotion-schema";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => promotionDetail((await identity(request)).user.id, (await context.params).id));
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => promotionAction((await identity(request)).user.id, (await context.params).id, promotionActionSchema.parse(await jsonBody(request))));
}
