import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { localConfig, applicationEnvironment, connectionString } from "../../scripts/local-config";
import { migrate } from "../../scripts/migrate";
import { startNativeDatabase } from "../../scripts/native-database";
import { asUser, database } from "../../lib/collab/database";
import { auth, authOptions } from "../../lib/collab/auth";
import { bootstrap, setupStatus, createInvitation, acceptInvitation, previewInvitation, revokeInvitation, changeMember, organizationDetail, tokenHash } from "../../lib/collab/onboarding";
import { createProject } from "../../lib/collab/projects";

const config = await localConfig();
const databaseName = `pi_collab_test_${randomBytes(6).toString("hex")}`;
const privateDirectory = await mkdtemp(path.join(os.tmpdir(), "pi-collab-identity-"));
const native = await startNativeDatabase(config);
Object.assign(process.env, applicationEnvironment(config), { DATABASE_URL: connectionString(config, false, databaseName), PI_COLLAB_DATA_DIR: privateDirectory, PI_COLLAB_AUTH_COOKIE_PREFIX: databaseName });
const admin = new Pool({ connectionString: connectionString(config, true, databaseName) });
const password = randomBytes(20).toString("hex");
const ownerEmail = "owner@onboarding.invalid";
const origin = process.env.BETTER_AUTH_URL!;
let owner: string, organization: string, project: string;
let recoveryCodes: string[] = [], totpURI: string;

class Browser {
  cookies = new Map<string, string>();
  async request(endpoint: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
    const response = await auth().handler(new Request(`${origin}/api/collab/auth/${endpoint}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { origin, "content-type": "application/json", cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; "), "user-agent": "Identity acceptance test", ...extraHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(";")[0], at = pair.indexOf("=");
      if (pair.slice(at + 1)) this.cookies.set(pair.slice(0, at), pair.slice(at + 1)); else this.cookies.delete(pair.slice(0, at));
    }
    return { status: response.status, body: await response.json() };
  }
}
const ownerBrowser = new Browser();
function totp(uri: string) {
  const secret = new URL(uri).searchParams.get("secret")!;
  const bits = [...secret.toUpperCase().replace(/=+$/, "")].map(c => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(c).toString(2).padStart(5, "0")).join("");
  const key = Buffer.from(bits.match(/.{8}/g)!.map(byte => parseInt(byte, 2)));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", key).update(counter).digest(), offset = digest[19] & 15;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}
const rawToken = (invitation: { url: string }) => new URL(invitation.url).hash.slice(1);
const invite = (email: string, role: "member" | "admin" = "member") => createInvitation(owner, organization, { email, role, projectId: project, projectRole: "developer" });
async function join(email: string, role: "member" | "admin" = "member") {
  const invitation = await invite(email, role);
  return acceptInvitation(undefined, { token: rawToken(invitation), email, name: email.split("@")[0], password });
}

before(async () => { await migrate(config, databaseName); });
after(async () => {
  await database().end(); globalThis.__piCollabPool = undefined; await admin.end();
  const cleanup = new Pool({ connectionString: connectionString(config, true, "postgres") });
  await cleanup.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`); await cleanup.end();
  await rm(privateDirectory, { recursive: true, force: true }); await native.stop();
});

test("bootstrap rejects wrong token, provisions atomically exactly once, and stays closed after migration restart", async () => {
  assert.equal((await setupStatus()).needed, true);
  const input = { token: config.bootstrapToken, email: ownerEmail, name: "Owner", password, organizationName: "Acceptance team" };
  await assert.rejects(bootstrap({ ...input, token: randomBytes(32).toString("hex") }), /初始化/);
  assert.equal((await admin.query('SELECT id FROM public."user"')).rowCount, 0);
  const attempts = await Promise.allSettled([bootstrap(input), bootstrap(input)]);
  assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
  const success = attempts.find(result => result.status === "fulfilled") as PromiseFulfilledResult<{ userId: string; organizationId: string }>;
  owner = success.value.userId; organization = success.value.organizationId;
  assert.equal((await admin.query('SELECT id FROM public."user"')).rowCount, 1);
  assert.equal((await admin.query("SELECT * FROM collab.memberships WHERE role='owner'")).rowCount, 1);
  assert.equal((await setupStatus()).needed, false);
  await migrate(config, databaseName);
  await assert.rejects(bootstrap(input), /初始化/);
  assert.equal((await ownerBrowser.request("sign-in/email", { email: ownerEmail, password })).status, 200);
  assert.ok(ownerBrowser.cookies.size > 0);
  assert.ok([...ownerBrowser.cookies.keys()].every(key => key.startsWith(`${databaseName}.`)));
  project = (await createProject(owner, { organizationId: organization, name: "Shared", description: "" })).id;
});

test("administrator must enroll real TOTP; enrollment revokes pre-MFA sessions and cannot be disabled", async () => {
  await assert.rejects(invite("blocked@onboarding.invalid"), /多因素/);
  const old = new Browser();
  assert.equal((await old.request("sign-in/email", { email: ownerEmail, password })).status, 200);
  const enrollment = await ownerBrowser.request("two-factor/enable", { password });
  assert.equal(enrollment.status, 200);
  totpURI = enrollment.body.totpURI; recoveryCodes = enrollment.body.backupCodes;
  assert.equal((await ownerBrowser.request("two-factor/verify-totp", { code: "000000" })).status, 401);
  assert.equal((await ownerBrowser.request("two-factor/verify-totp", { code: totp(totpURI) })).status, 200);
  assert.equal((await old.request("get-session")).body, null);
  assert.ok((await ownerBrowser.request("get-session")).body?.user);
  assert.equal((await ownerBrowser.request("two-factor/disable", { password })).status, 403);
  assert.equal((await admin.query('SELECT "twoFactorEnabled" FROM public."user" WHERE id=$1', [owner])).rows[0].twoFactorEnabled, true);
});

test("MFA login grants no session until TOTP or a single-use recovery code succeeds", async () => {
  const browser = new Browser();
  const login = await browser.request("sign-in/email", { email: ownerEmail, password });
  assert.equal(login.status, 200); assert.equal(login.body.twoFactorRedirect, true);
  assert.equal((await browser.request("get-session")).body, null);
  assert.equal((await browser.request("two-factor/verify-totp", { code: totp(totpURI) })).status, 200);
  assert.ok((await browser.request("get-session")).body?.user);
  const recovery = new Browser();
  await recovery.request("sign-in/email", { email: ownerEmail, password });
  assert.equal((await recovery.request("two-factor/verify-backup-code", { code: recoveryCodes[0] })).status, 200);
  assert.ok((await recovery.request("get-session")).body?.user);
  const replay = new Browser();
  await replay.request("sign-in/email", { email: ownerEmail, password });
  assert.ok((await replay.request("two-factor/verify-backup-code", { code: recoveryCodes[0] })).status >= 400);
  assert.equal((await replay.request("get-session")).body, null);
});

test("invitation stores only a token hash and concurrent acceptance creates one valid account", async () => {
  const email = "invitee@onboarding.invalid", invitation = await invite(email), token = rawToken(invitation);
  const stored = (await admin.query("SELECT * FROM collab.invitations WHERE id=$1", [invitation.id])).rows[0];
  assert.equal(stored.token_hash === tokenHash(token), true);
  assert.equal(JSON.stringify(stored).includes(token), false);
  const input = { token, email, name: "Invitee", password };
  const attempts = await Promise.allSettled([acceptInvitation(undefined, input), acceptInvitation(undefined, input)]);
  assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
  assert.equal((await admin.query('SELECT id FROM public."user" WHERE email=$1', [email])).rowCount, 1);
  assert.equal((await new Browser().request("sign-in/email", { email, password })).status, 200);
  await assert.rejects(previewInvitation(token), /邀请/);
});

test("expired, revoked and email-mismatched invitations cannot create users", async () => {
  for (const kind of ["expired", "revoked", "mismatch"]) {
    const email = `${kind}@onboarding.invalid`, invitation = await invite(email), token = rawToken(invitation);
    if (kind === "expired") await admin.query("UPDATE collab.invitations SET expires_at=now()-interval '1 second' WHERE id=$1", [invitation.id]);
    if (kind === "revoked") await revokeInvitation(owner, organization, invitation.id);
    await assert.rejects(acceptInvitation(undefined, { token, email: kind === "mismatch" ? "wrong@onboarding.invalid" : email, name: "Rejected", password }));
    assert.equal((await admin.query('SELECT id FROM public."user" WHERE email=$1', [email])).rowCount, 0);
  }
});

test("existing-user invitation requires matching login, never resets credentials or escalates existing role", async () => {
  const email = "existing@onboarding.invalid", existing = await join(email);
  const invitation = await invite(email, "admin");
  const input = { token: rawToken(invitation), email, name: "Replacement", password: randomBytes(20).toString("hex") };
  await assert.rejects(acceptInvitation(undefined, input), /sign_in_required/);
  await assert.rejects(acceptInvitation(owner, input), /sign_in_required/);
  await acceptInvitation(existing.userId, input);
  assert.equal((await new Browser().request("sign-in/email", { email, password })).status, 200);
  const membership = await admin.query("SELECT role FROM collab.memberships WHERE organization_id=$1 AND user_id=$2", [organization, existing.userId]);
  assert.equal(membership.rows[0].role, "member");
});

test("demoted inviter loses outstanding authority; administrators cannot promote themselves", async () => {
  const manager = await join("manager@onboarding.invalid", "admin");
  // SQL policy fixture only; the owner enrollment above exercises real TOTP.
  await admin.query('UPDATE public."user" SET "twoFactorEnabled"=true WHERE id=$1', [manager.userId]);
  const invitation = await createInvitation(manager.userId, organization, { email: "late@onboarding.invalid", role: "member" });
  await assert.rejects(changeMember(manager.userId, organization, manager.userId, { role: "owner", active: true }), /forbidden/);
  await assert.rejects(createInvitation(manager.userId, organization, { email: "promoted@onboarding.invalid", role: "admin" }), /所有者/);
  await changeMember(owner, organization, manager.userId, { role: "member", active: true });
  await assert.rejects(acceptInvitation(undefined, { token: rawToken(invitation), email: "late@onboarding.invalid", name: "Late", password }), /inviter_no_longer_authorized/);
});

test("last active owner is protected even under concurrent self-demotions", async () => {
  await assert.rejects(changeMember(owner, organization, owner, { role: "member", active: true }), /last_owner/);
  const coowner = await join("coowner@onboarding.invalid");
  await admin.query('UPDATE public."user" SET "twoFactorEnabled"=true WHERE id=$1', [coowner.userId]);
  await changeMember(owner, organization, coowner.userId, { role: "owner", active: true });
  const attempts = await Promise.allSettled([
    changeMember(owner, organization, owner, { role: "member", active: true }),
    changeMember(coowner.userId, organization, coowner.userId, { role: "member", active: true }),
  ]);
  assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
  assert.equal((await admin.query("SELECT * FROM collab.memberships WHERE organization_id=$1 AND active AND role='owner'", [organization])).rowCount, 1);
  // Restore the fixture via the surviving owner's authorized path.
  const surviving = (await admin.query("SELECT user_id FROM collab.memberships WHERE organization_id=$1 AND active AND role='owner'", [organization])).rows[0].user_id;
  if (surviving !== owner) await changeMember(surviving, organization, owner, { role: "owner", active: true });
  await changeMember(owner, organization, coowner.userId, { role: "member", active: true });
});

test("deactivation invalidates actual cookies, prevents invite reactivation, and retains audit", async () => {
  const email = "disabled@onboarding.invalid", member = await join(email), browser = new Browser();
  await browser.request("sign-in/email", { email, password });
  assert.ok((await browser.request("get-session")).body?.user);
  const invitation = await invite(email);
  await changeMember(owner, organization, member.userId, { role: "member", active: false });
  assert.equal((await browser.request("get-session")).body, null);
  await assert.rejects(acceptInvitation(member.userId, { token: rawToken(invitation), email }), /membership_disabled/);
  assert.equal((await asUser(member.userId, db => db.query("SELECT * FROM collab.projects"))).rowCount, 0);
  assert.ok((await organizationDetail(owner, organization)).members.some(member => !member.active));
  await assert.rejects(organizationDetail(member.userId, organization), /不存在/);
});

test("password reset uses private local mailbox, hides account existence, consumes token and revokes sessions", async () => {
  const email = "reset@onboarding.invalid";
  await join(email);
  const browser = new Browser(); await browser.request("sign-in/email", { email, password });
  const known = await browser.request("request-password-reset", { email, redirectTo: `${origin}/reset-password` });
  const unknown = await browser.request("request-password-reset", { email: "unknown@onboarding.invalid", redirectTo: `${origin}/reset-password` });
  assert.equal(known.status, 200); assert.deepEqual(known, unknown);
  const mailbox = path.join(privateDirectory, "mailbox"), files = await readdir(mailbox);
  assert.equal(files.length, 1);
  const filename = path.join(mailbox, files[0]); assert.equal((await stat(filename)).mode & 0o777, 0o600);
  const message = JSON.parse(await readFile(filename, "utf8")); assert.equal(message.to, email);
  const resetURL = new URL(message.text.match(/https?:\/\/\S+/)[0]);
  const token = resetURL.pathname.split("/").pop()!;
  const newPassword = randomBytes(20).toString("hex");
  assert.equal((await browser.request("reset-password", { token, newPassword })).status, 200);
  assert.equal((await browser.request("get-session")).body, null);
  assert.ok((await browser.request("reset-password", { token, newPassword })).status >= 400);
  assert.equal((await new Browser().request("sign-in/email", { email, password: newPassword })).status, 200);
});

test("public attempt limits persist rejected operations and tenant metadata is not enumerable", async () => {
  const bucket = `test-${randomUUID()}`;
  for (let i = 0; i < 4; i++) {
    const { rows } = await database().query("SELECT collab.allow_public_attempt($1,3,60) AS allowed", [bucket]);
    assert.equal(rows[0].allowed, i < 3);
  }
  await assert.rejects(organizationDetail(owner, randomUUID()), /不存在/);
  await assert.rejects(database().query("SELECT * FROM collab.public_attempts"), /permission/);
});

test("forwarded IP headers cannot rotate around the login throttle", async () => {
  const statuses: number[] = [];
  for (let i = 0; i < 16; i++) statuses.push((await new Browser().request("sign-in/email", { email: "missing@onboarding.invalid", password }, { "x-forwarded-for": `198.51.100.${i + 1}` })).status);
  assert.ok(statuses.includes(429));
});


test("invalid cookie namespaces fail before an authentication handler is created", () => {
  const original = process.env.PI_COLLAB_AUTH_COOKIE_PREFIX;
  try {
    process.env.PI_COLLAB_AUTH_COOKIE_PREFIX = "bad; cookie";
    assert.throws(() => authOptions(database()), /Invalid authentication cookie prefix/);
  } finally { process.env.PI_COLLAB_AUTH_COOKIE_PREFIX = original; }
});
