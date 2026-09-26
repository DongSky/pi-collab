import { endpoint, identity } from "@/lib/collab/http";
import { taskPushPreviewDetail } from "@/lib/collab/git/push-previews";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => taskPushPreviewDetail((await identity(request)).user.id, (await context.params).id));
}
