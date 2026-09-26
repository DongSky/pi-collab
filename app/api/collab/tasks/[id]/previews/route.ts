import {endpoint,identity,jsonBody} from '@/lib/collab/http';
import {listPreviews,createPreview} from '@/lib/collab/checkpoint-previews';
type Context={params:Promise<{id:string}>};
export function GET(r:Request,c:Context){return endpoint(r,async()=>listPreviews((await identity(r)).user.id,(await c.params).id));}
export function POST(r:Request,c:Context){return endpoint(r,async()=>createPreview((await identity(r)).user.id,(await c.params).id,await jsonBody(r)));}
