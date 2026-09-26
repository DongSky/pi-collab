import { endpoint, identity } from "@/lib/collab/http";
import { pullRevisionFile } from "@/lib/collab/git/pull-revisions";
import { revisionFileQuery } from "@/lib/collab/git/pull-revision-schema";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => pullRevisionFile((await identity(request)).user.id, (await context.params).id, revisionFileQuery.parse(Object.fromEntries(new URL(request.url).searchParams)), request.signal));
}
