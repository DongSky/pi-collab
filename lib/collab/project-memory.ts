import {z} from 'zod';
import {asUser} from './database';
import {projectRole} from './projects';
import {humanMemoryProposal,memoryDecision} from './memory-schema';
export function projectMemory(user:string,project:string){z.uuid().parse(project);return asUser(user,async db=>{const role=await projectRole(db,project,'project.read');return{role,entries:(await db.query('SELECT m.*,u.name AS author_name FROM collab.project_memory m JOIN public."user" u ON u.id=m.author_id WHERE m.project_id=$1 ORDER BY m.created_at DESC,m.id LIMIT 200',[project])).rows,repositories:(await db.query('SELECT id,name,base_sha FROM collab.repositories WHERE project_id=$1 ORDER BY name',[project])).rows};});}
export function proposeMemory(user:string,task:string,raw:unknown){z.uuid().parse(task);const input=humanMemoryProposal.parse(raw);return asUser(user,async db=>(await db.query('SELECT collab.propose_memory($1,$2) AS result',[task,input])).rows[0].result);}
export function decideMemory(user:string,id:string,raw:unknown){z.uuid().parse(id);const b=memoryDecision.parse(raw);return asUser(user,async db=>{await db.query('SELECT collab.decide_memory($1,$2,$3,$4,$5)',[id,b.expectedRevision,b.bodyHash,b.decision,b.note]);return{ok:true};});}
