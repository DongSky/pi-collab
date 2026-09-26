import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { reassignTask, reassignTaskInput } from "@/lib/collab/project-members";
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => reassignTask((await identity(request)).user.id, (await params).id, reassignTaskInput.parse(await jsonBody(request))));
}
