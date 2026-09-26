import { endpoint, identity } from "@/lib/collab/http";
import { repositoryCode } from "@/lib/collab/repository-code";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
 const query = new URL(request.url).searchParams;
 return endpoint(request, async () => repositoryCode((await identity(request)).user.id, (await params).id, { path: query.get("path") ?? undefined, revision: query.get("revision") ?? undefined }, request.signal));
}
