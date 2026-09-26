import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { discussions, discussionCommand } from "@/lib/collab/discussions";
import { discussionInput } from "@/lib/collab/discussion-schema";
import { reviewQueryJson, reviewSource } from "@/lib/collab/review-discussion-schema";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
 return endpoint(request, async () => discussions((await identity(request)).user.id, (await params).id, Number(new URL(request.url).searchParams.get("offset") ?? 0), new URL(request.url).searchParams.has("review") ? reviewQueryJson.pipe(reviewSource).parse(new URL(request.url).searchParams.get("review")) : undefined));
}
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
 return endpoint(request, async () => discussionCommand((await identity(request)).user.id, (await params).id, discussionInput.parse(await jsonBody(request))));
}
