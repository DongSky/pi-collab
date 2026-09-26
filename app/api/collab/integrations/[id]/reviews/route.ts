import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { integrationReviewInput, submitIntegrationReview } from "@/lib/collab/integration-reviews";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => submitIntegrationReview((await identity(request)).user.id, (await context.params).id, integrationReviewInput.parse(await jsonBody(request))), 201);
}
