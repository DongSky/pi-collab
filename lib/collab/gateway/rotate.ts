import type {Pool} from "pg";
import {z} from "zod";
import {sealCredential,type ProviderSecret} from "./credentials";
export async function rotateModelCredential(db:Pool,key:Buffer,raw:{profileId:string;actorId:string;expectedVersion:number;reason:string},secret:ProviderSecret){
 const input=z.object({profileId:z.uuid(),actorId:z.string().min(1),expectedVersion:z.number().int().positive(),reason:z.string().trim().min(10).max(2000)}).strict().parse(raw),client=await db.connect();
 try{await client.query("BEGIN");await client.query("SELECT set_config('collab.user_id',$1,true)",[input.actorId]);const m=(await client.query("SELECT project_id FROM collab.model_profiles WHERE id=$1",[input.profileId])).rows[0];if(!m)throw new Error("model_unavailable");
 await client.query("SELECT collab.require_project_management($1)",[m.project_id]);if(!(await client.query("SELECT collab.actor_has_mfa() AS ok")).rows[0].ok)throw new Error("mfa_required");
 const p=(await client.query("SELECT * FROM collab.model_profiles WHERE id=$1 FOR UPDATE",[input.profileId])).rows[0];if(p.version!==input.expectedVersion)throw new Error("stale_revision");
 await client.query("INSERT INTO collab_gateway.credentials(profile_id,sealed) VALUES($1,$2) ON CONFLICT(profile_id) DO UPDATE SET sealed=excluded.sealed",[p.id,sealCredential(key,p.id,p.project_id,secret)]);
 await client.query("UPDATE collab.model_profiles SET version=version+1 WHERE id=$1",[p.id]);await client.query("UPDATE collab_gateway.capabilities SET revoked=true WHERE run_id IN (SELECT id FROM collab.runs WHERE model_profile_id=$1)",[p.id]);
 await client.query("INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES($1,$2,$3,'model.credential_rotated',$4,$5)",[p.organization_id,p.project_id,input.actorId,p.id,{reason:input.reason,version:p.version+1,authority:"local-administrator-cli"}]);await client.query("COMMIT");return {profileId:p.id,version:p.version+1,enabled:p.enabled};
 }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
}
