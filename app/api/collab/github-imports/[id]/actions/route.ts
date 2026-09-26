import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { gitHubImportAction, gitHubImportActionInput } from "@/lib/collab/git/github-settings";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => gitHubImportAction((await identity(request)).user.id, (await context.params).id, gitHubImportActionInput.parse(await jsonBody(request))), 202);
}
