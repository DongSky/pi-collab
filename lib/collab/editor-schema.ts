import { z } from "zod";
export const editorAction = z.object({ action: z.enum(["checkpoint", "handoff", "reopen", "archive", "copy"]), expectedVersion: z.string().regex(/^\d{1,18}$/), note: z.string().trim().min(1).max(2000) }).strict();
export const editorOpen = z.object({ snapshotId: z.uuid(), expectedVersion: z.number().int().positive() }).strict();
export const documentInput = z.object({ path: z.string().min(1).max(1024), create: z.boolean().default(false) }).strict();
export const documentSaveAs = z.object({ documentId:z.uuid(), path:z.string().min(1).max(1024), expectedRevision:z.string().regex(/^\d{1,18}$/) }).strict();
export const documentSync = z.object({ documentId: z.uuid(), update: z.string().max(1400000).regex(/^[A-Za-z0-9+/]*={0,2}$/).optional(), deleted: z.boolean().optional(), expectedRevision: z.string().regex(/^\d{1,18}$/).optional(), clientId: z.number().int().min(0).max(4294967295), baseText:z.string().max(262144).optional(), baseToken:z.string().regex(/^[a-f0-9]{64}$/).optional(), localText:z.string().max(262144).optional(), resolution:z.boolean().optional(), selection: z.unknown().optional() }).strict();
export const editorPayload = z.object({ snapshotId: z.uuid(), manifestHash: z.string().regex(/^[a-f0-9]{64}$/), files: z.array(z.object({ path: z.string().min(1).max(1024), baseHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(), text: z.string().max(262144).nullable() }).strict()).max(40) }).strict();
export type EditorPayload = z.infer<typeof editorPayload>;
export type EditorVersion = { versionId: string; payload: EditorPayload; payloadHash: string };
export type EditorSession = { id: string; snapshot_id: string; manifest_hash: string; state: "editing" | "frozen" | "handed_off" | "archived"; version: string; created_at: string };
export type EditorDocument = { id: string; path: string; deleted: boolean; revision: string };
export type EditorDetail = { session: EditorSession; canWrite: boolean; canManage: boolean; files: string[]; documents: EditorDocument[]; versions: { id: string; version: string; note: string; created_at: string; payload: EditorPayload }[] };
export type EditorConflict = { base:string;local:string;remote:string;merged:string;revision:string;baseToken:string };
export type EditorWritebackConflict = { base:string;local:string|null;remote:string|null;merged:string };
export type EditorWriteback =
 | { status:"unbound" }
 | { status:"in-sync"|"written"|"merged"|"deleted";localPath:string;path:string }
 | { status:"conflict";localPath:string;path:string;conflict:EditorWritebackConflict }
 | { status:"error";message:string };
export type EditorSync = { conflict?:EditorConflict; merged?:boolean; writeback?:EditorWriteback; document: EditorDocument & { state: string; baseToken:string }; session: EditorSession; canWrite: boolean; presence: { clientId: number; name: string; userId: string; selection: unknown }[] };
