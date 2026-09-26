import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { configureSubtasks } from "@/lib/collab/subtasks";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) { return endpoint(request, async () => configureSubtasks((await identity(request)).user.id, (await params).id, await jsonBody(request))); }
