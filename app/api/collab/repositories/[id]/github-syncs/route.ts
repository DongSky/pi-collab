import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { requestGitHubSync, requestGitHubSyncInput } from "@/lib/collab/git/github-settings";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => requestGitHubSync((await identity(request)).user.id, (await context.params).id, requestGitHubSyncInput.parse(await jsonBody(request))), 202);
}
