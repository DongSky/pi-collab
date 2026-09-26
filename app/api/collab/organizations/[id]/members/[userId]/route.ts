import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { changeMember, memberInput } from "@/lib/collab/onboarding";
export async function PATCH(request: Request, context: { params: Promise<{ id: string; userId: string }> }) {
  return endpoint(request, async () => {
    const { id, userId } = await context.params;
    return changeMember((await identity(request)).user.id, id, userId, memberInput.parse(await jsonBody(request)));
  });
}
