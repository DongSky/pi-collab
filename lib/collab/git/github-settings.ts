import { z } from "zod";
import { asUser } from "../database";
import { DomainError } from "../policy";
import { uuid, projectRole } from "../projects";
import { githubId } from "./github-schema";

export function listGitHubSyncs(userId: string, projectId: string) {
  uuid.parse(projectId);
  return asUser(userId, async db => {
    await projectRole(db, projectId, "project.read");
    return { syncs: (await db.query("SELECT s.id,s.repository_id AS \"repositoryId\",r.name,s.status,s.classification,s.outcome,s.failure,collab.github_sync_dispatch_state(s.id) AS dispatch,s.target_branch AS branch,s.old_sha AS \"oldSha\",s.evidence->>'targetSha' AS \"remoteSha\",s.created_at AS \"createdAt\" FROM collab.github_syncs s JOIN collab.repositories r ON r.id=s.repository_id WHERE s.project_id=$1 ORDER BY s.created_at DESC,s.id DESC LIMIT 20", [projectId])).rows };
  });
}

export function listGitHubImports(userId: string, projectId: string) {
  uuid.parse(projectId);
  return asUser(userId, async db => {
    await projectRole(db, projectId, "project.read");
    return { imports: (await db.query("SELECT id,repository_id AS \"repositoryId\",request->>'name' AS name,status,failure,collab.github_import_dispatch_state(id) AS dispatch,evidence->>'targetSha' AS \"baseSha\",created_at AS \"createdAt\",finished_at AS \"finishedAt\" FROM collab.github_imports WHERE project_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20", [projectId])).rows };
  });
}

export function gitHubImportOptions(userId: string, projectId: string) {
  uuid.parse(projectId);
  return asUser(userId, async db => {
    await projectRole(db, projectId, "project.read");
    const scope = (await db.query("SELECT organization_id,collab.project_role(id)='maintainer' AND collab.org_role(organization_id) IN ('owner','admin') AS allowed FROM collab.projects WHERE id=$1", [projectId])).rows[0];
    if (!scope.allowed) return { canImport: false, installations: [] };
    return { canImport: true, installations: (await db.query("SELECT id,account_login AS \"accountLogin\",app_slug AS \"appSlug\" FROM collab.github_installations WHERE organization_id=$1 AND enabled ORDER BY created_at,id LIMIT 100", [scope.organization_id])).rows };
  });
}
export const requestGitHubImportInput = z.object({ connectionId: z.uuid(), githubRepositoryId: githubId, name: z.string().trim().min(1).max(120), reason: z.string().trim().min(10).max(2000), idempotencyKey: z.uuid() }).strict();
export const gitHubImportActionInput = z.object({ action: z.enum(["cancel", "reconcile"]), reason: z.string().trim().min(10).max(2000), idempotencyKey: z.uuid() }).strict();
export function requestGitHubImport(userId: string, projectId: string, raw: z.input<typeof requestGitHubImportInput>) {
  uuid.parse(projectId); const input = requestGitHubImportInput.parse(raw);
  return asUser(userId, async db => (await db.query("SELECT collab.request_github_import($1,$2,$3,$4,$5,$6) AS result", [projectId, input.connectionId, input.githubRepositoryId, input.name, input.reason, input.idempotencyKey])).rows[0].result);
}
export function gitHubImportAction(userId: string, importId: string, raw: z.infer<typeof gitHubImportActionInput>) {
  uuid.parse(importId); const input = gitHubImportActionInput.parse(raw);
  return asUser(userId, async db => (await db.query("SELECT collab.github_import_action($1,$2,$3,$4) AS result", [importId, input.action, input.reason, input.idempotencyKey])).rows[0].result);
}

export const disableGitHubInput = z.object({ expectedVersion: z.string().regex(/^[1-9][0-9]{0,17}$/), reason: z.string().trim().min(10).max(2000), idempotencyKey: z.uuid() }).strict();
export function listGitHubInstallations(userId: string, organizationId: string) {
  uuid.parse(organizationId);
  return asUser(userId, async db => {
    const role = (await db.query("SELECT collab.org_role($1) AS role", [organizationId])).rows[0].role;
    if (!["owner", "admin"].includes(role)) throw new DomainError("forbidden", "只有团队管理员可查看 GitHub 安装配置。", 403);
    return { installations: (await db.query("SELECT id,app_id,installation_id,account_id,account_login,account_type,app_slug,public_key_fingerprint,enabled,version::text,verified_at,collab.github_webhook_state(id) AS webhook,collab.github_credential_present(id) AS credential_present FROM collab.github_installations WHERE organization_id=$1 ORDER BY created_at,id LIMIT 100", [organizationId])).rows };
  });
}
export function disableGitHubInstallation(userId: string, id: string, raw: z.infer<typeof disableGitHubInput>) {
  uuid.parse(id); const input = disableGitHubInput.parse(raw);
  return asUser(userId, async db => (await db.query("SELECT collab.disable_github_installation($1,$2,$3,$4) AS result", [id, input.expectedVersion, input.reason, input.idempotencyKey])).rows[0].result);
}

export const requestGitHubSyncInput = z.object({ expectedSha: z.string().regex(/^[a-f0-9]{40}$/), expectedBranch: z.string().min(1).max(240), acknowledge: z.literal(true), reason: z.string().trim().min(10).max(2000), idempotencyKey: z.uuid() }).strict();
export const gitHubSyncActionInput = z.object({ action: z.enum(["cancel", "reconcile"]), reason: z.string().trim().min(10).max(2000), idempotencyKey: z.uuid() }).strict();
export function requestGitHubSync(userId: string, repositoryId: string, raw: z.infer<typeof requestGitHubSyncInput>) {
  uuid.parse(repositoryId); const input = requestGitHubSyncInput.parse(raw);
  return asUser(userId, async db => (await db.query("SELECT collab.request_github_sync($1,$2,$3,$4,$5,$6) AS result", [repositoryId, input.expectedSha, input.expectedBranch, input.acknowledge, input.reason, input.idempotencyKey])).rows[0].result);
}
export function gitHubSyncAction(userId: string, syncId: string, raw: z.infer<typeof gitHubSyncActionInput>) {
  uuid.parse(syncId); const input = gitHubSyncActionInput.parse(raw);
  return asUser(userId, async db => (await db.query("SELECT collab.github_sync_action($1,$2,$3,$4) AS result", [syncId, input.action, input.reason, input.idempotencyKey])).rows[0].result);
}

export function removeGitHubCredential(userId: string, id: string, raw: z.infer<typeof disableGitHubInput>) {
  uuid.parse(id); const input = disableGitHubInput.parse(raw);
  return asUser(userId, async db => (await db.query("SELECT collab.remove_github_credential($1,$2,$3,$4) AS result", [id,input.expectedVersion,input.reason,input.idempotencyKey])).rows[0].result);
}
