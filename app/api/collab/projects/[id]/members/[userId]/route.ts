import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { changeProjectMember, changeProjectMemberInput } from "@/lib/collab/project-members";
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string; userId: string }> }) {
  return endpoint(request, async () => {
    const { id, userId } = await params;
    return changeProjectMember((await identity(request)).user.id, id, userId, changeProjectMemberInput.parse(await jsonBody(request)));
  });
}
