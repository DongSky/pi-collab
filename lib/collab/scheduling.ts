import { z } from "zod";
import { asUser } from "./database";
import { uuid } from "./projects";
const input = z.object({ expectedVersion: z.number().int().nonnegative(), priority: z.number().int().min(0).max(2), reason: z.string().trim().min(10).max(2000), idempotencyKey: z.uuid() }).strict();
export function schedulingContext(user: string, project: string) {
  uuid.parse(project);
  return asUser(user, async db => (await db.query("SELECT collab.scheduling_context($1) AS result", [project])).rows[0].result);
}
export function configureScheduling(user: string, project: string, raw: unknown) {
  uuid.parse(project); const request = input.parse(raw);
  return asUser(user, async db => (await db.query("SELECT collab.configure_scheduling($1,$2) AS result", [project, request])).rows[0].result);
}
