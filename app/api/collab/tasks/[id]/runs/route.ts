import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { listRuns, runInput, startRun } from "@/lib/collab/runs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => listRuns((await identity(request)).user.id, (await context.params).id));
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => startRun((await identity(request)).user.id, (await context.params).id, runInput.parse(await jsonBody(request))), 202);
}
