import { z } from "zod";

export function validIntentPath(value: string) {
  const file = value.endsWith("/") ? value.slice(0, -1) : value;
  return file.length > 0 && value.length <= 512 && value === value.trim() && !/[\\\x00-\x1f\x7f:*?\[\]{}]/.test(value)
    && file.split("/").every(part => part && ![".", "..", ".git"].includes(part.toLowerCase()) && !/[. ]$/.test(part));
}
export const workDeclaration = z.object({
  paths: z.array(z.string().refine(validIntentPath, "请填写相对文件路径或以 / 结尾的目录，不使用通配符。")).min(1).max(64),
  symbols: z.array(z.string().trim().min(1).max(200).regex(/^[^\x00-\x1f\x7f]+$/)).max(32).default([]),
  changeType: z.enum(["feature", "fix", "refactor", "api", "schema", "config", "docs", "test"]),
  summary: z.string().trim().min(1).max(2000), expectedCompletion: z.iso.datetime().nullable().default(null),
}).strict();
export type WorkDeclaration = z.infer<typeof workDeclaration>;
export const workIntentInput = z.object({ expectedRevision: z.number().int().min(0), idempotencyKey: z.uuid(), declaration: workDeclaration }).strict();
// Conservatively fold case and Unicode for macOS; paths retain their display spelling.
const folded = (value: string) => value.normalize("NFC").toLowerCase();
export function pathCovered(file: string, scope: string) {
  const f = folded(file), s = folded(scope);
  return s.endsWith("/") ? f.startsWith(s) : f === s;
}
export function overlappingPaths(left: string[], right: string[]) {
  return left.flatMap(a => right.filter(b => pathCovered(a, b) || pathCovered(b, a)).map(b => ({ ours: a, theirs: b })));
}
