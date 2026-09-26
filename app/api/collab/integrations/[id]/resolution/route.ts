import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { createResolutionInput, createResolutionTask } from "@/lib/collab/resolutions";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => createResolutionTask((await identity(request)).user.id, (await context.params).id, createResolutionInput.parse(await jsonBody(request))), 201);
}
