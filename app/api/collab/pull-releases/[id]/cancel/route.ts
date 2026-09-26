import { endpoint, identity } from "@/lib/collab/http";
import { cancelPullRelease } from "@/lib/collab/git/pull-releases";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) { return endpoint(request, async () => cancelPullRelease((await identity(request)).user.id,(await params).id)); }
