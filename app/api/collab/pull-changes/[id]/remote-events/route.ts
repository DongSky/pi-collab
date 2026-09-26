import { endpoint, identity } from "@/lib/collab/http";
import { pullRemoteEvents } from "@/lib/collab/git/github-webhook";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => pullRemoteEvents((await identity(request)).user.id, (await context.params).id));
}
