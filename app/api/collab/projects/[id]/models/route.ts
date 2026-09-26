import { endpoint, identity } from "@/lib/collab/http";
import { listModelProfiles } from "@/lib/collab/gateway/profiles";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => listModelProfiles((await identity(request)).user.id, (await params).id));
}
