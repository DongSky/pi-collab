import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { listTaskResults, publishResult, publishResultInput } from "@/lib/collab/task-results";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => listTaskResults((await identity(request)).user.id, (await context.params).id));
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => publishResult((await identity(request)).user.id, (await context.params).id, publishResultInput.parse(await jsonBody(request))), 201);
}
