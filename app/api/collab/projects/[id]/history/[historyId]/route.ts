import { endpoint, identity } from "@/lib/collab/http";
import { readHistory, deleteHistory } from "@/lib/collab/history";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{id: string; historyId: string}> };
export function GET(request: Request, context: Context) {
  return endpoint(request, async () => { const {id,historyId}=await context.params; return readHistory((await identity(request)).user.id,id,historyId); });
}
export function DELETE(request: Request, context: Context) {
  return endpoint(request, async () => { const {id,historyId}=await context.params; return deleteHistory((await identity(request)).user.id,id,historyId); });
}
