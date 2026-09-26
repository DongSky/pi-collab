import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { pullRevisionContext, requestPullRevision } from "@/lib/collab/git/pull-revisions";
import { pullRevisionRequest } from "@/lib/collab/git/pull-revision-schema";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => pullRevisionContext((await identity(request)).user.id, (await context.params).id));
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => requestPullRevision((await identity(request)).user.id, (await context.params).id, pullRevisionRequest.parse(await jsonBody(request))), 202);
}
