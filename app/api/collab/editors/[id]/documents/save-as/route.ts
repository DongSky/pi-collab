import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { saveDocumentAs } from "@/lib/collab/editor";
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}) {
 return endpoint(request,async()=>saveDocumentAs((await identity(request)).user.id,(await params).id,await jsonBody(request)));
}
