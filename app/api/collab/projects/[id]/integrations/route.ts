import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { requestIntegration,listIntegrations } from "@/lib/collab/integrations";
import { integrationInput } from "@/lib/collab/integration-schema";
export async function GET(request:Request,context:{params:Promise<{id:string}>}){return endpoint(request,async()=>listIntegrations((await identity(request)).user.id,(await context.params).id));}
export async function POST(request:Request,context:{params:Promise<{id:string}>}){return endpoint(request,async()=>requestIntegration((await identity(request)).user.id,(await context.params).id,integrationInput.parse(await jsonBody(request))),202);}
