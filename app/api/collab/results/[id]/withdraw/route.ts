import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { withdrawResult, withdrawResultInput } from "@/lib/collab/task-results";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => withdrawResult((await identity(request)).user.id, (await context.params).id, withdrawResultInput.parse(await jsonBody(request))));
}
