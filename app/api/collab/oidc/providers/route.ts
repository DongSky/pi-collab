import {endpoint} from "@/lib/collab/http";
import {oidcProviders} from "@/lib/collab/oidc";
export async function GET(request:Request){return endpoint(request,async()=>({providers:await oidcProviders()}));}
