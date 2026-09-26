import {endpoint} from "@/lib/collab/http";
type Context={params:Promise<{id:string}>};
import {identity} from "@/lib/collab/http";
import {revokeOidcBinding} from "@/lib/collab/oidc";
export async function DELETE(request:Request,{params}:Context){return endpoint(request,async()=>revokeOidcBinding((await identity(request)).user.id,(await params).id));}
