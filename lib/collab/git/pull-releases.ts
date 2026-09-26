import { z } from "zod";
import { asUser } from "../database";
import { pullReviewInput, pullReleaseInput, type PullReleaseContext, type PullReleaseJob } from "./pull-release-schema";
export function pullReleaseContext(userId:string,id:string):Promise<PullReleaseContext>{z.uuid().parse(id);return asUser(userId,async db=>(await db.query("SELECT collab.pull_release_context($1) AS result",[id])).rows[0].result);}
export function reviewPullRevision(userId:string,id:string,raw:z.input<typeof pullReviewInput>){z.uuid().parse(id);const {idempotencyKey,...payload}=pullReviewInput.parse(raw);return asUser(userId,async db=>(await db.query("SELECT collab.review_pull_revision($1,$2,$3) AS result",[id,idempotencyKey,payload])).rows[0].result);}
export function requestPullRelease(userId:string,id:string,raw:z.input<typeof pullReleaseInput>):Promise<PullReleaseJob>{z.uuid().parse(id);const {idempotencyKey,...payload}=pullReleaseInput.parse(raw);return asUser(userId,async db=>(await db.query("SELECT collab.request_pull_release($1,$2,$3) AS result",[id,idempotencyKey,payload])).rows[0].result);}
export function cancelPullRelease(userId:string,id:string){z.uuid().parse(id);return asUser(userId,async db=>(await db.query("SELECT collab.cancel_pull_release($1) AS result",[id])).rows[0].result);}
