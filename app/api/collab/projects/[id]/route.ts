import { endpoint, identity } from "@/lib/collab/http";
import { projectDetail, uuid } from "@/lib/collab/projects";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => projectDetail((await identity(request)).user.id, uuid.parse((await params).id)));
}
