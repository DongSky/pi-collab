import { endpoint, identity } from "@/lib/collab/http";
import { contractRevision } from "@/lib/collab/contracts";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => contractRevision((await identity(request)).user.id, (await context.params).id));
}
