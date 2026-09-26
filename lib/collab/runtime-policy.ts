import { z } from "zod";
import { asUser } from "./database";
import { uuid } from "./projects";
export const runtimePolicyInput = z.object({
  expectedVersion: z.number().int().nonnegative(), idempotencyKey: z.uuid(), reason: z.string().trim().min(10).max(2000),
  aiSeconds: z.number().int().min(1).max(86400), terminalSeconds: z.number().int().min(1).max(86400),
  workspaceBytes: z.number().int().min(1048576).max(1099511627776), memberBytes: z.number().int().positive().max(10995116277760), projectBytes: z.number().int().positive().max(10995116277760),
}).strict().refine(v => v.projectBytes >= v.memberBytes && v.memberBytes >= v.workspaceBytes);
export function runtimePolicyContext(user: string, project: string) {
  uuid.parse(project); return asUser(user, async db => (await db.query("SELECT collab.runtime_policy_context($1) AS result", [project])).rows[0].result);
}
export function configureRuntimePolicy(user: string, project: string, raw: unknown) {
  uuid.parse(project); const input = runtimePolicyInput.parse(raw);
  return asUser(user, async db => (await db.query("SELECT collab.configure_runtime_policy($1,$2) AS result", [project, input])).rows[0].result);
}
