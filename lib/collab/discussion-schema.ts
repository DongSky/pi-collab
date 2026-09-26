import type { NotificationPreferences } from "./notification-schema";
import { z } from "zod";
import { reviewAnchor, type ReviewAnchor } from "./review-discussion-schema";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const codeAnchor = z.object({ snapshotId: z.uuid(), manifestHash: hash, path: z.string().min(1).max(1024), fileHash: hash,
  startLine: z.number().int().min(1).max(8000), endLine: z.number().int().min(1).max(8000),
}).strict().refine(a => a.endLine >= a.startLine);
export type CodeAnchor = z.infer<typeof codeAnchor>;
const message = { body: z.string().trim().min(1).max(8000), mentions: z.array(z.string().min(1).max(200)).max(20).default([]) };
export const discussionInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), title: z.string().trim().min(1).max(200), ...message, anchor: codeAnchor.nullable().default(null), reviewAnchor: reviewAnchor.nullable().optional(), replacement: z.string().max(16000).nullable().default(null), idempotencyKey: z.uuid() }).strict(),
  z.object({ action: z.literal("reply"), threadId: z.uuid(), ...message, idempotencyKey: z.uuid() }).strict(),
  z.object({ action: z.literal("resolve"), threadId: z.uuid(), expectedVersion: z.number().int().positive(), resolved: z.boolean(), idempotencyKey: z.uuid() }).strict(),
  z.object({ action: z.literal("subscribe"), enabled: z.boolean(), idempotencyKey: z.uuid() }).strict(),
]);
export type DiscussionInput = z.infer<typeof discussionInput>;
export type DiscussionThread = { id: string; task_id: string; title: string; author_id: string; author_name: string; anchor: CodeAnchor | null; review_anchor: ReviewAnchor | null; replacement: string | null; resolved: boolean; version: number; created_at: string };
export type DiscussionListing = { threads: DiscussionThread[]; total: number; subscribed: boolean; canComment: boolean; ownerId: string; role: string };
export type DiscussionDetail = { thread: DiscussionThread; messages: { id: string; author_name: string; body: string; mentions: { id: string; name: string }[]; created_at: string }[];
  nextAfter: string | null; applications: { run_id: string; applied_hash: string | null; applied_at: string | null; status: string }[] };
export type SnapshotCode = { snapshotId: string; manifestHash: string; files: { path: string; hash: string; size: number }[]; nextOffset: number | null };
export type SnapshotFile = { snapshotId: string; manifestHash: string; path: string; fileHash: string; text: string; canSuggest: boolean; lineCount: number };
export type RunSuggestion = { threadId: string; anchor: CodeAnchor; replacement: string };
export type InboxPage = { preferences: NotificationPreferences; unread: number; nextBefore: string | null; items: { id: string; kind: string; task_id: string; project_id: string; thread_id: string | null; task_title: string; project_name: string; actor_name: string | null; read_at: string | null; created_at: string }[] };
/** Preserve exact newlines. A final newline is a delimiter, not an extra source line. */
export function sourceLines(text: string) { return text.match(/[^\n]*\n|[^\n]+$/g) ?? []; }
export function replaceSourceLines(text: string, anchor: Pick<CodeAnchor, "startLine" | "endLine">, replacement: string) {
  const lines = sourceLines(text);
  if (anchor.startLine < 1 || anchor.endLine < anchor.startLine || anchor.endLine > lines.length) throw new Error("suggestion_range_invalid");
  return [...lines.slice(0, anchor.startLine - 1), replacement, ...lines.slice(anchor.endLine)].join("");
}
