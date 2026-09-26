import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { inbox, markInbox } from "@/lib/collab/discussions";
export async function GET(request: Request) {
 return endpoint(request, async () => inbox((await identity(request)).user.id, new URL(request.url).searchParams.get("before") ?? undefined));
}
export async function POST(request: Request) {
 return endpoint(request, async () => markInbox((await identity(request)).user.id, await jsonBody(request)));
}
