import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { requestTaskPushDelivery } from "@/lib/collab/git/push-deliveries";
import { pushDeliveryRequest } from "@/lib/collab/git/push-delivery-schema";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => requestTaskPushDelivery((await identity(request)).user.id, (await context.params).id, pushDeliveryRequest.parse(await jsonBody(request))), 202);
}
