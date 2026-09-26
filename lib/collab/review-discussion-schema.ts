import { z } from "zod";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const reviewSource = z.object({ kind: z.enum(["pull", "integration"]), sourceId: z.uuid(), sourceHash: hash, diffHash: hash, path: z.string().min(1).max(1024) }).strict();
export const reviewAnchor = reviewSource.extend({ side: z.enum(["before", "after"]), startLine: z.number().int().min(1).max(8000), endLine: z.number().int().min(1).max(8000) }).strict().refine(a => a.endLine >= a.startLine);
export type ReviewSource = z.infer<typeof reviewSource>;
export type ReviewAnchor = z.infer<typeof reviewAnchor>;
export type ReviewDiscussionContext = { userId: string; sourceHash: string; tasks: { id: string; title: string }[]; members: { user_id: string; name: string }[] };

export const reviewQueryJson = z.string().max(8192).transform((value,ctx): unknown => {
 try { return JSON.parse(value); } catch { ctx.addIssue({code:"custom",message:"评论来源参数格式不正确。"}); return z.NEVER; }
});
