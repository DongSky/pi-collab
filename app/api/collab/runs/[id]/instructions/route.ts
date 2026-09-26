import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { submitRunInstruction, runInstructionInput } from "@/lib/collab/run-control";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => submitRunInstruction((await identity(request)).user.id, (await params).id, runInstructionInput.parse(await jsonBody(request))), 202);
}
