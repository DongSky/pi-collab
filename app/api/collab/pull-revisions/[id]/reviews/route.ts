import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { reviewPullRevision, pullReleaseContext } from "@/lib/collab/git/pull-releases";
import { pullReviewInput } from "@/lib/collab/git/pull-release-schema";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) { return endpoint(request, async () => pullReleaseContext((await identity(request)).user.id,(await params).id)); }
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) { return endpoint(request, async () => reviewPullRevision((await identity(request)).user.id,(await params).id,pullReviewInput.parse(await jsonBody(request)))); }
