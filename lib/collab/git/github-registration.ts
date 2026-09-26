import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { GitHubReadClient } from "./github-client";
import { GitHubError, privateKey, openGitHubKey, publicKeyFingerprint, sealGitHubKey } from "./github-credentials";
import { githubAppConfig, githubId } from "./github-schema";

export const registrationInput = githubAppConfig.extend({ organizationId: z.uuid(), actorId: z.string().min(1).max(200), idempotencyKey: z.uuid(), reason: z.string().trim().min(10).max(2000) }).strict();
export const bindingInput = z.object({ repositoryId: z.uuid(), connectionId: z.uuid(), githubRepositoryId: githubId, actorId: z.string().min(1).max(200), idempotencyKey: z.uuid(), reason: z.string().trim().min(10).max(2000) }).strict();
async function transaction<T>(admin: Pool, actor: string, work: (db: PoolClient) => Promise<T>) {
  const db = await admin.connect();
  try { await db.query("BEGIN"); await db.query("SELECT set_config('collab.user_id',$1,true)", [actor]); const value = await work(db); await db.query("COMMIT"); return value; }
  catch (error) { await db.query("ROLLBACK").catch(() => {}); throw error; }
  finally { db.release(); }
}
async function organizationAuthority(db: PoolClient, organization: string, expected?: string) {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,811))", [organization]);
  await db.query('SELECT 1 FROM public."user" WHERE id=collab.actor() FOR SHARE');
  const row = (await db.query("SELECT authorization_version::text AS version FROM collab.memberships WHERE organization_id=$1 AND user_id=collab.actor() AND active AND role IN ('owner','admin') AND collab.actor_has_mfa()", [organization])).rows[0];
  if (!row || (expected && row.version !== expected)) throw new GitHubError("github_admin_authority_required");
  return row.version as string;
}
/** Explicit local administration only. No Web endpoint accepts private keys.
 * Preflight and settlement recheck authority; network waits hold no SQL locks. */
export async function registerGitHubInstallation(admin: Pool, master: Buffer, raw: z.input<typeof registrationInput>, pem: Buffer, transport?: typeof fetch) {
  const input = registrationInput.parse(raw), config = githubAppConfig.parse({ appId: input.appId, installationId: input.installationId, accountId: input.accountId });
  const key = privateKey(pem), fingerprint = publicKeyFingerprint(key), payload = { ...config, fingerprint, reason: input.reason };
  const grant = await transaction(admin, input.actorId, async db => {
    const version = await organizationAuthority(db, input.organizationId);
    const prior = (await db.query("SELECT id,request=$4::jsonb AS same,version::text,enabled FROM collab.github_installations WHERE organization_id=$1 AND registered_by=$2 AND idempotency_key=$3", [input.organizationId, input.actorId, input.idempotencyKey, payload])).rows[0];
    if (prior && !prior.same) throw new GitHubError("idempotency_conflict");
    return { version, prior };
  });
  if (grant.prior) return { connectionId: grant.prior.id as string, version: grant.prior.version as string, enabled: grant.prior.enabled as boolean, replayed: true };
  const evidence = await new GitHubReadClient(config, key, transport).inspectInstallation();
  return transaction(admin, input.actorId, async db => {
    await organizationAuthority(db, input.organizationId, grant.version);
    const prior = (await db.query("SELECT id,version::text,enabled,request=$4::jsonb AS same FROM collab.github_installations WHERE organization_id=$1 AND registered_by=$2 AND idempotency_key=$3", [input.organizationId, input.actorId, input.idempotencyKey, payload])).rows[0];
    if (prior) { if (!prior.same) throw new GitHubError("idempotency_conflict"); return { connectionId: prior.id as string, version: prior.version as string, enabled: prior.enabled as boolean, replayed: true }; }
    if ((await db.query("SELECT 1 FROM collab.github_installations WHERE app_id=$1 AND installation_id=$2", [config.appId, config.installationId])).rowCount) throw new GitHubError("github_installation_already_registered");
    const id = randomUUID();
    await db.query("INSERT INTO collab.github_installations(id,organization_id,app_id,installation_id,account_id,account_login,account_type,app_slug,public_key_fingerprint,evidence,registered_by,idempotency_key,request,verified_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
      [id, input.organizationId, config.appId, config.installationId, config.accountId, evidence.accountLogin, evidence.accountType, evidence.appSlug, fingerprint, evidence, input.actorId, input.idempotencyKey, payload, evidence.verifiedAt]);
    await db.query("INSERT INTO collab_git.credentials(connection_id,sealed) VALUES($1,$2)", [id, sealGitHubKey(master, { ...config, connectionId: id, organizationId: input.organizationId }, key)]);
    await db.query("INSERT INTO collab.audit_events(organization_id,actor_id,action,resource_id,detail) VALUES($1,$2,'github.installation_registered',$3,$4)", [input.organizationId, input.actorId, id, { ...payload, source: "local-administrator-cli" }]);
    return { connectionId: id, version: "1", enabled: true, replayed: false };
  });
}
async function bindingAuthority(db: PoolClient, repositoryId: string) {
  const repo = (await db.query("SELECT * FROM collab.repositories WHERE id=$1", [repositoryId])).rows[0];
  if (!repo) throw new GitHubError("github_repository_unavailable");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,811))", [repo.organization_id]);
  await db.query('SELECT 1 FROM public."user" WHERE id=collab.actor() FOR SHARE');
  const grant = (await db.query("SELECT m.authorization_version::text AS organization,pm.authorization_version::text AS project FROM collab.memberships m JOIN collab.project_memberships pm ON pm.organization_id=m.organization_id AND pm.user_id=m.user_id WHERE m.organization_id=$1 AND pm.project_id=$2 AND m.user_id=collab.actor() AND m.active AND pm.active AND pm.role='maintainer' AND collab.actor_has_mfa()", [repo.organization_id, repo.project_id])).rows[0];
  if (!grant) throw new GitHubError("github_maintainer_authority_required");
  return { repository: (await db.query("SELECT * FROM collab.repositories WHERE id=$1", [repositoryId])).rows[0], grant: `${grant.organization}:${grant.project}` };
}
/** Attach a separately imported local repository only when its exact current
 * default-branch/base agrees with the observed remote. This is metadata linkage,
 * not cloning, fetching, pushing, PR creation or remote merge authority. */
export async function bindGitHubRepository(admin: Pool, master: Buffer, raw: z.input<typeof bindingInput>, transport?: typeof fetch) {
  const input = bindingInput.parse(raw), payload = { connectionId: input.connectionId, githubRepositoryId: input.githubRepositoryId, reason: input.reason };
  const initial = await transaction(admin, input.actorId, async db => {
    const authority = await bindingAuthority(db, input.repositoryId);
    const prior = (await db.query("SELECT *,request=$3::jsonb AS same FROM collab.github_bindings WHERE repository_id=$1 AND bound_by=$2", [input.repositoryId, input.actorId, payload])).rows[0];
    if (prior?.idempotency_key === input.idempotencyKey && !prior.same) throw new GitHubError("idempotency_conflict");
    const connection = (await db.query("SELECT c.*,s.sealed FROM collab.github_installations c JOIN collab_git.credentials s ON s.connection_id=c.id WHERE c.id=$1 AND c.organization_id=$2 AND c.enabled", [input.connectionId, authority.repository.organization_id])).rows[0];
    if (!connection) throw new GitHubError("github_connection_unavailable");
    if (prior?.idempotency_key === input.idempotencyKey) return { ...authority, connection, replayed: true };
    if (authority.repository.provider !== "local" || (await db.query("SELECT 1 FROM collab.github_bindings WHERE repository_id=$1 OR github_repository_id=$2 UNION ALL SELECT 1 FROM collab.github_imports WHERE github_repository_id=$2 AND status<>'failed'", [input.repositoryId, input.githubRepositoryId])).rowCount) throw new GitHubError("github_repository_already_bound");
    return { ...authority, connection, replayed: false };
  });
  if (initial.replayed) return { repositoryId: input.repositoryId, replayed: true };
  const c = initial.connection, config = githubAppConfig.parse({ appId: c.app_id, installationId: c.installation_id, accountId: c.account_id });
  const key = openGitHubKey(master, { ...config, connectionId: c.id, organizationId: c.organization_id }, c.sealed);
  const evidence = await new GitHubReadClient(config, key, transport).inspectRepository(input.githubRepositoryId);
  return transaction(admin, input.actorId, async db => {
    const current = await bindingAuthority(db, input.repositoryId);
    if (current.grant !== initial.grant) throw new GitHubError("github_maintainer_authority_required");
    if (!(await db.query("SELECT 1 FROM collab.github_installations WHERE id=$1 AND enabled AND version=$2", [c.id, c.version])).rowCount) throw new GitHubError("github_connection_unavailable");
    const prior = (await db.query("SELECT *,request=$3::jsonb AS same FROM collab.github_bindings WHERE repository_id=$1 AND bound_by=$2", [input.repositoryId, input.actorId, payload])).rows[0];
    if (prior?.idempotency_key === input.idempotencyKey) { if (!prior.same) throw new GitHubError("idempotency_conflict"); return { repositoryId: input.repositoryId, replayed: true }; }
    if (current.repository.provider !== "local") throw new GitHubError("github_repository_already_bound");
    if ((await db.query("SELECT 1 FROM collab.github_imports WHERE github_repository_id=$1 AND status<>'failed'", [input.githubRepositoryId])).rowCount) throw new GitHubError("github_repository_already_bound");
    if (current.repository.base_sha !== evidence.targetSha || current.repository.default_branch !== evidence.defaultBranch) throw new GitHubError("github_baseline_mismatch");
    if ((await db.query("SELECT 1 FROM collab.promotions WHERE repository_id=$1 AND status NOT IN ('applied','aborted')", [input.repositoryId])).rowCount) throw new GitHubError("github_repository_busy");
    await db.query("INSERT INTO collab.github_bindings(repository_id,organization_id,project_id,connection_id,installation_version,github_repository_id,evidence,bound_by,idempotency_key,request,verified_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [input.repositoryId, current.repository.organization_id, current.repository.project_id, c.id, c.version, input.githubRepositoryId, evidence, input.actorId, input.idempotencyKey, payload, evidence.verifiedAt]);
    await db.query("UPDATE collab.repositories SET provider='github' WHERE id=$1", [input.repositoryId]);
    await db.query("INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES($1,$2,$3,'github.repository_bound',$4,$5)", [current.repository.organization_id, current.repository.project_id, input.actorId, input.repositoryId, { ...payload, targetSha: evidence.targetSha, connectionVersion: c.version }]);
    return { repositoryId: input.repositoryId, replayed: false };
  });
}

export const installationLifecycleInput=z.object({connectionId:z.uuid(),actorId:z.string().min(1),expectedVersion:z.string().regex(/^[1-9][0-9]{0,17}$/),reason:z.string().trim().min(10).max(2000),idempotencyKey:z.uuid(),enable:z.boolean().default(false)}).strict();
/** Local operator workflow: refresh permissions or rotate an explicit key, revalidating every bound repository before re-enabling access. */
export async function refreshGitHubInstallation(admin:Pool,master:Buffer,raw:z.input<typeof installationLifecycleInput>,pem?:Buffer,transport?:typeof fetch){
 const input=installationLifecycleInput.parse(raw),replacement=pem?privateKey(pem):null;
 const request={action:replacement?"rotate":"refresh",expectedVersion:input.expectedVersion,reason:input.reason,enable:input.enable,fingerprint:replacement?publicKeyFingerprint(replacement):null};
 const load=async(db:PoolClient)=>{
  let c=(await db.query("SELECT c.*,s.sealed FROM collab.github_installations c LEFT JOIN collab_git.credentials s ON s.connection_id=c.id WHERE c.id=$1",[input.connectionId])).rows[0];
  if(!c)throw new GitHubError("github_connection_unavailable");
  const authority=await organizationAuthority(db,c.organization_id);
  c=(await db.query("SELECT c.*,s.sealed FROM collab.github_installations c LEFT JOIN collab_git.credentials s ON s.connection_id=c.id WHERE c.id=$1",[input.connectionId])).rows[0];
  const previous=(await db.query("SELECT request,result FROM collab_git.installation_lifecycle WHERE connection_id=$1 AND actor_id=$2 AND request_key=$3",[c.id,input.actorId,input.idempotencyKey])).rows[0];
  if(previous&&JSON.stringify(previous.request)!==JSON.stringify(request)){
   const same=(await db.query("SELECT $1::jsonb=$2::jsonb AS same",[previous.request,request])).rows[0].same;if(!same)throw new GitHubError("idempotency_conflict");
  }
  if(!previous&&String(c.version)!==input.expectedVersion)throw new GitHubError("stale_github_connection");
  const bindings=(await db.query("SELECT repository_id,github_repository_id,evidence,version::text FROM collab.github_bindings WHERE connection_id=$1 ORDER BY repository_id",[c.id])).rows;
  return {c,authority,previous,bindings};
 };
 const initial=await transaction(admin,input.actorId,load);if(initial.previous)return {...initial.previous.result,replayed:true};
 const c=initial.c,config=githubAppConfig.parse({appId:c.app_id,installationId:c.installation_id,accountId:c.account_id});
 const key=replacement??openGitHubKey(master,{...config,connectionId:c.id,organizationId:c.organization_id},c.sealed);
 const reader=new GitHubReadClient(config,key,transport),evidence=await reader.inspectInstallation();
 const repositories: {id:string;version:string;evidence:Awaited<ReturnType<GitHubReadClient["inspectRepository"]>>}[]=[];
 for(const b of initial.bindings){const next=await reader.inspectRepository(b.github_repository_id),old=b.evidence;
  if(next.repositoryId!==old.repositoryId||next.nodeId!==old.nodeId||next.ownerId!==old.ownerId||next.ownerLogin!==old.ownerLogin||next.name!==old.name||next.private!==old.private||next.visibility!==old.visibility||next.defaultBranch!==old.defaultBranch)throw new GitHubError("github_repository_changed");
  repositories.push({id:b.repository_id,version:b.version,evidence:next});
 }
 return transaction(admin,input.actorId,async db=>{
  const current=await load(db);if(current.previous)return {...current.previous.result,replayed:true};
  if(current.authority!==initial.authority||JSON.stringify(current.bindings.map(b=>[b.repository_id,b.version]))!==JSON.stringify(initial.bindings.map(b=>[b.repository_id,b.version])))throw new GitHubError("stale_github_connection");
  const version=String(BigInt(c.version)+BigInt(1)),enabled=input.enable||c.enabled;
  await db.query("UPDATE collab.github_installations SET version=$2,enabled=$3,evidence=$4,verified_at=$5,public_key_fingerprint=$6,account_login=$7,app_slug=$8 WHERE id=$1",[c.id,version,enabled,evidence,evidence.verifiedAt,publicKeyFingerprint(key),evidence.accountLogin,evidence.appSlug]);
  if(replacement)await db.query("INSERT INTO collab_git.credentials(connection_id,sealed) VALUES($1,$2) ON CONFLICT(connection_id) DO UPDATE SET sealed=EXCLUDED.sealed",[c.id,sealGitHubKey(master,{...config,connectionId:c.id,organizationId:c.organization_id},replacement)]);
  for(const r of repositories)await db.query("UPDATE collab.github_bindings SET installation_version=$2,version=version+1,evidence=$3,verified_at=$4 WHERE repository_id=$1",[r.id,version,r.evidence,r.evidence.verifiedAt]);
  const result={connectionId:c.id,version,enabled,credentialPresent:true,publicKeyFingerprint:publicKeyFingerprint(key),repositories:repositories.length};
  await db.query("INSERT INTO collab_git.installation_lifecycle(connection_id,actor_id,request_key,request,result) VALUES($1,$2,$3,$4,$5)",[c.id,input.actorId,input.idempotencyKey,request,result]);
  await db.query("INSERT INTO collab.audit_events(organization_id,actor_id,action,resource_id,detail) VALUES($1,$2,$3,$4,$5)",[c.organization_id,input.actorId,replacement?"github.key_rotated":"github.permissions_refreshed",c.id,{reason:input.reason,version,enabled,fingerprint:result.publicKeyFingerprint}]);
  return {...result,replayed:false};
 });
}
