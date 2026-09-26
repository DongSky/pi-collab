import { readNotificationPreferences } from "./notification-preferences";
import path from "node:path";
import { isUtf8 } from "node:buffer";
import { z } from "zod";
import { asUser } from "./database";
import { DomainError } from "./policy";
import { loadSnapshot, snapshotHasSecret } from "./runtime/snapshots";
import { codeDisplayText } from "./integration-code-schema";
import { reviewDiscussionCode } from "./review-discussions";
import { reviewSource, type ReviewSource } from "./review-discussion-schema";
import { discussionInput, sourceLines, type DiscussionInput, type DiscussionListing, type DiscussionDetail, type SnapshotCode, type SnapshotFile, type InboxPage } from "./discussion-schema";
const root = () => process.env.PI_COLLAB_DATA_DIR ?? path.resolve(".local");
const missing = () => new DomainError("not_found", "讨论或代码版本不存在或不可访问。", 404);
const unavailable = () => new DomainError("suggestion_source_unavailable", "代码版本已变化、被排除或不可用于建议。请重新选择快照。", 409);
export async function snapshotCode(userId: string, id: string, query: { path?: string; offset?: number }): Promise<SnapshotCode | SnapshotFile> {
  z.uuid().parse(id); const offset = z.number().int().min(0).max(10000).parse(query.offset ?? 0);
  return asUser(userId, async db => {
    const row = (await db.query("SELECT manifest_hash FROM collab.snapshots WHERE id=$1 AND status='ready'", [id])).rows[0];
    if (!row) throw missing();
    let saved;
    try { saved = await loadSnapshot(root(), id, row.manifest_hash); } catch { throw unavailable(); }
    let result: SnapshotCode | SnapshotFile;
    if (query.path !== undefined) {
      const entry = saved.manifest.worktree.find(f => f.path === query.path); if (!entry) throw missing();
      const bytes = saved.blobs.get(entry.hash)!;
      if (bytes.length > 256 * 1024 || !isUtf8(bytes) || bytes.includes(0) || snapshotHasSecret(bytes)) throw unavailable();
      const text = bytes.toString("utf8"), lines = sourceLines(text);
      if (lines.length > 8000) throw unavailable();
      result = { snapshotId: id, manifestHash: row.manifest_hash, path: entry.path, fileHash: entry.hash, text: codeDisplayText(text), canSuggest: codeDisplayText(text) === text && lines.length > 0, lineCount: lines.length };
    } else {
      const entries = saved.manifest.worktree;
      result = { snapshotId: id, manifestHash: row.manifest_hash, files: entries.slice(offset, offset + 100).map(f => ({ path: f.path, hash: f.hash, size: f.size })), nextOffset: offset + 100 < entries.length ? offset + 100 : null };
    }
    if (!(await db.query("SELECT 1 FROM collab.snapshots WHERE id=$1", [id])).rowCount) throw missing();
    return result;
  });
}
export async function discussionCommand(userId: string, taskId: string, raw: DiscussionInput) {
  z.uuid().parse(taskId); const { idempotencyKey, ...payload } = discussionInput.parse(raw);
  if (payload.action === "create") {
    if (payload.reviewAnchor) {
      if (payload.anchor || payload.replacement !== null) throw unavailable();
      await reviewDiscussionCode(userId, payload.reviewAnchor);
    }
    if (payload.replacement !== null && !payload.anchor) throw unavailable();
    if (payload.replacement !== null && snapshotHasSecret(Buffer.from(payload.replacement))) throw unavailable();
    if (payload.anchor) {
      const a = payload.anchor, file = await snapshotCode(userId, a.snapshotId, { path: a.path }) as SnapshotFile;
      if (file.manifestHash !== a.manifestHash || file.fileHash !== a.fileHash || a.endLine > file.lineCount || (payload.replacement !== null && !file.canSuggest)) throw unavailable();
    }
  }
  return asUser(userId, async db => (await db.query("SELECT collab.discussion_command($1,$2,$3) AS result", [taskId, idempotencyKey, payload])).rows[0].result);
}
export function discussions(userId: string, taskId: string, offset = 0, source?: ReviewSource): Promise<DiscussionListing> {
  z.uuid().parse(taskId); z.number().int().min(0).max(100000).parse(offset);
  if (source) source = reviewSource.parse(source);
  return asUser(userId, async db => {
    const task = (await db.query("SELECT owner_id,collab.project_role(project_id) AS role FROM collab.tasks WHERE id=$1", [taskId])).rows[0]; if (!task) throw missing();
    const threads = (await db.query('SELECT d.*,u.name AS author_name FROM collab.discussion_threads d JOIN public."user" u ON u.id=d.author_id WHERE d.task_id=$1 AND ($3::jsonb IS NULL OR d.review_anchor @> $3) ORDER BY d.created_at DESC,d.id LIMIT 40 OFFSET $2', [taskId, offset, source ?? null])).rows;
    const total = Number((await db.query("SELECT count(*) AS n FROM collab.discussion_threads WHERE task_id=$1 AND ($2::jsonb IS NULL OR review_anchor @> $2)", [taskId, source ?? null])).rows[0].n);
    const s = (await db.query("SELECT enabled FROM collab.task_subscriptions WHERE task_id=$1 AND user_id=$2", [taskId, userId])).rows[0];
    return { threads, total, subscribed: s?.enabled ?? task.owner_id === userId, canComment: task.role !== "viewer", ownerId: task.owner_id, role: task.role };
  });
}
export function discussionDetail(userId: string, id: string, after = "0"): Promise<DiscussionDetail> {
  z.uuid().parse(id); z.string().regex(/^\d{1,18}$/).parse(after);
  return asUser(userId, async db => {
    const thread = (await db.query('SELECT d.*,u.name AS author_name FROM collab.discussion_threads d JOIN public."user" u ON u.id=d.author_id WHERE d.id=$1', [id])).rows[0]; if (!thread) throw missing();
    const rows = (await db.query(`SELECT m.id,m.body,m.created_at,u.name AS author_name,
      coalesce((SELECT jsonb_agg(jsonb_build_object('id',p.id,'name',p.name)) FROM public."user" p WHERE p.id=ANY(m.mentions)),'[]') AS mentions
      FROM collab.discussion_messages m JOIN public."user" u ON u.id=m.author_id WHERE m.thread_id=$1 AND m.id>$2 ORDER BY m.id LIMIT 51`, [id, after])).rows;
    const applications = (await db.query("SELECT s.run_id,s.applied_hash,s.applied_at,r.status FROM collab.run_suggestions s JOIN collab.runs r ON r.id=s.run_id WHERE thread_id=$1 ORDER BY r.created_at DESC LIMIT 20", [id])).rows;
    return { thread, messages: rows.slice(0, 50), nextAfter: rows.length > 50 ? rows[49].id : null, applications };
  });
}
export function inbox(userId: string, before?: string): Promise<InboxPage> {
  if (before) z.string().regex(/^[1-9]\d{0,17}$/).parse(before);
  return asUser(userId, async db => {
    const rows = (await db.query(`SELECT n.*,t.title AS task_title,p.name AS project_name,u.name AS actor_name FROM collab.inbox n
      JOIN collab.tasks t ON t.id=n.task_id JOIN collab.projects p ON p.id=n.project_id LEFT JOIN public."user" u ON u.id=n.actor_id
      WHERE ($1::bigint IS NULL OR n.id<$1) ORDER BY n.id DESC LIMIT 51`, [before ?? null])).rows;
    return { preferences: await readNotificationPreferences(db), items: rows.slice(0,50), nextBefore: rows.length > 50 ? rows[49].id : null, unread: Number((await db.query("SELECT count(*) AS n FROM collab.inbox WHERE read_at IS NULL")).rows[0].n) };
  });
}
export function markInbox(userId: string, raw: unknown) {
  const input = z.object({ ids: z.array(z.string().regex(/^[1-9]\d{0,17}$/)).min(1).max(50), read: z.boolean() }).strict().parse(raw);
  return asUser(userId, async db => ({ changed: (await db.query("UPDATE collab.inbox SET read_at=CASE WHEN $2 THEN now() ELSE NULL END WHERE id=ANY($1::bigint[])", [input.ids,input.read])).rowCount }));
}
