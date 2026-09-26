import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { languageQuery } from "@/lib/collab/editor-intelligence";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => languageQuery((await identity(request)).user.id, (await params).id, await jsonBody(request, 2 * 1024 * 1024)));
}
