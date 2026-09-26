import { endpoint, identity } from "@/lib/collab/http";
import { gitHubImportOptions } from "@/lib/collab/git/github-settings";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => gitHubImportOptions((await identity(request)).user.id, (await context.params).id));
}
