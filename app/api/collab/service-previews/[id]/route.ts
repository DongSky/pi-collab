import { endpoint, identity } from "@/lib/collab/http";
import { openServicePreview } from "@/lib/collab/service-previews";
export function POST(request: Request, context: { params: Promise<{ id: string }> }) { return endpoint(request, async () => openServicePreview((await identity(request)).user.id, (await context.params).id)); }
