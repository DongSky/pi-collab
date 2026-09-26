import { asUser } from "./database";
import { projectRole, uuid } from "./projects";
import { DomainError } from "./policy";
import { validationInput, validationProfileInput } from "./validation-config";
import type { z } from "zod";

export function createValidationProfile(userId: string, projectId: string, raw: z.infer<typeof validationProfileInput>) {
  uuid.parse(projectId); const input = validationProfileInput.parse(raw);
  return asUser(userId, async db => (await db.query("SELECT collab.create_validation_profile($1,$2,$3,$4,$5) AS result", [projectId, input.repositoryId, input.name, JSON.stringify(input.config), input.idempotencyKey])).rows[0].result);
}
export function listValidationProfiles(userId: string, projectId: string) {
  uuid.parse(projectId);
  return asUser(userId, async db => {
    await projectRole(db, projectId, "project.read");
    return { profiles: (await db.query("SELECT id,repository_id,name,config,created_at FROM collab.validation_profiles WHERE project_id=$1 ORDER BY created_at DESC,id LIMIT 100", [projectId])).rows };
  });
}
export function requestValidation(userId: string, snapshotId: string, raw: z.infer<typeof validationInput>) {
  uuid.parse(snapshotId); const input = validationInput.parse(raw);
  return asUser(userId, async db => (await db.query("SELECT collab.request_validation($1,$2,$3) AS result", [snapshotId, input.profileId, input.idempotencyKey])).rows[0].result);
}
export function listValidations(userId: string, taskId: string) {
  uuid.parse(taskId);
  return asUser(userId, async db => {
    if (!(await db.query("SELECT 1 FROM collab.tasks WHERE id=$1", [taskId])).rowCount) throw new DomainError("not_found", "任务不存在或不可访问。", 404);
    return { validations: (await db.query(`SELECT v.id,v.snapshot_id,v.profile_id,p.name AS profile_name,v.requested_by,v.status,v.stop_requested,v.error_code,v.created_at,v.finished_at,
      v.evidence->>'worktreeCommit' AS worktree_commit,v.manifest_hash FROM collab.validations v JOIN collab.validation_profiles p ON p.id=v.profile_id
      WHERE v.task_id=$1 ORDER BY v.created_at DESC,v.id LIMIT 50`, [taskId])).rows };
  });
}
export function validationDetail(userId: string, validationId: string) {
  uuid.parse(validationId);
  return asUser(userId, async db => {
    const row = (await db.query("SELECT id,snapshot_id,profile_id,status,error_code,evidence,manifest_hash,created_at,finished_at FROM collab.validations WHERE id=$1", [validationId])).rows[0];
    if (!row) throw new DomainError("not_found", "验证记录不存在或不可访问。", 404);
    return { validation: row };
  });
}
export function cancelValidation(userId: string, validationId: string) {
  uuid.parse(validationId);
  return asUser(userId, async db => (await db.query("SELECT collab.cancel_validation($1) AS result", [validationId])).rows[0].result);
}
