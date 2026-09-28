import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { saveDocumentAsLocal } from "@/lib/collab/local-binding";
export async function POST(request: Request, { params }: { params: Promise<{ id: string; docId: string }> }) {
 return endpoint(request, async () => {
  const user = (await identity(request)).user.id, { id, docId } = await params;
  return saveDocumentAsLocal(user, id, docId, await jsonBody(request));
 });
}
