import { endpoint, identity } from "@/lib/collab/http";
import { snapshotDetail } from "@/lib/collab/snapshots";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => snapshotDetail((await identity(request)).user.id, (await context.params).id));
}
