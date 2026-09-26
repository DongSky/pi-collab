import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
const sealedSchema = z.object({ nonce: z.string().regex(/^[a-f0-9]{24}$/), tag: z.string().regex(/^[a-f0-9]{32}$/), ciphertext: z.string().regex(/^[a-f0-9]{128}$/) }).strict();
export function sealResourcePassword(key: Buffer, resourceId: string, projectId: string, password: string) {
  if (!/^[a-f0-9]{64}$/.test(password)) throw new Error("Invalid resource credential");
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce); cipher.setAAD(Buffer.from(`postgres-resource:${projectId}:${resourceId}:v1`));
  const ciphertext = Buffer.concat([cipher.update(password), cipher.final()]);
  return { nonce: nonce.toString("hex"), tag: cipher.getAuthTag().toString("hex"), ciphertext: ciphertext.toString("hex") };
}
export function openResourcePassword(key: Buffer, resourceId: string, projectId: string, raw: unknown) {
  const sealed = sealedSchema.parse(raw), cipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.nonce, "hex"));
  cipher.setAAD(Buffer.from(`postgres-resource:${projectId}:${resourceId}:v1`)); cipher.setAuthTag(Buffer.from(sealed.tag, "hex"));
  const password = Buffer.concat([cipher.update(Buffer.from(sealed.ciphertext, "hex")), cipher.final()]).toString();
  if (!/^[a-f0-9]{64}$/.test(password)) throw new Error("Invalid resource credential"); return password;
}
