import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { artifactContext, manageArtifacts } from "@/lib/collab/artifacts";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => artifactContext((await identity(request)).user.id, (await context.params).id));
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => manageArtifacts((await identity(request)).user.id, (await context.params).id, await jsonBody(request)));
}
