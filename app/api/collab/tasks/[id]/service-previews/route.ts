import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { createServicePreview, listServicePreviews } from "@/lib/collab/service-previews";
type Context = { params: Promise<{ id: string }> };
export function GET(request: Request, context: Context) { return endpoint(request, async () => listServicePreviews((await identity(request)).user.id, (await context.params).id)); }
export function POST(request: Request, context: Context) { return endpoint(request, async () => createServicePreview((await identity(request)).user.id, (await context.params).id, await jsonBody(request))); }
