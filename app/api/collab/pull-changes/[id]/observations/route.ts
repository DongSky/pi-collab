import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { pullObservationContext, requestPullObservation } from "@/lib/collab/git/pull-observations";
import { pullObservationRequest } from "@/lib/collab/git/pull-observation-schema";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => pullObservationContext((await identity(request)).user.id, (await context.params).id));
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => requestPullObservation((await identity(request)).user.id, (await context.params).id, pullObservationRequest.parse(await jsonBody(request))), 202);
}
