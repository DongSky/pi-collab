import { endpoint, identity } from "@/lib/collab/http";
import { validationDetail } from "@/lib/collab/validations";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => validationDetail((await identity(request)).user.id, (await context.params).id));
}
