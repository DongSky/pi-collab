import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { sendNote, taskNotes } from "@/lib/collab/coordination";
import { noteInput } from "@/lib/collab/coordination-schema";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => taskNotes((await identity(request)).user.id, (await context.params).id, new URL(request.url).searchParams.get("after") ?? "0"));
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => sendNote((await identity(request)).user.id, (await context.params).id, noteInput.parse(await jsonBody(request))), 201);
}
