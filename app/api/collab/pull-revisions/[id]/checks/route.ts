import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { requestPullChecks, pullChecksContext } from "@/lib/collab/git/pull-checks";
import { pullChecksRequest } from "@/lib/collab/git/pull-checks-schema";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => requestPullChecks((await identity(request)).user.id, (await context.params).id, pullChecksRequest.parse(await jsonBody(request))), 202);
}
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => pullChecksContext((await identity(request)).user.id, (await context.params).id));
}
