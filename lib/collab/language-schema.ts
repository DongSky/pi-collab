import { z } from "zod";
export const languageRequest = z.object({
  action: z.enum(["diagnostics", "complete", "hover", "definition", "references", "symbols", "rename", "organize", "fixes"]),
  path: z.string().min(1).max(1024),
  text: z.string().max(262144).optional(),
  position: z.number().int().min(0).default(0),
  newName: z.string().min(1).max(128).optional(),
}).strict();
export type LanguageRequest = z.infer<typeof languageRequest>;
export type FileChange = { path: string; before: string; after: string };
export type EditPreview = { version: string; changes: FileChange[]; label: string; skipped?: number };
export type CodeLocation = { path: string; line: number; column: number; from: number; to: number; name: string };
export type CodeDiagnostic = CodeLocation & { severity: "error" | "warning"; code: number };
export type LanguageResult = {
  version: string; skipped: number; notices: string[];
  diagnostics?: CodeDiagnostic[];
  locations?: CodeLocation[];
  completions?: { label: string; type: string; detail?: string }[];
  hover?: string;
  codeActions?: { description: string; preview: EditPreview }[];
  preview?: EditPreview;
};
export const batchEdit = z.object({
  version: z.string().regex(/^\d{1,18}$/),
  changes: z.array(z.object({ path: z.string().min(1).max(1024), before: z.string().max(262144), after: z.string().max(262144) }).strict()).min(1).max(40),
}).strict();
export const replaceRequest = z.object({ query: z.string().min(1).max(200), replacement: z.string().max(2000), caseSensitive: z.boolean().default(false), wholeWord: z.boolean().default(false), paths: z.array(z.string().max(1024)).max(2000).optional() }).strict();
