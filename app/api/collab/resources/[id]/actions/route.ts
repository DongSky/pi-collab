import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { manageResource } from "@/lib/collab/resources";
import { manageResourceInput } from "@/lib/collab/resource-schema";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => manageResource((await identity(request)).user.id, (await context.params).id, manageResourceInput.parse(await jsonBody(request))));
}
