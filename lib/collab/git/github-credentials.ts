import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, randomBytes, type KeyObject } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { githubAppConfig, type GitHubAppConfig } from "./github-schema";

export class GitHubError extends Error { constructor(readonly code: string, readonly status: number | null = null) { super(code); } }
export function privateKey(raw: string | Buffer): KeyObject {
  try {
    if (Buffer.byteLength(raw) > 16384) throw new Error();
    const key = createPrivateKey(raw);
    if (key.asymmetricKeyType !== "rsa" || !key.asymmetricKeyDetails?.modulusLength || key.asymmetricKeyDetails.modulusLength < 2048 || key.asymmetricKeyDetails.modulusLength > 8192) throw new Error();
    return key;
  } catch { throw new GitHubError("github_invalid_private_key"); }
}
export const publicKeyFingerprint = (key: KeyObject) => createHash("sha256").update(createPublicKey(key).export({ type: "spki", format: "der" })).digest("hex");
const contextSchema = githubAppConfig.extend({ connectionId: z.uuid(), organizationId: z.uuid() }).strict();
export type GitHubCredentialContext = GitHubAppConfig & { connectionId: string; organizationId: string };
const sealedSchema = z.object({ version: z.literal(1), nonce: z.string().regex(/^[a-f0-9]{24}$/), tag: z.string().regex(/^[a-f0-9]{32}$/), ciphertext: z.string().regex(/^[a-f0-9]+$/).max(32768) }).strict();
const aad = (context: GitHubCredentialContext) => Buffer.from(`pi-collab:github-key:v1:${JSON.stringify(contextSchema.parse(context))}`);
export function sealGitHubKey(master: Buffer, context: GitHubCredentialContext, key: KeyObject) {
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", master, nonce);
  cipher.setAAD(aad(context));
  const bytes = key.export({ type: "pkcs8", format: "pem" });
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return { version: 1, nonce: nonce.toString("hex"), tag: cipher.getAuthTag().toString("hex"), ciphertext: ciphertext.toString("hex") };
}
export function openGitHubKey(master: Buffer, context: GitHubCredentialContext, raw: unknown): KeyObject {
  let clear: Buffer | undefined;
  try {
    const sealed = sealedSchema.parse(raw), cipher = createDecipheriv("aes-256-gcm", master, Buffer.from(sealed.nonce, "hex"));
    cipher.setAAD(aad(context)); cipher.setAuthTag(Buffer.from(sealed.tag, "hex"));
    clear = Buffer.concat([cipher.update(Buffer.from(sealed.ciphertext, "hex")), cipher.final()]); return privateKey(clear);
  } catch { throw new GitHubError("github_credential_unavailable"); }
  finally { clear?.fill(0); }
}
/** Explicit operator-supplied file only. Never discover ~/.ssh, gh or Pi secrets. */
export async function readPrivateGitHubFile(file: string, limit = 16384) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > limit || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new GitHubError("github_private_file_required");
    const bytes = Buffer.alloc(limit + 1); let read = 0;
    while (read < bytes.length) { const part = await handle.read(bytes, read, bytes.length - read, null); if (!part.bytesRead) break; read += part.bytesRead; }
    if (read !== stat.size) { bytes.fill(0); throw new GitHubError("github_private_file_changed"); }
    return bytes.subarray(0, read);
  } finally { await handle.close(); }
}
export async function githubMasterKey(file: string, create = false) {
  if (create) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const bytes = randomBytes(32);
    try { await writeFile(file, bytes, { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    finally { bytes.fill(0); }
  }
  const bytes = await readPrivateGitHubFile(file, 32);
  if (bytes.length !== 32) { bytes.fill(0); throw new GitHubError("github_master_key_unavailable"); }
  return bytes;
}
