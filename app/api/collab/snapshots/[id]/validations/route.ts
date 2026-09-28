import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { requestValidation, requestQuickValidation } from "@/lib/collab/validations";
import { validationInput, quickValidationInput } from "@/lib/collab/validation-config";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => {
    const userId = (await identity(request)).user.id;
    const snapshotId = (await context.params).id;
    const body = await jsonBody(request) as { command?: unknown };
    // Quick mode: {command, idempotencyKey} - run a command directly without a saved profile
    if (typeof body?.command === "string") {
      return requestQuickValidation(userId, snapshotId, quickValidationInput.parse(body));
    }
    return requestValidation(userId, snapshotId, validationInput.parse(body));
  }, 202);
}
