import {endpoint} from "@/lib/collab/http";
type Context={params:Promise<{id:string}>};
import {identity,jsonBody} from "@/lib/collab/http";
import {organizationOidc,configureOidc} from "@/lib/collab/oidc";
export async function GET(request:Request,{params}:Context){return endpoint(request,async()=>({providers:await organizationOidc((await identity(request)).user.id,(await params).id)}));}
export async function POST(request:Request,{params}:Context){return endpoint(request,async()=>configureOidc((await identity(request)).user.id,(await params).id,await jsonBody(request)));}
