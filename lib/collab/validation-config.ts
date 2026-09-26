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
