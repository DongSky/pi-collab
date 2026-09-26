import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import nodemailer from "nodemailer";

export function smtpOptions(env: Record<string, string | undefined> = process.env) {
  let url: URL;
  try { url = new URL(env.SMTP_URL ?? ""); } catch { throw new Error("Invalid SMTP configuration"); }
  if (!["smtp:", "smtps:"].includes(url.protocol) || url.search || url.hash || !["", "/"].includes(url.pathname)) throw new Error("Invalid SMTP configuration");
  return {
    host: url.hostname, port: url.port ? Number(url.port) : url.protocol === "smtps:" ? 465 : 587,
    secure: url.protocol === "smtps:", requireTLS: env.NODE_ENV === "production",
    tls: { rejectUnauthorized: true }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 30000,
    ...(url.username ? { auth: { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) } } : {}),
    disableFileAccess: true, disableUrlAccess: true,
  };
}

/** Local development never sends real email. Production transport is explicit. */
export async function deliverMail(message: { to: string; subject: string; text: string }) {
  if (process.env.PI_COLLAB_MAIL_TRANSPORT === "file") {
    if (process.env.NODE_ENV === "production") throw new Error("File mailbox is development-only");
    const directory = path.resolve(process.env.PI_COLLAB_DATA_DIR ?? ".local", "mailbox");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(directory, `${Date.now()}-${randomUUID()}.json`), JSON.stringify(message), { flag: "wx", mode: 0o600 });
    return;
  }
  if (process.env.PI_COLLAB_MAIL_TRANSPORT !== "smtp" || !process.env.SMTP_URL || !process.env.SMTP_FROM) {
    throw new Error("Configure PI_COLLAB_MAIL_TRANSPORT and SMTP settings before sending mail");
  }
  const transport = nodemailer.createTransport(smtpOptions());
  try { await transport.sendMail({ from: process.env.SMTP_FROM, ...message }); }
  finally { transport.close(); }
}
