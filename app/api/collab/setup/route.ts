import { endpoint, jsonBody } from "@/lib/collab/http";
import { bootstrap, bootstrapInput, setupStatus } from "@/lib/collab/onboarding";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return endpoint(request, setupStatus); }
export async function POST(request: Request) {
  return endpoint(request, async () => bootstrap(bootstrapInput.parse(await jsonBody(request))));
}
