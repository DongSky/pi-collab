import { endpoint, identity } from "@/lib/collab/http";
import { discussionDetail } from "@/lib/collab/discussions";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
 return endpoint(request, async () => discussionDetail((await identity(request)).user.id, (await params).id, new URL(request.url).searchParams.get("after") ?? "0"));
}
