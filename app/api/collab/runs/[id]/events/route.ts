import { endpoint, identity } from "@/lib/collab/http";
import { runTranscript } from "@/lib/collab/runs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => runTranscript((await identity(request)).user.id, (await params).id));
}
