import {endpoint} from "@/lib/collab/http";
import {identity} from "@/lib/collab/http";
import {oidcBindings} from "@/lib/collab/oidc";
export async function GET(request:Request){return endpoint(request,async()=>({bindings:await oidcBindings((await identity(request)).user.id)}));}
