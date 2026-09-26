import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { provisioningAuth } from "../lib/collab/auth";
import { applicationEnvironment, connectionString, dataRoot, localConfig } from "./local-config";

if (process.env.NODE_ENV === "production") throw new Error("Development seed is disabled in production");
const config = await localConfig();
Object.assign(process.env, applicationEnvironment(config));
const pool = new Pool({ connectionString: connectionString(config, true) });
const auth = provisioningAuth(pool);
const file = path.join(dataRoot, "demo-accounts.json");
type Account = { name: string; email: string; password: string };
let accounts: Account[];
try { accounts = JSON.parse(await readFile(file, "utf8")); }
catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  accounts = ["Alice", "Bob", "Reviewer", "Outsider"].map(name => ({ name, email: `${name.toLowerCase()}@pi-collab.test`, password: randomBytes(18).toString("base64url") }));
  await writeFile(file, JSON.stringify(accounts, null, 2) + "\n", { mode: 0o600, flag: "wx" });
}
try {
  const users: string[] = [];
  for (const account of accounts) {
    const existing = await pool.query('SELECT id FROM public."user" WHERE email=$1', [account.email]);
    const user = existing.rows[0] ?? (await auth.api.signUpEmail({ body: account })).user;
    users.push(user.id);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(82467102)");
    const orgs = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
    const project = "33333333-3333-4333-8333-333333333333";
    for (let i = 0; i < 2; i++) {
      await client.query("INSERT INTO collab.organizations(id,name,created_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [orgs[i], i ? "Independent organization" : "Demo team", users[i ? 3 : 0]]);
    }
    for (let i = 0; i < users.length; i++) {
      await client.query("INSERT INTO collab.memberships(organization_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [orgs[i === 3 ? 1 : 0], users[i], i === 0 || i === 3 ? "owner" : "member"]);
    }
    await client.query("INSERT INTO collab.projects(id,organization_id,name,description,created_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [project, orgs[0], "Parallel development", "A shared project for independent AI tasks and integration checks.", users[0]]);
    for (let i = 0; i < 3; i++) {
      await client.query("INSERT INTO collab.project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [orgs[0], project, users[i], ["maintainer", "developer", "reviewer"][i]]);
    }
    await client.query("UPDATE collab.installation SET initialized_at=now(),bootstrap_hash='' WHERE initialized_at IS NULL");
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
  console.log(`Development users ready. Generated credentials are in ${file} (not printed or committed).`);
} finally { await pool.end(); }
