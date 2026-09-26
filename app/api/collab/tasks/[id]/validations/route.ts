import { endpoint, identity } from "@/lib/collab/http";
import { listValidations } from "@/lib/collab/validations";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => listValidations((await identity(request)).user.id, (await context.params).id));
}
