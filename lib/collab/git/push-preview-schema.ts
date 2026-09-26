import { z } from "zod";
import { safeSnapshotPath } from "../snapshot-paths";
import type { GitHubPushBinding } from "./github-task-target";
import type { CodeLine } from "../integration-code-schema";

export const pushPreviewRequest = z.object({ idempotencyKey: z.uuid(), revision: z.string().regex(/^[a-f0-9]{64}$/),
  head: z.string().regex(/^[a-f0-9]{40}$/).refine(value => value !== "0".repeat(40)), expectedRunRevision: z.string().regex(/^[1-9][0-9]{0,17}$/),
}).strict();
export const pushPreviewCancel = z.object({ idempotencyKey: z.uuid(), reason: z.string().trim().min(10).max(2000) }).strict();
const hash = z.string().regex(/^[a-f0-9]{64}$/), sha = z.string().regex(/^[a-f0-9]{40}$/);
const page = { manifestHash: hash, offset: z.coerce.number().int().min(0).max(10000).default(0) };
const file = { manifestHash: hash, commit: sha, path: z.string().max(1024).refine(safeSnapshotPath) };
export const pushHistoryQuery = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("commits"), ...page }).strict(),
  z.object({ kind: z.literal("changes"), commit: sha, ...page }).strict(),
  z.object({ kind: z.literal("file"), ...file }).strict(),
]);
export const pushHistoryDownloadQuery = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("commit"), manifestHash: hash, commit: sha }).strict(),
  z.object({ kind: z.literal("file"), ...file, side: z.enum(["before", "after"]) }).strict(),
]);
export type PushPreviewRecord = { jobId: string; runId: string; status: "queued" | "running" | "ready" | "failed" | "cancelled";
  stopRequested: boolean; actorId: string; createdAt: string; finishedAt: string | null; failure: string | null;
  head: string; manifestHash: string | null; commitCount: number | null };
export type PushHistoryIdentity = { previewId: string; manifestHash: string; runId: string; repositoryId: string; taskId: string;
  workspaceId: string; head: string; baseline: string; expectedOld: string | null; ref: string; policy: string };
export type PushHistoryCommit = { oid: string; tree: string; parents: string[]; changedPaths: number; size: number; hash: string;
  text: string | null; escapedControls: boolean; omitted: boolean };
export type PushHistorySide = { oid: string; mode: string };
export type PushHistoryChange = { path: string; kind: "added" | "deleted" | "modified"; before: PushHistorySide | null;
  after: PushHistorySide | null; omitted: string | null };
export type PushHistoryContent = PushHistorySide & { size: number; hash: string | null; text: string | null;
  encoding: "utf8" | "binary" | "unsupported" | "large"; escapedControls: boolean; downloadable: boolean;
  lineEndings: { lf: number; crlf: number }; trailingNewline: boolean };
export type PushHistoryPage = { kind: "commits"; identity: PushHistoryIdentity; commits: PushHistoryCommit[]; total: number; nextOffset: number | null };
export type PushHistoryChanges = { kind: "changes"; identity: PushHistoryIdentity; commit: string; comparison: "remote-baseline";
  files: PushHistoryChange[]; total: number; nextOffset: number | null };
export type PushHistoryFile = { kind: "file"; identity: PushHistoryIdentity; commit: string; file: PushHistoryChange; fileHash: string;
  before: PushHistoryContent | null; after: PushHistoryContent | null; omitted: string | null; lines: CodeLine[] };
export type PushHistory = PushHistoryPage | PushHistoryChanges | PushHistoryFile;
export type PushPreviewDetail = PushPreviewRecord & { binding: GitHubPushBinding; observation: unknown; observationHash: string | null;
  commits: { oid: string; tree: string; parents: string[]; changedPaths: number }[] | null; policy: string | null };
