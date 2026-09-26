import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { requestTaskPullProposal, taskPullProposalContext } from "@/lib/collab/git/pull-proposals";
import { pullProposalRequest } from "@/lib/collab/git/pull-proposal-schema";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => taskPullProposalContext((await identity(request)).user.id, (await context.params).id));
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => requestTaskPullProposal((await identity(request)).user.id, (await context.params).id, pullProposalRequest.parse(await jsonBody(request, 200000))), 202);
}
