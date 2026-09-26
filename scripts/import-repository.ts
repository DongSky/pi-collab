import { parseArgs } from "node:util";
import { Pool } from "pg";
import { localConfig, applicationEnvironment, connectionString, dataRoot } from "./local-config";
import { importLocalRepository } from "../lib/collab/repository-import";

if (process.env.NODE_ENV === "production") throw new Error("Use a deployment-specific repository broker in production");
const { values } = parseArgs({ options: { project: { type: "string" }, actor: { type: "string" }, source: { type: "string" }, name: { type: "string" } } });
if (!values.project || !values.actor || !values.source || !values.name) throw new Error("Usage: npm run repo:import -- --project UUID --actor maintainer@example.com --source /local/repository --name RepositoryName");
const config = await localConfig(); Object.assign(process.env, applicationEnvironment(config));
const admin = new Pool({ connectionString: connectionString(config, true) });
try {
  const user = (await admin.query('SELECT id FROM public."user" WHERE email=$1', [values.actor.toLowerCase()])).rows[0];
  if (!user) throw new Error("The named maintainer account does not exist");
  const result = await importLocalRepository(admin, dataRoot, { projectId: values.project, actorId: user.id, source: values.source, name: values.name });
  console.log(`Repository registered: ${result.id}; base ${result.baseSha}; branch ${result.defaultBranch}`);
} finally { await admin.end(); }
