import { z } from "zod";
export const contractContent = z.object({
  title: z.string().trim().min(1).max(120), format: z.enum(["text", "json-schema", "openapi"]), definition: z.string().trim().min(1).max(20000),
  compatibility: z.enum(["initial", "compatible", "breaking"]), migrationGuide: z.string().trim().max(4000), mockJson: z.string().max(8000).nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.compatibility === "breaking" && value.migrationGuide.length < 10) ctx.addIssue({ code: "custom", message: "破坏性变更需要至少 10 个字符的迁移说明。" });
  try {
    if (value.format !== "text") { const parsed = JSON.parse(value.definition); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(); }
    if (value.mockJson !== null) JSON.parse(value.mockJson);
  } catch { ctx.addIssue({ code: "custom", message: "结构化定义和 mock 必须是有效 JSON；定义需为对象。" }); }
});
export type ContractContent = z.infer<typeof contractContent>;
export const proposalInput = z.object({ repositoryId: z.uuid(), key: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/), parentRevisionId: z.uuid().nullable(), content: contractContent,
  affectedTaskIds: z.array(z.uuid()).max(128), idempotencyKey: z.uuid() }).strict();
export const decisionInput = z.object({ taskId: z.uuid(), expectedVersion: z.number().int().nonnegative(), decision: z.enum(["approve", "reject"]), note: z.string().trim().min(1).max(2000), idempotencyKey: z.uuid() }).strict();
export const publishContractInput = z.object({ idempotencyKey: z.uuid(), overrideReason: z.string().trim().min(10).max(2000).nullable() }).strict();
export const contractPins = z.array(z.object({ contractId: z.uuid(), key: z.string().max(80), revisionId: z.uuid(), version: z.number().int().positive(), body: z.string().max(100000), bodyHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(32).refine(values => new Set(values.map(v => v.contractId)).size === values.length);
export type ContractPin = z.infer<typeof contractPins>[number];
