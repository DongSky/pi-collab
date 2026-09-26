import { endpoint, identity } from "@/lib/collab/http";
import { readHistoryArchive, deleteHistoryArchive } from "@/lib/collab/history-archives";
type Context = { params: Promise<{ id: string; archiveId: string }> };
export function GET(request: Request, context: Context) {
  return endpoint(request, async () => { const p = await context.params; return readHistoryArchive((await identity(request)).user.id, p.id, p.archiveId); });
}
export function DELETE(request: Request, context: Context) {
  return endpoint(request, async () => { const p = await context.params; return deleteHistoryArchive((await identity(request)).user.id, p.id, p.archiveId); });
}
