import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { configureRuntimePolicy, runtimePolicyContext } from "@/lib/collab/runtime-policy";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => runtimePolicyContext((await identity(request)).user.id, (await context.params).id));
}
export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => configureRuntimePolicy((await identity(request)).user.id, (await context.params).id, await jsonBody(request)));
}
