import { randomBytes, createHash } from "node:crypto";
import { z } from "zod";
import { asUser } from "./database";
import { DomainError } from "./policy";
import { previewOrigin } from "./checkpoint-previews";
import { serviceInput } from "./service-preview-schema";
export function createServicePreview(user: string, task: string, raw: unknown) {
  z.uuid().parse(task); const input = serviceInput.parse(raw); previewOrigin();
  return asUser(user, async db => (await db.query("SELECT collab.create_service_preview($1,$2) AS result", [task,input])).rows[0].result);
}
export function listServicePreviews(user: string, task: string) {
  z.uuid().parse(task);
  return asUser(user, async db => {
    const row = (await db.query("SELECT project_id FROM collab.tasks WHERE id=$1", [task])).rows[0]; if (!row) throw new DomainError("not_found", "任务不存在。", 404);
    return { role: (await db.query("SELECT collab.project_role($1) AS role", [row.project_id])).rows[0].role, configured: !!process.env.PI_COLLAB_PREVIEW_ORIGIN,
      previews: (await db.query("SELECT id,title,status,author_id,snapshot_id,snapshot_hash,validation_id,config,runtime,expires_at,created_at,started_at,finished_at,cleanup_confirmed,cleaned_at,failure,evidence,output_tail FROM collab.service_previews WHERE task_id=$1 ORDER BY created_at DESC LIMIT 30", [task])).rows,
      logs: (await db.query("SELECT l.* FROM collab.service_request_log l JOIN collab.service_previews p ON p.id=l.preview_id WHERE p.task_id=$1 ORDER BY l.id DESC LIMIT 100", [task])).rows };
  });
}
export async function openServicePreview(user: string, id: string) {
  z.uuid().parse(id); const origin = previewOrigin(), token = randomBytes(32).toString("hex");
  const value = await asUser(user, async db => (await db.query("SELECT collab.open_service($1,$2) AS result", [id,createHash("sha256").update(token).digest("hex")])).rows[0].result);
  return { url: `${origin}/service/${token}/`, expiresAt: value.expiresAt };
}
export function stopServicePreview(user: string, id: string, reason: string) {
  z.uuid().parse(id); z.string().trim().min(10).max(2000).parse(reason);
  return asUser(user, async db => { await db.query("SELECT collab.stop_service($1,$2)", [id,reason]); return { stopped: true }; });
}
