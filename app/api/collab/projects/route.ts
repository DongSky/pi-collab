import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { createProject, listProjects, projectInput } from "@/lib/collab/projects";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return endpoint(request, async () => listProjects((await identity(request)).user.id));
}
export async function POST(request: Request) {
  return endpoint(request, async () => {
    const { user } = await identity(request);
    return createProject(user.id, projectInput.parse(await jsonBody(request)));
  });
}
