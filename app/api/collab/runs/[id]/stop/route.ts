import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { stopInput, stopRun } from "@/lib/collab/runs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => stopRun((await identity(request)).user.id, (await context.params).id, stopInput.parse(await jsonBody(request))), 202);
}
