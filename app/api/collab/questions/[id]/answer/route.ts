import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { answerQuestion } from "@/lib/collab/run-questions";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => answerQuestion((await identity(request)).user.id, (await context.params).id, await jsonBody(request)));
}
