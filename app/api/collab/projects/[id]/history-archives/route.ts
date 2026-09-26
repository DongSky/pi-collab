import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { listHistoryArchives, importHistoryArchive } from "@/lib/collab/history-archives";
type Context = { params: Promise<{ id: string }> };
export function GET(request: Request, context: Context) {
  return endpoint(request, async () => listHistoryArchives((await identity(request)).user.id, (await context.params).id));
}
export function POST(request: Request, context: Context) {
  return endpoint(request, async () => importHistoryArchive((await identity(request)).user.id, (await context.params).id, await jsonBody(request, 64 * 1024 * 1024)));
}
