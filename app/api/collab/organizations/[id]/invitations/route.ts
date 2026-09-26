import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { createInvitation, invitationInput } from "@/lib/collab/onboarding";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => createInvitation((await identity(request)).user.id, (await context.params).id, invitationInput.parse(await jsonBody(request))));
}
