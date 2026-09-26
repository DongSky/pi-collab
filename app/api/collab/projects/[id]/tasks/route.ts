import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { uuid } from "@/lib/collab/projects";
import { createTask, taskInput } from "@/lib/collab/tasks";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => {
    const { user } = await identity(request);
    return createTask(user.id, uuid.parse((await params).id), taskInput.parse(await jsonBody(request)));
  });
}
