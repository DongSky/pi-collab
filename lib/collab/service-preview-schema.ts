import { z } from "zod";
import { validationConfig } from "./validation-config";
const args = z.array(z.string().max(1000).refine(v => !/[\x00-\x1f\x7f]/.test(v))).min(1).max(32);
export const serviceConfig = z.object({
  install: z.enum(["none", "npm-ci"]), build: validationConfig.nullable(),
  start: z.object({ tool: z.enum(["node", "npm"]), args }).strict(),
  healthPath: z.string().max(500).regex(/^\/(?!\/)[A-Za-z0-9_./?=&%-]*$/),
  seconds: z.number().int().min(30).max(3600),
}).strict();
export const serviceInput = z.object({ validationId: z.uuid(), title: z.string().trim().min(1).max(120), config: serviceConfig, idempotencyKey: z.uuid(), acknowledge: z.literal(true) }).strict();
export type ServiceConfig = z.infer<typeof serviceConfig>;
export type ServiceClaim = { id: string; executorId: string; runtime: "native" | "docker"; snapshotId: string; manifestHash: string; repositoryId: string; port: number; config: ServiceConfig };
export type ServiceRequest = { id: string; method: string; path: string; contentType: string; body: string };
export type ServiceResponse = { status: number; contentType: string; body: string; location?: string };
