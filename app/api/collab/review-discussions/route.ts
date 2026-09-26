import { endpoint, identity } from "@/lib/collab/http";
import { reviewDiscussionContext, reviewDiscussionCode } from "@/lib/collab/review-discussions";
import { reviewAnchor, reviewQueryJson } from "@/lib/collab/review-discussion-schema";
export async function GET(request: Request) {
  return endpoint(request, async () => {
    const user = (await identity(request)).user.id, q = new URL(request.url).searchParams;
    if (q.has("anchor")) return reviewDiscussionCode(user, reviewQueryJson.pipe(reviewAnchor).parse(q.get("anchor")));
    return reviewDiscussionContext(user, q.get("kind") ?? "", q.get("sourceId") ?? "");
  });
}
