import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { cancelPullChecks } from "@/lib/collab/git/pull-checks";
import { pullChecksCancel } from "@/lib/collab/git/pull-checks-schema";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => cancelPullChecks((await identity(request)).user.id, (await context.params).id, pullChecksCancel.parse(await jsonBody(request))), 200);
}
