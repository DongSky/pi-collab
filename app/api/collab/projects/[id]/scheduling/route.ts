import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { configureScheduling, schedulingContext } from "@/lib/collab/scheduling";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => schedulingContext((await identity(request)).user.id, (await context.params).id));
}
export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => configureScheduling((await identity(request)).user.id, (await context.params).id, await jsonBody(request)));
}
