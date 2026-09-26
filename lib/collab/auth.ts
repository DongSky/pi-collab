import { betterAuth, type BetterAuthOptions } from "better-auth";
import { oidcHooks, type OidcPin } from "./oidc-auth-hooks";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import type { Pool } from "pg";
import { database } from "./database";
import { deliverMail } from "./mail";

export function authOptions(pool: Pool, allowProvisioning = false, oidcPins: OidcPin[] = []): BetterAuthOptions {
  if (!process.env.BETTER_AUTH_SECRET || process.env.BETTER_AUTH_SECRET.length < 32) {
    throw new Error("A persistent BETTER_AUTH_SECRET of at least 32 characters is required");
  }
  const oidc=oidcHooks(pool,oidcPins);
  const cookiePrefix = process.env.PI_COLLAB_AUTH_COOKIE_PREFIX ?? "pi_collab";
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(cookiePrefix)) throw new Error("Invalid authentication cookie prefix");
  return {
    appName: "pi-collab",
    baseURL: process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:30142",
    basePath: "/api/collab/auth",
    secret: process.env.BETTER_AUTH_SECRET,
    database: pool,
    emailAndPassword: {
      enabled: true, disableSignUp: !allowProvisioning,
      minPasswordLength: 12, maxPasswordLength: 128,
      autoSignIn: false, revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await deliverMail({ to: user.email, subject: "重置 pi-collab 密码", text: `请在一小时内通过以下链接重置密码：\n${url}\n如果不是你发起的请求，请忽略。` });
      },
    },
    account: { accountLinking: { enabled: true, disableImplicitLinking: true, allowDifferentEmails: false }, updateAccountOnSignIn: false },
    user: oidc.user, databaseHooks: oidc.databaseHooks,
    onAPIError: { errorURL: `${process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:30142"}/sign-in?oidcError=1` },
    session: { additionalFields: { oidcProviderId:{type:"string",required:false,input:false},oidcProviderVersion:{type:"string",required:false,input:false},oidcChallengeHash:{type:"string",required:false,input:false} }, expiresIn: 60 * 60 * 24 * 7, cookieCache: { enabled: false } },
    // Request headers alone do not establish a trusted proxy/client address.
    // Until an ingress contract exists, use the library's shared per-path bucket.
    advanced: { cookiePrefix, ipAddress: { ipAddressHeaders: [] } },
    rateLimit: {
      enabled: true, storage: "database", window: 60, max: 100,
      // Multiple team members can legitimately share one VPN/proxy address.
      customRules: { "/sign-in/email": { window: 60, max: 15 } },
    },
    plugins: [oidc.plugin],
    hooks: { before: createAuthMiddleware(async ctx => {
      if(ctx.path === "/sign-in/email"){const cookie=ctx.context.createAuthCookie("oidc_mfa");ctx.setCookie(cookie.name,"",{...cookie.attributes,maxAge:0});}
      if(ctx.path === "/link-social"){
        const current=await getSessionFromCtx(ctx);if(!current||Date.now()-new Date(current.session.createdAt).getTime()>10*60_000)throw new APIError("FORBIDDEN",{code:"FRESH_SESSION_REQUIRED",message:"请重新登录后再绑定组织身份。"});
      }
      if(ctx.path === "/unlink-account" && typeof ctx.body?.providerId === "string" && ctx.body.providerId.startsWith("oidc-"))throw new APIError("FORBIDDEN",{message:"请通过账户安全页解除组织身份绑定并撤销会话。"});
      if (ctx.path !== "/two-factor/disable") return;
      const session = await getSessionFromCtx(ctx);
      if (!session) return;
      const { rows } = await pool.query("SELECT collab.user_requires_mfa($1) AS required", [session.user.id]);
      if (rows[0].required) throw new APIError("FORBIDDEN", { code: "MFA_REQUIRED", message: "团队所有者和管理员必须保留多因素验证。" });
    }) },
  };
}

let cached: ReturnType<typeof betterAuth> | undefined;
export function auth() { return cached ??= betterAuth(authOptions(database())); }

/** Only CLI/bootstrap/invitation code may use this, never the public auth handler. */
export function provisioningAuth(pool = database()) { return betterAuth(authOptions(pool, true)); }
