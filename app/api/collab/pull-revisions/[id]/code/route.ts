import { endpoint, identity } from "@/lib/collab/http";
import { pullRevisionCode } from "@/lib/collab/git/pull-revisions";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => pullRevisionCode((await identity(request)).user.id, (await context.params).id, Object.fromEntries(new URL(request.url).searchParams), request.signal));
}
