import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { disableGitHubInput, disableGitHubInstallation } from "@/lib/collab/git/github-settings";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => disableGitHubInstallation((await identity(request)).user.id, (await context.params).id, disableGitHubInput.parse(await jsonBody(request))));
}
