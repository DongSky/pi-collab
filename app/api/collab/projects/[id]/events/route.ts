import { endpoint, identity } from "@/lib/collab/http";
import { runFeed } from "@/lib/collab/runs";
import { streamRunEvents } from "@/lib/collab/run-stream";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const after = request.headers.get("last-event-id") ?? new URL(request.url).searchParams.get("after") ?? "0";
  const authorized = await endpoint(request, async () => runFeed((await identity(request)).user.id, id, after));
  if (!authorized.ok || !request.headers.get("accept")?.includes("text/event-stream")) return authorized;
  return streamRunEvents(request, id, after);
}
