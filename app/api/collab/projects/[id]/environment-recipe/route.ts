import {endpoint,identity,jsonBody} from "@/lib/collab/http";
import {environmentRecipe,publishEnvironmentRecipe} from "@/lib/collab/environments";
export async function GET(request:Request,context:{params:Promise<{id:string}>}){return endpoint(request,async()=>environmentRecipe((await identity(request)).user.id,(await context.params).id));}
export async function POST(request:Request,context:{params:Promise<{id:string}>}){return endpoint(request,async()=>publishEnvironmentRecipe((await identity(request)).user.id,(await context.params).id,await jsonBody(request)));}
