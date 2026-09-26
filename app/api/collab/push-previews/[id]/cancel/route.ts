import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { cancelTaskPushPreview, pushPreviewCancel } from "@/lib/collab/git/push-previews";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => cancelTaskPushPreview((await identity(request)).user.id, (await context.params).id, pushPreviewCancel.parse(await jsonBody(request))), 202);
}
