import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { createValidationProfile, listValidationProfiles } from "@/lib/collab/validations";
import { validationProfileInput } from "@/lib/collab/validation-config";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => listValidationProfiles((await identity(request)).user.id, (await context.params).id));
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => createValidationProfile((await identity(request)).user.id, (await context.params).id, validationProfileInput.parse(await jsonBody(request))), 201);
}
