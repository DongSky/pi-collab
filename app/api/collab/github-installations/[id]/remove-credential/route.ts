import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { removeGitHubCredential, disableGitHubInput } from "@/lib/collab/git/github-settings";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) { return endpoint(request, async () => removeGitHubCredential((await identity(request)).user.id,(await params).id,disableGitHubInput.parse(await jsonBody(request)))); }
