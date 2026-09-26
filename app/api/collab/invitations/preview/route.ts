import { endpoint, jsonBody } from "@/lib/collab/http";
import { previewInput, previewInvitation } from "@/lib/collab/onboarding";
export async function POST(request: Request) {
  return endpoint(request, async () => previewInvitation(previewInput.parse(await jsonBody(request)).token));
}
