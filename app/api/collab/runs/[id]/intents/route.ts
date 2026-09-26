import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { declareWorkIntent, runWorkIntents, workIntentInput } from "@/lib/collab/work-intents";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => runWorkIntents((await identity(request)).user.id, (await context.params).id));
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => declareWorkIntent((await identity(request)).user.id, (await context.params).id, workIntentInput.parse(await jsonBody(request))), 201);
}
