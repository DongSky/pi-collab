import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { capacityContext, configureCapacity } from "@/lib/collab/capacity";
export async function GET(request:Request,context:{params:Promise<{id:string}>}) {
 return endpoint(request,async()=>capacityContext((await identity(request)).user.id,(await context.params).id));
}
export async function PUT(request:Request,context:{params:Promise<{id:string}>}) {
 return endpoint(request,async()=>configureCapacity((await identity(request)).user.id,(await context.params).id,await jsonBody(request)));
}
