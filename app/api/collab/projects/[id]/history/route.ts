import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { importHistory, listHistory } from "@/lib/collab/history";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{id: string}> };
export function GET(request: Request, context: Context) {
  return endpoint(request, async () => listHistory((await identity(request)).user.id,(await context.params).id));
}
export function POST(request: Request, context: Context) {
  return endpoint(request, async () => importHistory((await identity(request)).user.id,(await context.params).id,await jsonBody(request,512*1024)));
}
