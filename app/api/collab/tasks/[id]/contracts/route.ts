import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { proposeContract, taskContracts } from "@/lib/collab/contracts";
import { proposalInput } from "@/lib/collab/contract-schema";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => taskContracts((await identity(request)).user.id, (await context.params).id));
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => proposeContract((await identity(request)).user.id, (await context.params).id, proposalInput.parse(await jsonBody(request))), 201);
}
