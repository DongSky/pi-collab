import { endpoint, identity } from "@/lib/collab/http";
import { taskEditHistory } from "@/lib/collab/task-lifecycle";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => taskEditHistory((await identity(request)).user.id, (await params).id));
}
