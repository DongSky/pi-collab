import { endpoint, identity } from "@/lib/collab/http";
import { projectMap } from "@/lib/collab/project-map";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => projectMap((await identity(request)).user.id, (await params).id));
}
