import { z } from "zod";
const hash=z.string().regex(/^[a-f0-9]{64}$/);
export const pullReviewInput=z.object({idempotencyKey:z.uuid(),diffHash:hash,decision:z.enum(["approve","changes_requested","comment"]),body:z.string().trim().min(10).max(4000)}).strict();
export const pullReleaseInput=z.object({idempotencyKey:z.uuid(),diffHash:hash,expectedTaskVersion:z.number().int().positive(),action:z.enum(["ready","merge"]),reason:z.string().trim().min(10).max(2000),acknowledge:z.literal(true)}).strict();
export type ReleaseReceipt={status:"ready"|"merged"|"rejected"|"not_sent"|"unknown";sha:string|null;failure:string|null;tokenRevoked:boolean};
export type PullReview={id:string;actorName:string;decision:string;body:string;createdAt:string;valid?:boolean};
export type PullReleaseJob={jobId:string;revisionId:string;action:string;status:string;failure:string|null;result:ReleaseReceipt|null;createdAt:string;finishedAt:string|null;actorName:string;headSha:string;baseSha:string};
export type PullReleaseContext={current:boolean;taskVersion:number;diffHash:string;headSha:string;baseSha:string;draft:boolean;canReview:boolean;independent:boolean;canRelease:boolean;eligible:boolean;votes:PullReview[];reviews:PullReview[];jobs:PullReleaseJob[]};
