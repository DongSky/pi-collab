import { z } from "zod";
import { integrationInput } from "./integration-schema";

export const codeQuery = z.object({ offset: z.coerce.number().int().min(0).max(5000).default(0), diffHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
export const codeFileQuery = z.object({ path: z.string().min(1).max(1024), diffHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type CodeSide = { oid: string; mode: string } | null;
export type CodeEntry = { path: string; kind: "added" | "deleted" | "modified" | "conflict" | "excluded"; before: CodeSide; after: CodeSide; base?: CodeSide; reason?: string };
export type IntegrationCodeIdentity = { integrationId: string; repositoryId: string; inputHash: string; targetSha: string; candidateCommit: string | null; manifestHash: string | null; worktreeCommit: string | null; conflictResultId: string | null };
export type IntegrationCodePage = {
  identity: IntegrationCodeIdentity; diffHash: string; files: CodeEntry[]; total: number; nextOffset: number | null;
  inputState: string; integrationStatus: string; reviewRevision: string | null;
};
export type CodeContent = { oid: string; mode: string; size: number; sha256: string | null; text: string | null; encoding: "utf8" | "binary" | "unsupported" | "large"; lineEndings: "lf" | "crlf" | "mixed" | "none"; escapedControls: boolean };
export type CodeLine = { kind: "hunk" | "context" | "added" | "removed" | "note"; text: string; before: number | null; after: number | null };
export type IntegrationCodeFile = {
  identity: IntegrationCodeIdentity; diffHash: string; fileHash: string; file: CodeEntry; inputState: string;
  before: CodeContent | null; after: CodeContent | null; base: CodeContent | null;
  omitted: string | null; lines: CodeLine[];
};
// Keep the Git identity constraints aligned with the existing admission API.
export const codeSha = integrationInput.shape.targetSha;
export function codeDisplayText(text: string) { return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, value => `⟦U+${value.charCodeAt(0).toString(16).toUpperCase().padStart(4,"0")}⟧`); }
