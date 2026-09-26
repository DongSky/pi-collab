import { endpoint, identity } from "@/lib/collab/http";
import { snapshotCode } from "@/lib/collab/discussions";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
 const q = new URL(request.url).searchParams;
 return endpoint(request, async () => snapshotCode((await identity(request)).user.id, (await params).id, { path: q.get("path") ?? undefined, offset: Number(q.get("offset") ?? 0) }));
}
