import { createHash } from "node:crypto";
import { z } from "zod";
import { asUser } from "./database";
import { audit, projectRole, uuid } from "./projects";
import { archiveImport, archiveManifest, type ArchiveFile } from "./history-archive-format";
import { DomainError } from "./policy";
export function listHistoryArchives(user: string, project: string) {
  uuid.parse(project);
  return asUser(user, async db => {
    await projectRole(db, project, "project.read");
    return { archives: (await db.query('SELECT h.id,h.title,h.owner_id,u.name AS owner_name,h.shared,h.created_at,h.byte_count::text,jsonb_array_length(h.files) AS file_count FROM collab.history_archives h JOIN public."user" u ON u.id=h.owner_id WHERE project_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100', [project])).rows };
  });
}
export function importHistoryArchive(user: string, project: string, raw: unknown) {
  uuid.parse(project); const input = archiveImport.parse(raw);
  input.files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  let manifest;
  try { manifest = archiveManifest(input.files); } catch (e) { throw new DomainError("invalid_history_archive", e instanceof Error ? e.message : "无效的归档。", 400); }
  if (new Set(manifest.map(f => f.sessionId)).size !== manifest.length) throw new DomainError("invalid_history_archive", "同组出现重复 session ID，请只保留每个会话的一个版本。", 400);
  return asUser(user, async db => {
    await projectRole(db, project, "task.create");
    if (!(await db.query("SELECT collab.actor_has_mfa() AS enabled")).rows[0].enabled) throw new DomainError("mfa_required", "请先启用多因素验证。", 403);
    const organization = (await db.query("SELECT organization_id FROM collab.projects WHERE id=$1", [project])).rows[0].organization_id;
    const files = JSON.stringify(input.files);
    const inserted = (await db.query("INSERT INTO collab.history_archives(organization_id,project_id,owner_id,title,files,shared) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id", [organization, project, user, input.title, files, input.shared])).rows[0];
    if (!inserted) return { id: (await db.query("SELECT id FROM collab.history_archives WHERE project_id=$1 AND owner_id=$2 AND files=$3::jsonb AND shared=$4", [project, user, files, input.shared])).rows[0].id, replayed: true };
    await audit(db, organization, project, user, "history_archive.imported", inserted.id, { shared: input.shared, fileCount: manifest.length, entryCount: manifest.reduce((n, f) => n + f.entryCount, 0) });
    return { id: inserted.id, replayed: false };
  });
}
export function readHistoryArchive(user: string, project: string, id: string, fileIndex?: number) {
  uuid.parse(project); uuid.parse(id); if (fileIndex !== undefined) z.number().int().min(0).max(19).parse(fileIndex);
  return asUser(user, async db => {
    const row = (await db.query("SELECT id,title,files,shared,owner_id,created_at,content_hash FROM collab.history_archives WHERE project_id=$1 AND id=$2", [project, id])).rows[0];
    if (!row) throw new DomainError("not_found", "归档不存在或不可访问。", 404);
    const files = row.files as ArchiveFile[];
    if (fileIndex !== undefined) {
      const file = files[fileIndex]; if (!file) throw new DomainError("not_found", "归档文件不存在。", 404);
      return { ...file, sha256: createHash("sha256").update(file.source, "utf8").digest("hex") };
    }
    return { id: row.id, title: row.title, shared: row.shared, ownerId: row.owner_id, createdAt: row.created_at, contentHash: row.content_hash, files: archiveManifest(files).map((f, index) => ({ ...f, index, sha256: createHash("sha256").update(files[index].source, "utf8").digest("hex") })) };
  });
}
export function deleteHistoryArchive(user: string, project: string, id: string) {
  uuid.parse(project); uuid.parse(id);
  return asUser(user, async db => {
    const row = (await db.query("DELETE FROM collab.history_archives WHERE id=$1 AND project_id=$2 RETURNING organization_id", [id, project])).rows[0];
    if (!row) throw new DomainError("not_found", "归档不存在、不可删除或需要多因素验证。", 404);
    await audit(db, row.organization_id, project, user, "history_archive.deleted", id);
    return { deleted: true };
  });
}
