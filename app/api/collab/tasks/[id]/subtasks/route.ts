import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { subtaskContext, actOnSubtasks } from "@/lib/collab/subtasks";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) { return endpoint(request, async () => subtaskContext((await identity(request)).user.id, (await params).id)); }
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) { return endpoint(request, async () => actOnSubtasks((await identity(request)).user.id, (await params).id, await jsonBody(request))); }
