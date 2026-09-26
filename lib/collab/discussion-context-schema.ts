import { z } from "zod";
import type { CodeAnchor } from "./discussion-schema";
import type { ReviewAnchor } from "./review-discussion-schema";
export const discussionContextSelection=z.object({threadId:z.uuid(),messageIds:z.array(z.string().regex(/^[1-9][0-9]{0,17}$/)).min(1).max(20).refine(ids=>new Set(ids).size===ids.length)}).strict();
export const discussionContextInstruction=discussionContextSelection.extend({
 expectedVersion:z.string().regex(/^[1-9][0-9]{0,17}$/),sourceHash:z.string().regex(/^[a-f0-9]{64}$/),
 kind:z.enum(["steer","follow_up"]),note:z.string().trim().min(1).max(2000),idempotencyKey:z.uuid(),
}).strict();
export type DiscussionContextInstruction=z.infer<typeof discussionContextInstruction>;
export type DiscussionContextPreview={controlVersion:string;sourceHash:string;source:{threadId:string;title:string;resolved:boolean;anchor:CodeAnchor|null;reviewAnchor:ReviewAnchor|null;messages:{id:string;authorId:string;authorName:string;body:string;createdAt:string}[]}};
export type DiscussionInstructionSource={threadId:string;title:string;messageIds:string[];sourceHash:string};
