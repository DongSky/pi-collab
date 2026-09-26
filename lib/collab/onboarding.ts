import { createHash, randomBytes } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { z } from "zod";
import type { PoolClient } from "pg";
import { asUser, database } from "./database";
import { DomainError } from "./policy";

const token = z.string().regex(/^[a-f0-9]{64}$/);
const email = z.email().max(254).transform(value => value.toLowerCase());
const name = z.string().trim().min(1).max(120);
const password = z.string().min(12).max(128);
export const bootstrapInput = z.object({ token, name, email, password, organizationName: name }).strict();
export const previewInput = z.object({ token }).strict();
export const acceptanceInput = z.object({ token, email, name: name.optional(), password: password.optional() }).strict();
export const invitationInput = z.object({
  email, role: z.enum(["admin", "member"]).default("member"),
  projectId: z.uuid().optional(), projectRole: z.enum(["maintainer", "developer", "reviewer", "viewer"]).optional(),
}).strict().refine(value => !!value.projectId === !!value.projectRole, "Project and project role are required together");
export const memberInput = z.object({ role: z.enum(["owner", "admin", "member"]), active: z.boolean() }).strict();

export const tokenHash = (value: string) => createHash("sha256").update(value).digest("hex");

async function publicAttempt(bucket: string, max: number) {
  // Runs outside provisioning transactions so rejected attempts also count.
  const { rows } = await database().query("SELECT collab.allow_public_attempt($1,$2,60) AS allowed", [bucket, max]);
  if (!rows[0].allowed) throw new DomainError("rate_limited", "尝试次数过多，请稍后重试。", 429);
}

export async function setupStatus() {
  const { rows } = await database().query("SELECT collab.setup_needed() AS needed");
  return { needed: rows[0].needed as boolean };
}

export async function bootstrap(input: z.infer<typeof bootstrapInput>) {
  input = bootstrapInput.parse(input);
  await publicAttempt("bootstrap", 10);
  const hash = tokenHash(input.token);
  const { rows } = await database().query("SELECT collab.bootstrap_valid($1) AS valid", [hash]);
  if (!rows[0].valid) throw new DomainError("setup_unavailable", "初始化已完成或初始化令牌无效。", 409);
  const credential = await hashPassword(input.password);
  return (await database().query("SELECT collab.bootstrap($1,$2,$3,$4,$5) AS result", [hash, input.name, input.email, credential, input.organizationName])).rows[0].result;
}

export async function previewInvitation(rawToken: string) {
  token.parse(rawToken);
  await publicAttempt("invitation-preview", 120);
  const { rows } = await database().query("SELECT collab.invitation_preview($1) AS invitation", [tokenHash(rawToken)]);
  if (!rows[0].invitation) throw new DomainError("invitation_unavailable", "邀请已失效、被撤销或已使用。", 404);
  return rows[0].invitation;
}

export async function acceptInvitation(userId: string | undefined, input: z.infer<typeof acceptanceInput>) {
  input = acceptanceInput.parse(input);
  await publicAttempt("invitation-accept", 30);
  await previewInvitation(input.token);
  const credential = !userId && input.password ? await hashPassword(input.password) : null;
  return asUser(userId ?? "", async db => (await db.query("SELECT collab.accept_invitation($1,$2,$3,$4) AS result", [tokenHash(input.token), input.name ?? null, input.email, credential])).rows[0].result);
}

async function administrator(db: PoolClient, organizationId: string, sensitive: boolean) {
  z.uuid().parse(organizationId);
  const { rows } = await db.query("SELECT collab.org_role($1) AS role, collab.actor_has_mfa() AS mfa", [organizationId]);
  if (!["owner", "admin"].includes(rows[0].role)) throw new DomainError("not_found", "团队不存在或不可管理。", 404);
  if (sensitive && !rows[0].mfa) throw new DomainError("mfa_required", "请先在账户安全中启用多因素验证。", 403);
  return rows[0].role as "owner" | "admin";
}

export async function organizationDetail(userId: string, organizationId: string) {
  return asUser(userId, async db => {
    const deleted = (await db.query("SELECT collab.deleted_organizations() AS organizations")).rows[0].organizations.find((item: { id: string }) => item.id === organizationId);
    if (deleted) return { organization: { ...deleted, lifecycle_version: deleted.version }, deleted: true, role: "owner", actorId: userId, members: [], invitations: [], projects: [], governance: [], blockers: [] };
    const role = await administrator(db, organizationId, false);
    const organization = (await db.query("SELECT id,name,lifecycle_version::text FROM collab.organizations WHERE id=$1", [organizationId])).rows[0];
    const members = (await db.query('SELECT m.user_id,m.role,m.active,m.authorization_version::text,u.name,u.email,u."twoFactorEnabled" AS mfa FROM collab.memberships m JOIN public."user" u ON u.id=m.user_id WHERE m.organization_id=$1 ORDER BY u.name', [organizationId])).rows;
    const invitations = (await db.query("SELECT id,email,role,project_id,project_role,expires_at,accepted_at,revoked_at FROM collab.invitations WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100", [organizationId])).rows;
    const projects = (await db.query("SELECT id,name FROM collab.projects WHERE organization_id=$1 AND collab.project_role(id)='maintainer'", [organizationId])).rows;
    const governance = (await db.query("SELECT collab.project_governance($1) AS projects", [organizationId])).rows[0].projects;
    const blockers = role === "owner" ? (await db.query("SELECT collab.organization_blockers($1) AS blockers", [organizationId])).rows[0].blockers : [];
    return { organization, role, actorId: userId, members, invitations, projects, governance, blockers, deleted: false };
  });
}

export async function createInvitation(userId: string, organizationId: string, input: z.infer<typeof invitationInput>) {
  input = invitationInput.parse(input);
  const rawToken = randomBytes(32).toString("hex");
  return asUser(userId, async db => {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,811))", [organizationId]);
    const role = await administrator(db, organizationId, true);
    if (role === "admin" && input.role === "admin") throw new DomainError("forbidden", "仅所有者可以邀请管理员。", 403);
    if (input.projectId && !(await db.query("SELECT id FROM collab.projects WHERE id=$1 AND organization_id=$2 AND collab.project_role(id)='maintainer'", [input.projectId, organizationId])).rowCount) throw new DomainError("forbidden", "仅项目维护者可以授予项目权限。", 403);
    const invitation = (await db.query("INSERT INTO collab.invitations(organization_id,email,role,project_id,project_role,invited_by,token_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '48 hours') RETURNING id,expires_at", [organizationId, input.email, input.role, input.projectId ?? null, input.projectRole ?? null, userId, tokenHash(rawToken)])).rows[0];
    await db.query("INSERT INTO collab.audit_events(organization_id,actor_id,action,resource_id,detail) VALUES($1,$2,'invitation.created',$3,$4)", [organizationId, userId, invitation.id, { role: input.role, projectId: input.projectId }]);
    return { ...invitation, url: `${process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:30142"}/invite#${rawToken}` };
  });
}

export async function revokeInvitation(userId: string, organizationId: string, invitationId: string) {
  z.uuid().parse(invitationId);
  return asUser(userId, async db => {
    await administrator(db, organizationId, true);
    const result = await db.query("UPDATE collab.invitations SET revoked_at=now() WHERE id=$1 AND organization_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id", [invitationId, organizationId]);
    if (!result.rowCount) throw new DomainError("not_found", "邀请不存在或已使用。", 404);
    await db.query("INSERT INTO collab.audit_events(organization_id,actor_id,action,resource_id) VALUES($1,$2,'invitation.revoked',$3)", [organizationId, userId, invitationId]);
    return { success: true };
  });
}

export async function changeMember(userId: string, organizationId: string, target: string, input: z.infer<typeof memberInput>) {
  z.uuid().parse(organizationId); z.string().min(1).max(128).parse(target); input = memberInput.parse(input);
  return asUser(userId, async db => {
    await db.query("SELECT collab.change_member($1,$2,$3,$4)", [organizationId, target, input.role, input.active]);
    return { success: true };
  });
}

export const organizationActionInput = z.object({
  action: z.enum(["delete", "restore", "transfer"]), expectedVersion: z.string().regex(/^[1-9][0-9]{0,17}$/),
  confirmation: name, reason: z.string().trim().min(10).max(2000),
  targetUserId: z.string().min(1).max(128).optional(), targetVersion: z.string().regex(/^[1-9][0-9]{0,17}$/).optional(),
}).strict();
export function organizationAction(userId: string, organizationId: string, raw: z.infer<typeof organizationActionInput>) {
  z.uuid().parse(organizationId); const input = organizationActionInput.parse(raw);
  return asUser(userId, async db => (await db.query("SELECT collab.organization_lifecycle($1,$2,$3,$4,$5,$6,$7) AS result", [organizationId, input.action, input.expectedVersion, input.confirmation, input.reason, input.targetUserId ?? null, input.targetVersion ?? null])).rows[0].result);
}
