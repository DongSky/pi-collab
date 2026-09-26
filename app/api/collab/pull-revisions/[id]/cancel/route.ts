import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { cancelPullRevision } from "@/lib/collab/git/pull-revisions";
import { pullRevisionCancel } from "@/lib/collab/git/pull-revision-schema";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => cancelPullRevision((await identity(request)).user.id, (await context.params).id, pullRevisionCancel.parse(await jsonBody(request))), 202);
}
