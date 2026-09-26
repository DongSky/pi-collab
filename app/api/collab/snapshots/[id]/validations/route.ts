import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { requestValidation } from "@/lib/collab/validations";
import { validationInput } from "@/lib/collab/validation-config";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => requestValidation((await identity(request)).user.id, (await context.params).id, validationInput.parse(await jsonBody(request))), 202);
}
