import { endpoint, identity } from "@/lib/collab/http";
import { runContracts } from "@/lib/collab/contracts";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => runContracts((await identity(request)).user.id, (await context.params).id));
}
