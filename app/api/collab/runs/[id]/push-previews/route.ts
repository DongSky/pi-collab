import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { listTaskPushPreviews, requestTaskPushPreview, pushPreviewRequest } from "@/lib/collab/git/push-previews";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => listTaskPushPreviews((await identity(request)).user.id, (await context.params).id));
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => requestTaskPushPreview((await identity(request)).user.id, (await context.params).id, pushPreviewRequest.parse(await jsonBody(request))), 202);
}
