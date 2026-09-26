import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { cancelTaskPullProposal } from "@/lib/collab/git/pull-proposals";
import { pullProposalCancel } from "@/lib/collab/git/pull-proposal-schema";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => cancelTaskPullProposal((await identity(request)).user.id, (await context.params).id, pullProposalCancel.parse(await jsonBody(request))), 202);
}
