import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { decideRunControl, controlDecisionInput } from "@/lib/collab/run-control";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => decideRunControl((await identity(request)).user.id, (await params).id, controlDecisionInput.parse(await jsonBody(request))));
}
