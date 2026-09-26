import { endpoint, identity } from "@/lib/collab/http";
import { resultEvidence, resultEvidenceStatus } from "@/lib/collab/result-evidence";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => {
    const user = (await identity(request)).user.id, id = (await params).id;
    return new URL(request.url).searchParams.get("status") === "1" ? resultEvidenceStatus(user, id) : resultEvidence(user, id, request.signal);
  });
}
