import { endpoint, identity } from "@/lib/collab/http";
import { workspaceGitFile } from "@/lib/collab/git/workspace-preview";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => workspaceGitFile((await identity(request)).user.id, (await context.params).id, Object.fromEntries(new URL(request.url).searchParams), request.signal));
}
