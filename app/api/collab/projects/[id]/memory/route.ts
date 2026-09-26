import {endpoint,identity} from '@/lib/collab/http';
import {projectMemory} from '@/lib/collab/project-memory';
export function GET(r:Request,c:{params:Promise<{id:string}>}){return endpoint(r,async()=>projectMemory((await identity(r)).user.id,(await c.params).id));}
