import { z } from "zod";
import { endpoint, identity } from "@/lib/collab/http";
import { readHistoryArchive } from "@/lib/collab/history-archives";
export function GET(request: Request, context: { params: Promise<{ id: string; archiveId: string; index: string }> }) {
  return endpoint(request, async () => { const p = await context.params; return readHistoryArchive((await identity(request)).user.id, p.id, p.archiveId, Number(z.string().regex(/^(?:[0-9]|1[0-9])$/).parse(p.index))); });
}
