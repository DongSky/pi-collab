import {randomUUID} from "node:crypto";
import type {Pool,PoolClient} from "pg";
import {z} from "zod";
import {GitLabClient,gitlabConnectionInput,GitLabError,type GitLabEvidence} from "./client";
import {sealCredential} from "../gateway/credentials";
async function grant(db:PoolClient,project:string,actor:string){
 await db.query("SELECT set_config('collab.user_id',$1,true)",[actor]);
 const r=(await db.query("SELECT p.organization_id,m.authorization_version::text AS org_version,pm.authorization_version::text AS project_version FROM collab.projects p JOIN collab.memberships m ON m.organization_id=p.organization_id AND m.user_id=collab.actor() AND m.active AND m.role IN ('owner','admin') JOIN collab.project_memberships pm ON pm.project_id=p.id AND pm.user_id=m.user_id AND pm.active AND pm.role='maintainer' WHERE p.id=$1 AND collab.actor_has_mfa()",[project])).rows[0];
 if(!r)throw new GitLabError('gitlab_admin_required');return r;
}
/** Explicit local operator provisioning; private token files never pass through Web or agent APIs.
 * Rotation keeps the remote project and imported history; it invalidates every queued operation's connection version. */
export async function registerGitLab(pool:Pool,master:Buffer,raw:unknown,token:string,transport?:typeof fetch,rotation?:{connectionId:string;expectedVersion:string}){
 const input=gitlabConnectionInput.parse(raw),client=new GitLabClient(input.origin,input.remoteId,token,transport),id=rotation?z.uuid().parse(rotation.connectionId):randomUUID();
 if(rotation)z.string().regex(/^[1-9][0-9]*$/).parse(rotation.expectedVersion);
 const db=await pool.connect();
 try{
  await db.query('BEGIN');const before=await grant(db,input.projectId,input.actorId);await db.query('COMMIT');
  const evidence=await client.inspect(AbortSignal.timeout(30000));
  await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,811))",[before.organization_id]);
  const current=await grant(db,input.projectId,input.actorId);if(JSON.stringify(before)!==JSON.stringify(current))throw new GitLabError('gitlab_authority_changed');
  if(rotation){
   const previous=(await db.query('SELECT * FROM collab.gitlab_connections WHERE id=$1 AND project_id=$2 FOR UPDATE',[id,input.projectId])).rows[0];
   if(!previous||String(previous.version)!==rotation.expectedVersion||previous.origin!==client.origin||previous.remote_id!==client.remoteId)throw new GitLabError('gitlab_connection_changed');
   // A replacement project access token may use a new bot, but cannot switch repository identity or visibility.
   client.assertIdentity({...previous.evidence,tokenUserId:evidence.tokenUserId} as GitLabEvidence,evidence);
   await db.query('UPDATE collab.gitlab_connections SET evidence=$2,version=version+1,name=$3 WHERE id=$1',[id,evidence,input.name]);
   await db.query('UPDATE collab_git.gitlab_credentials SET sealed=$2 WHERE connection_id=$1',[id,sealCredential(master,id,input.projectId,{apiKey:token,baseUrl:client.origin})]);
  }else{
   await db.query('INSERT INTO collab.gitlab_connections(id,organization_id,project_id,name,origin,remote_id,evidence,registered_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,before.organization_id,input.projectId,input.name,client.origin,client.remoteId,evidence,input.actorId]);
   await db.query('INSERT INTO collab_git.gitlab_credentials(connection_id,sealed) VALUES($1,$2)',[id,sealCredential(master,id,input.projectId,{apiKey:token,baseUrl:client.origin})]);
  }
  await db.query('INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES($1,$2,$3,$4,$5,$6)',[before.organization_id,input.projectId,input.actorId,rotation?'gitlab.credential_rotated':'gitlab.connection_registered',id,{reason:input.reason,origin:client.origin,remoteId:client.remoteId}]);
  await db.query('COMMIT');return{id,evidence};
 }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}
