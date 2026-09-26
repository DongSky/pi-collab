import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { requestSnapshot, snapshotInput } from "@/lib/collab/snapshots";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => requestSnapshot((await identity(request)).user.id, (await context.params).id, snapshotInput.parse(await jsonBody(request))), 202);
}
