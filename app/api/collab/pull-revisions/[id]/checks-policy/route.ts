import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { publishPullChecksPolicy } from "@/lib/collab/git/pull-checks";
import { checksPolicyInput } from "@/lib/collab/git/pull-checks-schema";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => publishPullChecksPolicy((await identity(request)).user.id, (await context.params).id, checksPolicyInput.parse(await jsonBody(request))), 201);
}
