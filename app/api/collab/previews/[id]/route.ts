import {endpoint,identity,jsonBody} from '@/lib/collab/http';
import {openPreview,revokePreview} from '@/lib/collab/checkpoint-previews';
import {z} from 'zod';
export function POST(r:Request,c:{params:Promise<{id:string}>}){return endpoint(r,async()=>{const b=z.discriminatedUnion('action',[z.object({action:z.literal('open')}).strict(),z.object({action:z.literal('revoke'),reason:z.string()}).strict()]).parse(await jsonBody(r)),user=(await identity(r)).user.id,id=(await c.params).id;return b.action==='open'?openPreview(user,id):revokePreview(user,id,{reason:b.reason});});}
