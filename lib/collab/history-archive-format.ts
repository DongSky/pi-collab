import { z } from "zod";
export const ARCHIVE_FILE_BYTES = 5 * 1024 * 1024, ARCHIVE_TOTAL_BYTES = 10 * 1024 * 1024;
const bytes = (value: string) => new TextEncoder().encode(value).length;
export const archiveFile = z.object({ name: z.string().min(1).max(240).regex(/^[^/\\\u0000-\u001f\u007f]+\.jsonl$/i), source: z.string().min(1).refine(v => bytes(v) <= ARCHIVE_FILE_BYTES, "单个文件最多 5 MiB。") }).strict();
export const archiveImport = z.object({ title: z.string().trim().min(1).max(200), shared: z.boolean(), reviewed: z.literal(true), files: z.array(archiveFile).min(1).max(20) }).strict().superRefine((v, ctx) => {
  if (v.files.reduce((n, f) => n + bytes(f.source), 0) > ARCHIVE_TOTAL_BYTES) ctx.addIssue({ code: "custom", message: "一组归档最多 10 MiB。" });
  if (new Set(v.files.map(f => f.name)).size !== v.files.length) ctx.addIssue({ code: "custom", message: "同一组中不能有重名文件。" });
});
export type ArchiveFile = z.infer<typeof archiveFile>;
type RecordValue = Record<string, unknown>;
export type ArchiveNode = { id: string; parentId: string | null; type: string; role: string | null; text: string; line: number; raw: RecordValue };
export type ArchiveTree = { header: RecordValue; nodes: ArchiveNode[]; leaves: string[]; version: number; legacy: boolean };
function record(value: unknown): value is RecordValue { return value !== null && typeof value === "object" && !Array.isArray(value); }
/** An inert index over the original bytes. Never use the SDK's migration or run
 * constructor: reading an archive must not rewrite IDs or execute extensions. */
export function parseHistoryArchive(source: string): ArchiveTree {
  if (bytes(source) > ARCHIVE_FILE_BYTES) throw new Error("单个文件最多 5 MiB。");
  const lines = source.replace(/^\uFEFF/, "").split(/\r?\n/), records: { value: RecordValue; line: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let value: unknown; try { value = JSON.parse(lines[i]); } catch { throw new Error(`第 ${i + 1} 行不是有效 JSON。`); }
    if (!record(value) || typeof value.type !== "string") throw new Error(`第 ${i + 1} 行缺少条目类型。`);
    records.push({ value, line: i + 1 }); if (records.length > 5001) throw new Error("单个会话最多 5000 个条目。");
  }
  const header = records.shift()?.value;
  if (!header || header.type !== "session" || typeof header.id !== "string" || !header.id) throw new Error("缺少有效的 Pi session 标头与原始标识。");
  const version = header.version ?? 1;
  if (version !== 1 && version !== 2 && version !== 3) throw new Error("当前支持 Pi 会话版本 1、2、3；未知版本请保留源文件。");
  if (header.parentSession !== undefined && typeof header.parentSession !== "string") throw new Error("父会话来源格式无效。");
  const seen = new Set<string>(), parents = new Set<string>(), nodes: ArchiveNode[] = [];
  for (const { value, line } of records) {
    if (value.type === "session") throw new Error(`第 ${line} 行包含重复会话标头。`);
    // Pi v1 is linear and has no stable entry IDs. Display-only references are
    // deterministic line numbers; exports always retain the original file.
    const id = version === 1 ? `line-${line}` : value.id;
    const parentId = version === 1 ? nodes.at(-1)?.id ?? null : value.parentId;
    if (typeof id !== "string" || !id || id.length > 240 || seen.has(id)) throw new Error(`第 ${line} 行的条目标识缺失或重复。`);
    if (parentId !== null && (typeof parentId !== "string" || !seen.has(parentId))) throw new Error(`第 ${line} 行的父条目缺失、循环或晚于当前条目。`);
    const message = record(value.message) ? value.message : value;
    const role = typeof message.role === "string" ? message.role : null;
    const content = message.content;
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter(record).filter(b => b.type === "text" && typeof b.text === "string").map(b => b.text).join("\n") : typeof value.summary === "string" ? value.summary : "";
    nodes.push({ id, parentId, type: value.type as string, role, text, line, raw: value }); seen.add(id); if (parentId) parents.add(parentId);
  }
  return { header, nodes, leaves: nodes.filter(n => !parents.has(n.id)).map(n => n.id), version, legacy: version === 1 };
}
export function archiveBranch(tree: ArchiveTree, leaf: string): ArchiveNode[] {
  const byId = new Map(tree.nodes.map(n => [n.id, n])), result: ArchiveNode[] = [];
  let current = byId.get(leaf); if (!current) return [];
  while (current) { result.push(current); current = current.parentId ? byId.get(current.parentId) : undefined; }
  return result.reverse();
}
export function archiveManifest(files: ArchiveFile[]) {
  return files.map(file => {
    const tree = parseHistoryArchive(file.source), parent = tree.header.parentSession;
    const parentName = typeof parent === "string" ? parent.split(/[\\/]/).at(-1)! : null;
    return { name: file.name, sessionId: tree.header.id as string, version: tree.version, entryCount: tree.nodes.length, branchCount: tree.leaves.length, bytes: bytes(file.source), parentFile: parentName && files.some(f => f.name === parentName) ? parentName : null, missingParent: !!parentName && !files.some(f => f.name === parentName) };
  });
}
