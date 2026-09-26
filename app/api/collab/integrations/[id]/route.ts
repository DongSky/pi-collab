import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { integrationDetail,cancelIntegration } from "@/lib/collab/integrations";
import { integrationCancelInput } from "@/lib/collab/integration-schema";
export async function GET(request:Request,context:{params:Promise<{id:string}>}){return endpoint(request,async()=>integrationDetail((await identity(request)).user.id,(await context.params).id));}
export async function POST(request:Request,context:{params:Promise<{id:string}>}){return endpoint(request,async()=>cancelIntegration((await identity(request)).user.id,(await context.params).id,integrationCancelInput.parse(await jsonBody(request))),202);}
