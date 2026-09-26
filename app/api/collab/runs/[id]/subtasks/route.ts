import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { proposeSubtask } from "@/lib/collab/subtasks";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) { return endpoint(request, async () => proposeSubtask((await identity(request)).user.id, (await params).id, await jsonBody(request))); }
