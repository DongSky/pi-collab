import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { gitHubSyncAction, gitHubSyncActionInput } from "@/lib/collab/git/github-settings";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => gitHubSyncAction((await identity(request)).user.id, (await context.params).id, gitHubSyncActionInput.parse(await jsonBody(request))), 202);
}
