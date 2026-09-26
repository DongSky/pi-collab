import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { recoverProject, recoveryInput } from "@/lib/collab/project-members";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => recoverProject((await identity(request)).user.id, (await params).id, recoveryInput.parse(await jsonBody(request))));
}
