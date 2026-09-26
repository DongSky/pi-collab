import { z } from "zod";
import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { stopServicePreview } from "@/lib/collab/service-previews";
export function POST(request: Request, context: { params: Promise<{ id: string }> }) { return endpoint(request, async () => { const user = (await identity(request)).user.id, b = z.object({ reason: z.string() }).strict().parse(await jsonBody(request)); return stopServicePreview(user, (await context.params).id, b.reason); }); }
