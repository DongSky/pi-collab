import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { confirmTaskPush, taskPushConfirmationContext } from "@/lib/collab/git/push-confirmations";
import { pushConfirmationRequest } from "@/lib/collab/git/push-confirmation-schema";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => taskPushConfirmationContext((await identity(request)).user.id, (await context.params).id));
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => confirmTaskPush((await identity(request)).user.id, (await context.params).id, pushConfirmationRequest.parse(await jsonBody(request, 256 * 1024)), request.signal));
}
