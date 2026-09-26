import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { organizationDetail, organizationAction, organizationActionInput } from "@/lib/collab/onboarding";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => organizationDetail((await identity(request)).user.id, (await context.params).id));
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => organizationAction((await identity(request)).user.id, (await context.params).id, organizationActionInput.parse(await jsonBody(request))));
}
