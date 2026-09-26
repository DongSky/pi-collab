import { asUser } from "./database";
import { uuid } from "./projects";
import { DomainError } from "./policy";
import { noteInput, sequenceInput } from "./coordination-schema";
import type { z } from "zod";
export function sendNote(userId: string, taskId: string, raw: z.input<typeof noteInput>) {
  uuid.parse(taskId); const input = noteInput.parse(raw);
  return asUser(userId, async db => (await db.query("SELECT collab.send_note($1,$2,$3,$4,$5,$6,$7) AS result", [taskId, input.targetTaskId, input.kind, input.body, input.resultIds, input.revisionIds, input.idempotencyKey])).rows[0].result);
}
export function taskNotes(userId: string, taskId: string, rawAfter = "0") {
  uuid.parse(taskId); const after = sequenceInput.parse(rawAfter);
  return asUser(userId, async db => {
    if (!(await db.query("SELECT 1 FROM collab.tasks WHERE id=$1", [taskId])).rowCount) throw new DomainError("not_found", "任务不存在或不可访问。", 404);
    const rows = (await db.query(`SELECT n.id,n.sequence::text,n.source_task_id,n.target_task_id,n.author_id,u.name AS author_name,
      n.source_run_id,n.source_epoch::text,n.kind,n.body,n.result_ids,n.revision_ids,n.created_at,s.title AS source_title,t.title AS target_title
      FROM collab.coordination_notes n JOIN collab.tasks s ON s.id=n.source_task_id JOIN collab.tasks t ON t.id=n.target_task_id JOIN public."user" u ON u.id=n.author_id
      WHERE (n.source_task_id=$1 OR n.target_task_id=$1) AND n.sequence>$2::bigint ORDER BY n.sequence LIMIT 51`, [taskId, after])).rows;
    const notes = rows.slice(0, 50);
    return { notes, hasMore: rows.length > 50, nextSequence: notes.at(-1)?.sequence ?? after };
  });
}
