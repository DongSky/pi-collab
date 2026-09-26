import {endpoint} from "@/lib/collab/http";
type Context={params:Promise<{id:string}>};
import {oidcRuntime} from "@/lib/collab/oidc";
import {DomainError} from "@/lib/collab/policy";
export async function GET(request:Request,{params}:Context){return endpoint(request,async()=>{const p=await oidcRuntime((await params).id);if(!p)throw new DomainError("not_found","Provider unavailable",404);return p.metadata;});}
