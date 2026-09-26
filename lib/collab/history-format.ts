import { z } from "zod";

export const historyMessage = z.object({ role: z.enum(["user", "assistant"]), text: z.string().trim().min(1).max(20000) }).strict();
export const historyImport = z.object({
  title: z.string().trim().min(1).max(200), messages: z.array(historyMessage).min(1).max(200),
  shared: z.boolean(), reviewed: z.literal(true),
}).strict().refine(value => value.messages.reduce((size, message) => size + message.text.length, 0) <= 100000, "一次最多导入 10 万字符。");
export type HistoryMessage = z.infer<typeof historyMessage>;

/** Browser-only selection: never send the source file, paths, tools or system context. */
export function previewPiHistory(source: string): HistoryMessage[] {
  if (new TextEncoder().encode(source).length > 5 * 1024 * 1024) throw new Error("请选择不超过 5 MiB 的 Pi JSONL 会话文件。");
  const lines = source.split(/\r?\n/).filter(line => line.trim());
  const entries = lines.map((line, index) => {
    try { return JSON.parse(line); } catch { throw new Error(`第 ${index + 1} 行不是有效 JSON。`); }
  });
  if (entries[0]?.type !== "session") throw new Error("文件缺少 Pi session 标头。");
  const messages: HistoryMessage[] = [];
  for (const entry of entries) {
    if (entry?.type !== "message" || !["user", "assistant"].includes(entry.message?.role)) continue;
    const content = entry.message.content;
    const text = typeof content === "string" ? content : Array.isArray(content)
      ? content.filter((block: {type?: string; text?: unknown} | null) => block?.type === "text" && typeof block.text === "string").map((block: {text: string}) => block.text).join("\n") : "";
    if (text.trim()) messages.push({ role: entry.message.role, text });
  }
  if (messages.length > 1000) throw new Error("会话超过 1000 条文字消息，请先拆分文件。");
  if (!messages.length) throw new Error("会话没有可导入的用户或助手文字。");
  return messages;
}
