import { endpoint, jsonBody } from "@/lib/collab/http";
import { auth } from "@/lib/collab/auth";
import { acceptanceInput, acceptInvitation } from "@/lib/collab/onboarding";
export async function POST(request: Request) {
  return endpoint(request, async () => {
    const session = await auth().api.getSession({ headers: request.headers });
    return acceptInvitation(session?.user.id, acceptanceInput.parse(await jsonBody(request)));
  });
}
