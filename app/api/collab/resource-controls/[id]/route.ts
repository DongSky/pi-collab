import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { controlResource } from "@/lib/collab/resources";
import { controlResourceInput } from "@/lib/collab/resource-schema";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => controlResource((await identity(request)).user.id, (await context.params).id, controlResourceInput.parse(await jsonBody(request))), 202);
}
