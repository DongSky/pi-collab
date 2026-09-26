import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { z } from "zod";
import { localConfig, connectionString } from "./local-config";
import { readPrivateGitHubFile } from "../lib/collab/git/github-credentials";
const { values } = parseArgs({ options: { connection: { type: "string" }, actor: { type: "string" }, "secret-file": { type: "string" }, "expected-version": { type: "string" }, reason: { type: "string" }, "request-id": { type: "string" }, disable: { type: "boolean", default: false } } });
const input = z.object({ connection: z.uuid(), actor: z.email(), "secret-file": z.string().min(1), "expected-version": z.string().regex(/^(0|[1-9][0-9]{0,17})$/), reason: z.string().trim().min(10).max(2000), "request-id": z.uuid().optional(), disable: z.boolean() }).parse(values);
const request = input["request-id"] ?? randomUUID();
console.log(`Webhook configuration request: ${request}. Retry this ID with exactly the same inputs after an uncertain response.`);
const db = new Pool({ connectionString: connectionString(await localConfig(), true), max: 1 }); let secret: Buffer | undefined;
try {
  secret = await readPrivateGitHubFile(input["secret-file"], 256);
  // Secret is literal UTF-8 text pasted into GitHub's App webhook configuration.
  // Refuse trailing line breaks rather than silently signing different bytes.
  if (secret.length < 32 || !/^[\x21-\x7e]{32,256}$/.test(secret.toString("utf8"))) throw new Error("Invalid webhook secret file");
  const actor = (await db.query('SELECT id FROM public."user" WHERE email=$1', [input.actor.toLowerCase()])).rows[0];
  if (!actor) throw new Error("Unknown actor");
  await db.query("BEGIN");
  await db.query("SELECT set_config('collab.user_id',$1,true)", [actor.id]);
  const result = (await db.query("SELECT collab_git.configure_webhook($1,$2,$3,$4,$5) AS result", [input.connection,input["expected-version"],request,{ enabled: !input.disable, reason: input.reason },secret])).rows[0].result;
  await db.query("COMMIT"); console.log(JSON.stringify(result));
} catch { await db.query("ROLLBACK").catch(() => {}); console.error("Webhook configuration failed. Check migration, current version, administrator MFA and private secret file; no secret is printed."); process.exitCode = 1; }
finally { secret?.fill(0); await db.end(); }
