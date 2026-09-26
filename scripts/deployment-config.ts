import path from "node:path";

type DeploymentSettings = { production: boolean; nodeEnv: "development" | "production"; webOrigin: string; previewOrigin: string; mail: { PI_COLLAB_MAIL_TRANSPORT: "file" | "smtp"; SMTP_URL?: string; SMTP_FROM?: string } };
/** Public settings are explicit; the local profile never inherits SMTP credentials. */
export function deploymentSettings(ports: { port: number; gatewayPort: number }, env: Record<string, string | undefined> = process.env): DeploymentSettings {
  const production = env.PI_COLLAB_DEPLOYMENT === "production";
  if (env.PI_COLLAB_DEPLOYMENT && !["local", "production"].includes(env.PI_COLLAB_DEPLOYMENT)) throw new Error("Unknown PI_COLLAB_DEPLOYMENT");
  if (!production) return { production, nodeEnv: "development", webOrigin: `http://127.0.0.1:${ports.port}`, previewOrigin: `http://127.0.0.1:${ports.gatewayPort}`, mail: { PI_COLLAB_MAIL_TRANSPORT: "file" } };
  if (!env.PI_COLLAB_DATA_DIR || !path.isAbsolute(env.PI_COLLAB_DATA_DIR)) throw new Error("Production requires an absolute persistent PI_COLLAB_DATA_DIR");
  const origin = (name: string) => {
    try {
      const value = new URL(env[name] ?? "");
      if (value.protocol !== "https:" || value.username || value.password || value.pathname !== "/" || value.search || value.hash) throw new Error();
      return value.origin;
    } catch { throw new Error(`${name} must be an HTTPS origin without a path or credentials`); }
  };
  const webOrigin = origin("PI_COLLAB_PUBLIC_ORIGIN"), previewOrigin = origin("PI_COLLAB_PREVIEW_ORIGIN");
  if (new URL(webOrigin).hostname === new URL(previewOrigin).hostname) throw new Error("Preview must use a separate hostname");
  try {
    const smtp = new URL(env.SMTP_URL ?? "");
    // Options in URL query strings could disable TLS; configuration is intentionally narrow.
    if (!["smtp:", "smtps:"].includes(smtp.protocol) || smtp.search || smtp.hash || !["", "/"].includes(smtp.pathname)) throw new Error();
  } catch { throw new Error("SMTP_URL must be an smtp/smtps URL without query options"); }
  if (!env.SMTP_FROM || env.SMTP_FROM.length > 320 || /[\r\n]/.test(env.SMTP_FROM)) throw new Error("SMTP_FROM is required");
  return { production, nodeEnv: "production", webOrigin, previewOrigin, mail: { PI_COLLAB_MAIL_TRANSPORT: "smtp", SMTP_URL: env.SMTP_URL, SMTP_FROM: env.SMTP_FROM } };
}
