import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { createRevertTask, revertCatalogue, revertTaskInput } from "@/lib/collab/reverts";
import { DomainError } from "@/lib/collab/policy";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => revertCatalogue((await identity(request)).user.id, (await context.params).id));
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => {
    const user = (await identity(request)).user.id, project = (await context.params).id, input = revertTaskInput.parse(await jsonBody(request));
    const catalogue = await revertCatalogue(user, project);
    if (!catalogue.sources.some(source => source.promotion_id === input.promotionId)) throw new DomainError("not_found", "撤回来源不存在或不可访问。", 404);
    return createRevertTask(user, input);
  });
}
