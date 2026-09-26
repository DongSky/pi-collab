import { z } from "zod";
import { asUser } from "./database";
import { uuid } from "./projects";
export const modelAction=z.object({action:z.enum(["enable","disable","remove_credential"]),reason:z.string().trim().min(10).max(2000),expectedVersion:z.number().int().positive(),idempotencyKey:z.uuid()}).strict();
export function administration(user:string,org:string,query:string,before:string|null){uuid.parse(org);z.string().max(100).parse(query);if(before)z.string().regex(/^[1-9][0-9]{0,17}$/).parse(before);return asUser(user,async db=>{
 const result=(await db.query("SELECT collab.admin_overview($1,$2,$3) AS result",[org,query,before])).rows[0].result;
 const transport=process.env.PI_COLLAB_MAIL_TRANSPORT;return {...result,mail:{transport:transport==="smtp"?"smtp":transport==="file"?"file":"unconfigured",configured:transport==="file"?process.env.NODE_ENV!=="production":transport==="smtp"&&!!process.env.SMTP_URL&&!!process.env.SMTP_FROM}};
});}
export function manageModel(user:string,profile:string,input:unknown){uuid.parse(profile);const body=modelAction.parse(input);return asUser(user,async db=>(await db.query("SELECT collab.manage_model($1,$2) AS result",[profile,body])).rows[0].result);}
export const dispositionInput=z.object({reason:z.string().trim().min(10).max(2000),expectedRevision:z.string().regex(/^[1-9][0-9]{0,17}$/),idempotencyKey:z.uuid()}).strict();
export function recordDisposition(user:string,run:string,input:unknown){uuid.parse(run);const body=dispositionInput.parse(input);return asUser(user,async db=>(await db.query("SELECT collab.record_run_disposition($1,$2,$3,$4) AS result",[run,body.reason,body.expectedRevision,body.idempotencyKey])).rows[0].result);}
