import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { actOnTaskPullDelivery } from "@/lib/collab/git/pull-deliveries";
import { pullDeliveryAction } from "@/lib/collab/git/pull-delivery-schema";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => actOnTaskPullDelivery((await identity(request)).user.id, (await context.params).id, pullDeliveryAction.parse(await jsonBody(request))), 202);
}
