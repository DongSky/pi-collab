import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { integrationPolicyInput, listIntegrationPolicies, publishIntegrationPolicy } from "@/lib/collab/integration-reviews";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => listIntegrationPolicies((await identity(request)).user.id, (await context.params).id));
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => publishIntegrationPolicy((await identity(request)).user.id, (await context.params).id, integrationPolicyInput.parse(await jsonBody(request))), 201);
}
