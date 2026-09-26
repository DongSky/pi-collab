import { endpoint, identity } from "@/lib/collab/http";
import { runDetail } from "@/lib/collab/runs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => runDetail((await identity(request)).user.id, (await context.params).id));
}
