import { z } from "zod";
export const createResourceInput = z.object({ name: z.string().trim().min(1).max(100), idempotencyKey: z.uuid() }).strict();
export const manageResourceInput = z.object({ action: z.enum(["disable", "enable"]), expectedVersion: z.number().int().positive(), reason: z.string().trim().min(10).max(2000), idempotencyKey: z.uuid() }).strict();
export const controlResourceInput = z.object({ targetKind: z.enum(["request", "job"]), reason: z.string().trim().min(10).max(2000), idempotencyKey: z.uuid() }).strict();
export const resourceSchemas = {
  request_resource: z.object({ resourceIds: z.array(z.uuid()).min(1).max(8), idempotencyKey: z.uuid() }).strict(),
  release_resource: z.object({ requestId: z.uuid(), idempotencyKey: z.uuid() }).strict(),
  execute_resource: z.object({ requestId: z.uuid(), resourceId: z.uuid(), fence: z.string().regex(/^[1-9][0-9]{0,17}$/), sql: z.string().trim().min(1).max(20000), idempotencyKey: z.uuid() }).strict(),
  cancel_resource_job: z.object({ jobId: z.uuid(), idempotencyKey: z.uuid() }).strict(),
};
/** One extended-protocol statement inside a broker-owned transaction. */
export function validateResourceSql(sql: string) {
  let i = 0;
  for (;;) {
    while (/\s/.test(sql[i] ?? "") && i < sql.length) i++;
    if (sql.slice(i, i + 2) === "--") { const end = sql.indexOf("\n", i + 2); if (end < 0) throw new Error("resource_sql_not_allowed"); i = end + 1; continue; }
    if (sql.slice(i, i + 2) === "/*") {
      let depth = 1; i += 2;
      while (depth && i < sql.length) {
        if (sql.slice(i, i + 2) === "/*") { depth++; i += 2; }
        else if (sql.slice(i, i + 2) === "*/") { depth--; i += 2; } else i++;
      }
      if (depth) throw new Error("resource_sql_not_allowed"); continue;
    }
    break;
  }
  const keyword = /^[a-z]+/i.exec(sql.slice(i))?.[0].toUpperCase();
  if (!keyword || !["SELECT", "WITH", "INSERT", "UPDATE", "DELETE", "MERGE", "CREATE", "ALTER", "DROP", "TRUNCATE", "DO", "EXPLAIN"].includes(keyword)) throw new Error("resource_sql_not_allowed");
}
