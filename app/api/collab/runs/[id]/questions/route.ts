import { endpoint, identity } from "@/lib/collab/http";
import { runQuestions } from "@/lib/collab/run-questions";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => runQuestions((await identity(request)).user.id, (await context.params).id));
}
