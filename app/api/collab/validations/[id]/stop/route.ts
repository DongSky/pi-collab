import { endpoint, identity } from "@/lib/collab/http";
import { cancelValidation } from "@/lib/collab/validations";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => cancelValidation((await identity(request)).user.id, (await context.params).id));
}
