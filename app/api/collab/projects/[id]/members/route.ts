import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { addProjectMember, addProjectMemberInput, projectMembers } from "@/lib/collab/project-members";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => projectMembers((await identity(request)).user.id, (await params).id));
}
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => addProjectMember((await identity(request)).user.id, (await params).id, addProjectMemberInput.parse(await jsonBody(request))), 201);
}
