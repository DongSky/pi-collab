import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { publishContract } from "@/lib/collab/contracts";
import { publishContractInput } from "@/lib/collab/contract-schema";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => publishContract((await identity(request)).user.id, (await context.params).id, publishContractInput.parse(await jsonBody(request))), 201);
}
