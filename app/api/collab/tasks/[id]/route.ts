import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { editTask, taskEditInput } from "@/lib/collab/task-lifecycle";
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => editTask((await identity(request)).user.id, (await params).id, taskEditInput.parse(await jsonBody(request))));
}
