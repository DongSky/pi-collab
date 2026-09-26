import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { applyEditorChanges, previewReplace } from "@/lib/collab/editor-intelligence";
type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, { params }: Context) {
  return endpoint(request, async () => previewReplace((await identity(request)).user.id, (await params).id, await jsonBody(request)));
}
export async function PATCH(request: Request, { params }: Context) {
  return endpoint(request, async () => applyEditorChanges((await identity(request)).user.id, (await params).id, await jsonBody(request, 24 * 1024 * 1024)));
}
