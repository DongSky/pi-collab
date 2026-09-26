import { endpoint, identity } from "@/lib/collab/http";
import { runDependencies } from "@/lib/collab/task-results";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => runDependencies((await identity(request)).user.id, (await context.params).id));
}
