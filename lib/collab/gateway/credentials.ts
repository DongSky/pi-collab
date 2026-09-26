import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const sealedSchema = z.object({ version: z.literal(1), nonce: z.string().regex(/^[a-f0-9]{24}$/), tag: z.string().regex(/^[a-f0-9]{32}$/), ciphertext: z.string().regex(/^[a-f0-9]+$/) }).strict();
const secretSchema = z.object({ apiKey: z.string().min(1).max(16000), baseUrl: z.string().url() }).strict();
export type ProviderSecret = z.infer<typeof secretSchema>;
export type SealedCredential = z.infer<typeof sealedSchema>;

/** Only local development/administration initializes a key; production supplies it separately. */
export async function masterKey(file: string, create = false): Promise<Buffer> {
  if (create) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    try { await writeFile(file, randomBytes(32), { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  const key = await readFile(file);
  if (key.length !== 32 || ((await stat(file)).mode & 0o077)) throw new Error("Model master key must be a private 32-byte file");
  return key;
}
export function validateEndpoint(raw: string): string {
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("Provider requires HTTPS (or a literal loopback address), without URL credentials/query/fragment");
  return url.toString().replace(/\/$/, "");
}
export function sealCredential(key: Buffer, profile: string, project: string, secret: ProviderSecret): SealedCredential {
  secretSchema.parse(secret); validateEndpoint(secret.baseUrl);
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`${profile}:${project}:v1`));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(secret), "utf8"), cipher.final()]);
  return { version: 1, nonce: nonce.toString("hex"), tag: cipher.getAuthTag().toString("hex"), ciphertext: ciphertext.toString("hex") };
}
export function openCredential(key: Buffer, profile: string, project: string, raw: unknown): ProviderSecret {
  const sealed = sealedSchema.parse(raw), cipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.nonce, "hex"));
  cipher.setAAD(Buffer.from(`${profile}:${project}:v1`)); cipher.setAuthTag(Buffer.from(sealed.tag, "hex"));
  const value = secretSchema.parse(JSON.parse(Buffer.concat([cipher.update(Buffer.from(sealed.ciphertext, "hex")), cipher.final()]).toString("utf8")));
  return { apiKey: value.apiKey, baseUrl: validateEndpoint(value.baseUrl) };
}
