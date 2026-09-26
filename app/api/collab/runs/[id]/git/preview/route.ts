import { endpoint, identity } from "@/lib/collab/http";
import { workspaceGitPreview } from "@/lib/collab/git/workspace-preview";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => workspaceGitPreview((await identity(request)).user.id, (await context.params).id, request.signal));
}
