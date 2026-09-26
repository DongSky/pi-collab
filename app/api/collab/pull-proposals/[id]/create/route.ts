import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { taskPullDeliveryContext, requestTaskPullDelivery } from "@/lib/collab/git/pull-deliveries";
import { pullDeliveryRequest } from "@/lib/collab/git/pull-delivery-schema";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => taskPullDeliveryContext((await identity(request)).user.id, (await context.params).id));
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => requestTaskPullDelivery((await identity(request)).user.id, (await context.params).id, pullDeliveryRequest.parse(await jsonBody(request))), 202);
}
