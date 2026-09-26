import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { runControl, requestRunControl, controlRequestInput } from "@/lib/collab/run-control";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => runControl((await identity(request)).user.id, (await params).id));
}
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => requestRunControl((await identity(request)).user.id, (await params).id, controlRequestInput.parse(await jsonBody(request))));
}
