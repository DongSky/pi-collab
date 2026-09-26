import { endpoint,identity,jsonBody } from "@/lib/collab/http";
type Context={params:Promise<{id:string}>};
import { openDocument,syncDocument,renameDocument } from "@/lib/collab/editor";
export async function POST(request:Request,{params}:Context){return endpoint(request,async()=>openDocument((await identity(request)).user.id,(await params).id,await jsonBody(request)));}
export async function PUT(request:Request,{params}:Context){return endpoint(request,async()=>syncDocument((await identity(request)).user.id,(await params).id,await jsonBody(request,3000000)));}

export async function PATCH(request:Request,{params}:Context){return endpoint(request,async()=>renameDocument((await identity(request)).user.id,(await params).id,await jsonBody(request)));}
