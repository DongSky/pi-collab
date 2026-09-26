import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { cancelPullObservation } from "@/lib/collab/git/pull-observations";
import { pullObservationCancel } from "@/lib/collab/git/pull-observation-schema";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => cancelPullObservation((await identity(request)).user.id, (await context.params).id, pullObservationCancel.parse(await jsonBody(request))), 202);
}
