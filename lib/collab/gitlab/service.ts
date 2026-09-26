import {z} from "zod";
import {asUser} from "../database";
import {projectRole} from "../projects";
import {DomainError} from "../policy";
import {readGitLabPlan} from "./plan";
import path from "node:path";
import {gitlabOperationInput} from "./schema";
export {gitlabOperationInput} from "./schema";
export async function gitlabProject(user:string,project:string){z.uuid().parse(project);return asUser(user,async db=>{
 await projectRole(db,project,'project.read');
 const connections=(await db.query("SELECT id,name,origin,remote_id,evidence,repository_id,version::text,enabled FROM collab.gitlab_connections WHERE project_id=$1 ORDER BY created_at,id",[project])).rows;
 const operations=(await db.query("SELECT id,connection_id,kind,actor_id,source_id,result_id,status,stage,result,failure,created_at,updated_at FROM collab.gitlab_operations WHERE project_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50",[project])).rows;
 const reviews=(await db.query('SELECT r.*,u.name AS reviewer_name FROM collab.gitlab_reviews r JOIN collab.gitlab_operations o ON o.id=r.operation_id JOIN public."user" u ON u.id=r.reviewer_id WHERE o.project_id=$1',[project])).rows;
 const results=(await db.query("SELECT r.id,r.task_id,r.version,t.title,w.repository_id,(collab.project_role(t.project_id)='maintainer' OR t.owner_id=collab.actor()) AS can_prepare FROM collab.task_results r JOIN collab.tasks t ON t.current_result_id=r.id JOIN collab.snapshots s ON s.id=r.snapshot_id JOIN collab.workspaces w ON w.id=s.workspace_id JOIN collab.gitlab_connections c ON c.repository_id=w.repository_id WHERE r.project_id=$1 AND NOT EXISTS(SELECT 1 FROM collab.result_withdrawals WHERE result_id=r.id) ORDER BY r.created_at DESC LIMIT 100",[project])).rows;
 const role=(await db.query("SELECT collab.project_role($1) AS role,collab.org_role(organization_id) IN ('owner','admin') AS admin FROM collab.projects WHERE id=$1",[project])).rows[0];
 return{connections,operations,reviews,results,role:role.role,canManage:role.role==='maintainer'&&role.admin};
 });}
export function requestGitLab(user:string,project:string,connection:string,raw:unknown){z.uuid().parse(project);z.uuid().parse(connection);const body=gitlabOperationInput.parse(raw);return asUser(user,async db=>(await db.query('SELECT collab.request_gitlab_operation($1,$2,$3) AS result',[project,connection,body])).rows[0].result);}
export async function gitlabPlan(user:string,id:string){z.uuid().parse(id);const load=()=>asUser(user,async db=>{const row=(await db.query("SELECT result->>'planHash' AS hash FROM collab.gitlab_operations WHERE id=$1 AND kind='prepare' AND status='completed'",[id])).rows[0];if(!row)throw new DomainError('not_found','投递预览不存在或不可访问。',404);return row.hash as string;});const hash=await load(),plan=await readGitLabPlan(process.env.PI_COLLAB_DATA_DIR??path.resolve(".local"),id,hash);await load();return{plan,planHash:hash};}
export const gitlabReviewInput=z.object({planHash:z.string().regex(/^[a-f0-9]{64}$/),decision:z.enum(['approve','reject']),note:z.string().trim().min(10).max(2000)}).strict();
export function reviewGitLab(user:string,id:string,raw:unknown){z.uuid().parse(id);const b=gitlabReviewInput.parse(raw);return asUser(user,async db=>{await db.query('SELECT collab.gitlab_review($1,$2,$3,$4)',[id,b.planHash,b.decision,b.note]);return{ok:true};});}
export const gitlabConnectionAction=z.object({expectedVersion:z.string().regex(/^[1-9][0-9]*$/),enabled:z.boolean(),reason:z.string().trim().min(10).max(2000)}).strict();
export function changeGitLabConnection(user:string,id:string,raw:unknown){z.uuid().parse(id);const b=gitlabConnectionAction.parse(raw);return asUser(user,async db=>{await db.query('SELECT collab.gitlab_connection_action($1,$2,$3,$4)',[id,b.expectedVersion,b.enabled,b.reason]);return{ok:true};});}
