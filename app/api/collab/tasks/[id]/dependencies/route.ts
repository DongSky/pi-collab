import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { uuid } from "@/lib/collab/projects";
import { addDependency, dependencyInput } from "@/lib/collab/tasks";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => {
    const { user } = await identity(request);
    return addDependency(user.id, uuid.parse((await params).id), dependencyInput.parse(await jsonBody(request)));
  });
}
