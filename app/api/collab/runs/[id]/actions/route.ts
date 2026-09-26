import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { manageRun, runActionInput } from "@/lib/collab/recovery";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => manageRun((await identity(request)).user.id, (await context.params).id, runActionInput.parse(await jsonBody(request))), 202);
}
