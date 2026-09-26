import { endpoint, identity } from "@/lib/collab/http";
import { resolutionDetail } from "@/lib/collab/resolutions";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => resolutionDetail((await identity(request)).user.id, (await context.params).id));
}
