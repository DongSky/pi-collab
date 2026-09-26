import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { requestWorkspaceGit, workspaceGitInput } from "@/lib/collab/git/workspace-operations";
import { workspaceGitState } from "@/lib/collab/git/workspace-preview";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => workspaceGitState((await identity(request)).user.id, (await context.params).id));
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => requestWorkspaceGit((await identity(request)).user.id, (await context.params).id, workspaceGitInput.parse(await jsonBody(request))), 202);
}
