import { endpoint, identity } from "@/lib/collab/http";
import { taskPushHistoryDownload } from "@/lib/collab/git/push-preview-history";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => taskPushHistoryDownload((await identity(request)).user.id, (await context.params).id, Object.fromEntries(new URL(request.url).searchParams), request.signal));
}
