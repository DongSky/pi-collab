import { z } from "zod";
import { asUser } from "./database";
import { uuid } from "./projects";
const common = { idempotencyKey: z.uuid(), reason: z.string().trim().min(10).max(2000) };
export const artifactOperation = z.discriminatedUnion("action", [
  z.object({ ...common, action: z.literal("policy"), expectedVersion: z.number().int().nonnegative(), byteLimit: z.number().int().min(536870912).max(10995116277760), candidateDays: z.number().int().min(1).max(3650), workspaceDays: z.number().int().min(1).max(3650), auditDays: z.number().int().min(180).max(3650) }).strict(),
  z.object({ ...common, action: z.literal("cleanup"), acknowledge: z.literal(true), kind: z.enum(["workspace", "snapshot", "validation", "integration"]), artifactId: z.uuid() }).strict(),
  z.object({ ...common, action: z.literal("audit"), acknowledge: z.literal(true) }).strict(),
]);
export function artifactContext(user: string, project: string) {
  uuid.parse(project); return asUser(user, async db => (await db.query("SELECT collab.artifact_context($1) AS result", [project])).rows[0].result);
}
export function manageArtifacts(user: string, project: string, raw: unknown) {
  uuid.parse(project); const input = artifactOperation.parse(raw);
  return asUser(user, async db => (await db.query("SELECT collab.manage_artifacts($1,$2) AS result", [project, input])).rows[0].result);
}
