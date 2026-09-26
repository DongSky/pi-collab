import {endpoint,identity,jsonBody} from '@/lib/collab/http';
import {proposeMemory} from '@/lib/collab/project-memory';
export function POST(r:Request,c:{params:Promise<{id:string}>}){return endpoint(r,async()=>proposeMemory((await identity(r)).user.id,(await c.params).id,await jsonBody(r)));}
