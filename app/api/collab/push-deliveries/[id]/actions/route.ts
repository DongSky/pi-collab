import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { actOnTaskPushDelivery } from "@/lib/collab/git/push-deliveries";
import { pushDeliveryAction } from "@/lib/collab/git/push-delivery-schema";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => actOnTaskPushDelivery((await identity(request)).user.id, (await context.params).id, pushDeliveryAction.parse(await jsonBody(request))));
}
