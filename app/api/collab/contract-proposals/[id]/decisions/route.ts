import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { decideContract } from "@/lib/collab/contracts";
import { decisionInput } from "@/lib/collab/contract-schema";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => decideContract((await identity(request)).user.id, (await context.params).id, decisionInput.parse(await jsonBody(request))), 201);
}
