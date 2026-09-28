import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { getLocalBinding, setLocalBinding, removeLocalBinding } from "@/lib/collab/local-binding";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
 return endpoint(request, async () => {
  const user = (await identity(request)).user.id, { id } = await params;
  return getLocalBinding(user, id);
 });
}
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
 return endpoint(request, async () => {
  const user = (await identity(request)).user.id, { id } = await params;
  return setLocalBinding(user, id, await jsonBody(request));
 });
}
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
 return endpoint(request, async () => {
  const user = (await identity(request)).user.id, { id } = await params;
  return removeLocalBinding(user, id);
 });
}
