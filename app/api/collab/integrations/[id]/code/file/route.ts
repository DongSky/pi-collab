import { endpoint, identity } from "@/lib/collab/http";
import { integrationCodeFile } from "@/lib/collab/integration-code";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => integrationCodeFile((await identity(request)).user.id, (await context.params).id, Object.fromEntries(new URL(request.url).searchParams), request.signal));
}
