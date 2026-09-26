import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { workspaceGitAction, workspaceGitActionInput } from "@/lib/collab/git/workspace-operations";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => workspaceGitAction((await identity(request)).user.id, (await context.params).id, workspaceGitActionInput.parse(await jsonBody(request))));
}
