import { z } from "zod";
import { asUser } from "./database";
import { DomainError } from "./policy";
import { integrationCodeFile } from "./integration-code";
import { pullRevisionFile } from "./git/pull-revisions";
import { reviewAnchor, type ReviewAnchor, type ReviewDiscussionContext } from "./review-discussion-schema";
export async function reviewDiscussionContext(userId: string, kind: string, id: string): Promise<ReviewDiscussionContext> {
  z.enum(["pull", "integration"]).parse(kind); z.uuid().parse(id);
  return asUser(userId, async db => (await db.query("SELECT collab.review_discussion_context($1,$2) AS result", [kind,id])).rows[0].result);
}
export async function reviewDiscussionCode(userId: string, raw: ReviewAnchor) {
  const a = reviewAnchor.parse(raw), context = await reviewDiscussionContext(userId, a.kind, a.sourceId);
  if (context.sourceHash !== a.sourceHash) throw new DomainError("stale_revision", "评论来源版本不匹配，请重新读取固定差异。", 409);
  const query = { path: a.path, diffHash: a.diffHash };
  const file = a.kind === "pull" ? await pullRevisionFile(userId, a.sourceId, query) : await integrationCodeFile(userId, a.sourceId, query);
  const side = file[a.side], text = typeof side === "string" ? side : side?.text;
  if (file.omitted || text == null || a.endLine > (text.match(/[^\n]*\n|[^\n]+$/g) ?? []).length) throw new DomainError("invalid_discussion", "所选代码侧或行范围不可评论。", 409);
  // Recheck authorization after reading immutable files; comments never use a live checkout.
  const fresh = await reviewDiscussionContext(userId, a.kind, a.sourceId);
  if (fresh.sourceHash !== a.sourceHash) throw new DomainError("stale_revision", "评论来源已变化。", 409);
  return { anchor: a, text, current: "record" in file ? file.record.current : file.inputState === "current" };
}
