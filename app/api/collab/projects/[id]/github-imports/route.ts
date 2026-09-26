import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { listGitHubImports, requestGitHubImport, requestGitHubImportInput } from "@/lib/collab/git/github-settings";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => listGitHubImports((await identity(request)).user.id, (await context.params).id));
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => requestGitHubImport((await identity(request)).user.id, (await context.params).id, requestGitHubImportInput.parse(await jsonBody(request))), 202);
}
