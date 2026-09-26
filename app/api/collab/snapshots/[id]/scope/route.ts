import { endpoint, identity } from "@/lib/collab/http";
import { snapshotScopeReport } from "@/lib/collab/work-intents";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => snapshotScopeReport((await identity(request)).user.id, (await context.params).id));
}
