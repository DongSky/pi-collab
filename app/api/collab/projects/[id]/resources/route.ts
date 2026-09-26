import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { createResource, projectResources } from "@/lib/collab/resources";
import { createResourceInput } from "@/lib/collab/resource-schema";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => projectResources((await identity(request)).user.id, (await context.params).id));
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => createResource((await identity(request)).user.id, (await context.params).id, createResourceInput.parse(await jsonBody(request))), 201);
}
