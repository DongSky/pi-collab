import { endpoint, identity } from "@/lib/collab/http";
import { revokeInvitation } from "@/lib/collab/onboarding";
export async function DELETE(request: Request, context: { params: Promise<{ id: string; invitationId: string }> }) {
  return endpoint(request, async () => {
    const { id, invitationId } = await context.params;
    return revokeInvitation((await identity(request)).user.id, id, invitationId);
  });
}
