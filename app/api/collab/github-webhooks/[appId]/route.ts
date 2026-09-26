import { githubWebhookResponse } from "@/lib/collab/git/github-webhook";
export async function POST(request: Request, context: { params: Promise<{ appId: string }> }) {
  return githubWebhookResponse(request, (await context.params).appId);
}
