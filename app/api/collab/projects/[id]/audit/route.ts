import { endpoint, identity } from "@/lib/collab/http";
import { projectAudit } from "@/lib/collab/projects";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => projectAudit((await identity(request)).user.id, (await params).id, new URL(request.url).searchParams.get("before") ?? undefined));
}
