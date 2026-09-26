import { createHash } from "node:crypto";
import { asUser } from "./database";
import { audit, projectRole, uuid } from "./projects";
import { historyImport } from "./history-format";
import { DomainError } from "./policy";

export function listHistory(user: string, project: string) {
  uuid.parse(project);
  return asUser(user, async db => {
    await projectRole(db, project, "project.read");
    return { histories: (await db.query('SELECT h.id,h.title,h.owner_id,u.name AS owner_name,h.shared,h.created_at,jsonb_array_length(h.messages) AS message_count FROM collab.imported_histories h JOIN public."user" u ON u.id=h.owner_id WHERE project_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100', [project])).rows };
  });
}
export function readHistory(user: string, project: string, id: string) {
  uuid.parse(project); uuid.parse(id);
  return asUser(user, async db => {
    const row = (await db.query("SELECT id,title,messages,shared,owner_id,created_at FROM collab.imported_histories WHERE project_id=$1 AND id=$2", [project, id])).rows[0];
    if (!row) throw new DomainError("not_found", "记录不存在或不可访问。", 404);
    return row;
  });
}
export function importHistory(user: string, project: string, raw: unknown) {
  uuid.parse(project); const input = historyImport.parse(raw);
  const hash = createHash("sha256").update(JSON.stringify({ title: input.title, messages: input.messages })).digest("hex");
  return asUser(user, async db => {
    await projectRole(db, project, "task.create");
    if (!(await db.query("SELECT collab.actor_has_mfa() AS enabled")).rows[0].enabled) throw new DomainError("mfa_required", "请先启用多因素验证。", 403);
    const prior = (await db.query("SELECT id FROM collab.imported_histories WHERE project_id=$1 AND owner_id=$2 AND content_hash=$3 AND shared=$4", [project,user,hash,input.shared])).rows[0];
    if (prior) return { id: prior.id, replayed: true };
    const organization = (await db.query("SELECT organization_id FROM collab.projects WHERE id=$1", [project])).rows[0].organization_id;
    const inserted = (await db.query("INSERT INTO collab.imported_histories(organization_id,project_id,owner_id,title,messages,content_hash,shared) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id", [organization,project,user,input.title,JSON.stringify(input.messages),hash,input.shared])).rows[0];
    if (!inserted) return { id: (await db.query("SELECT id FROM collab.imported_histories WHERE project_id=$1 AND owner_id=$2 AND content_hash=$3 AND shared=$4", [project,user,hash,input.shared])).rows[0].id, replayed: true };
    await audit(db,organization,project,user,"history.imported",inserted.id,{shared:input.shared,messageCount:input.messages.length});
    return { id: inserted.id, replayed: false };
  });
}
export function deleteHistory(user: string, project: string, id: string) {
  uuid.parse(project); uuid.parse(id);
  return asUser(user, async db => {
    const row = (await db.query("DELETE FROM collab.imported_histories WHERE id=$1 AND project_id=$2 RETURNING organization_id",[id,project])).rows[0];
    if (!row) throw new DomainError("not_found", "记录不存在、不可删除或需要多因素验证。",404);
    await audit(db,row.organization_id,project,user,"history.deleted",id);
    return { deleted:true };
  });
}
