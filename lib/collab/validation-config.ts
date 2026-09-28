import { z } from "zod";

// Maintainer-authored, immutable configuration. Arguments are an array, never
// parsed as a shell command. Repository scripts still execute trusted code.
export const validationConfig = z.object({
  version: z.literal(1),
  steps: z.array(z.object({
    tool: z.enum(["node", "npm"]),
    args: z.array(z.string().max(1000).refine(value => !/[\x00-\x1f\x7f]/.test(value))).min(1).max(32),
    timeoutSeconds: z.number().int().min(1).max(600),
  }).strict()).min(1).max(5),
}).strict().refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 16 * 1024, "验证配置不能超过 16 KiB");
export type ValidationConfig = z.infer<typeof validationConfig>;
export const validationProfileInput = z.object({ repositoryId: z.uuid(), name: z.string().trim().min(1).max(120), config: validationConfig, idempotencyKey: z.uuid() }).strict();
export const validationInput = z.object({ profileId: z.uuid(), idempotencyKey: z.uuid() }).strict();
// Quick validation: run a single command directly without creating a profile first.
// The command is parsed into a single validation step (e.g. "npm test" -> {tool:"npm",args:["test"]}).
export const quickValidationInput = z.object({ command: z.string().trim().min(1).max(500), idempotencyKey: z.uuid() }).strict();

/** Parse a quick command like "npm test" or "node --test" into a validation step. */
export function parseQuickCommand(command: string): { tool: "node" | "npm"; args: string[]; timeoutSeconds: number } {
  const trimmed = command.trim();
  const parts = trimmed.split(/\s+/);
  const tool = parts[0];
  if (tool !== "node" && tool !== "npm") {
    throw new Error(`快速验证只支持 node 或 npm 开头，例如 "npm test" 或 "node --test"。`);
  }
  const args = parts.slice(1);
  if (!args.length) {
    throw new Error(`请提供完整的命令，例如 "npm test"。`);
  }
  // Basic safety: reject shell metacharacters since args are passed directly (not via shell).
  for (const arg of args) {
    if (/[;&|`$(){}[\]<>!]/.test(arg)) {
      throw new Error(`参数 "${arg}" 包含不支持的字符。请只使用简单的命令和参数。`);
    }
  }
  return { tool, args, timeoutSeconds: 300 };
}
