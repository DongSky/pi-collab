import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { requestPullRelease, pullReleaseContext } from "@/lib/collab/git/pull-releases";
import { pullReleaseInput } from "@/lib/collab/git/pull-release-schema";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) { return endpoint(request, async () => pullReleaseContext((await identity(request)).user.id,(await params).id)); }
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) { return endpoint(request, async () => requestPullRelease((await identity(request)).user.id,(await params).id,pullReleaseInput.parse(await jsonBody(request)))); }
