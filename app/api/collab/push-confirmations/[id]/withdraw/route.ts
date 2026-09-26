import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { withdrawTaskPushConfirmation } from "@/lib/collab/git/push-confirmations";
import { pushConfirmationWithdrawal } from "@/lib/collab/git/push-confirmation-schema";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => withdrawTaskPushConfirmation((await identity(request)).user.id, (await context.params).id, pushConfirmationWithdrawal.parse(await jsonBody(request))));
}
