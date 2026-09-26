import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { masterKey } from "../lib/collab/gateway/credentials";
import { registerModelProfile } from "../lib/collab/gateway/profiles";
import { connectionString, dataRoot, localConfig } from "./local-config";

const { values } = parseArgs({ options: { project: { type: "string" }, actor: { type: "string" }, name: { type: "string" }, provider: { type: "string" }, model: { type: "string" }, "from-pi": { type: "boolean" } } });
if (!values.project || !values.actor || !values.provider || !values.model || !values["from-pi"]) throw new Error("Usage: npm run model:import -- --from-pi --project UUID --actor maintainer@email --provider NAME --model ID [--name LABEL]. This explicitly shares the selected model with this project through the gateway.");
const config = await localConfig(), admin = new Pool({ connectionString: connectionString(config, true) });
try {
  const actor = (await admin.query('SELECT id FROM public."user" WHERE email=$1', [values.actor.toLowerCase()])).rows[0];
  if (!actor) throw new Error("Maintainer account not found");
  const settings = JSON.parse(await readFile(path.join(os.homedir(), ".pi/agent/models.json"), "utf8"));
  const provider = settings.providers?.[values.provider], model = provider?.models?.find((entry: { id: string }) => entry.id === values.model);
  if (!model || (model.api ?? provider.api) !== "openai-responses") throw new Error("Only an explicitly selected Responses model can be imported");
  if (provider.headers || model.headers || model.baseUrl || model.apiKey || model.samplingParams || provider.samplingParams || model.compat || provider.compat) throw new Error("Custom headers/overrides require a separately reviewed gateway adapter");
  const apiKey = provider.apiKey;
  if (typeof apiKey !== "string" || !apiKey || apiKey.startsWith("!") || apiKey.includes("$")) throw new Error("Import requires a literal provider key; shell commands and environment interpolation are not executed");
  const hasCredentials = (await admin.query("SELECT 1 FROM collab_gateway.credentials LIMIT 1")).rowCount !== 0;
  const key = await masterKey(path.join(dataRoot, "model-master.key"), !hasCredentials);
  try {
    const registered = await registerModelProfile(admin, key, { projectId: values.project, actorId: actor.id, name: values.name ?? `${values.provider} / ${model.id}`, modelId: model.id, reasoning: !!model.reasoning, contextWindow: Math.min(model.contextWindow ?? 128000, 256000), maxOutputTokens: Math.min(model.maxTokens ?? 8192, 8192) }, { apiKey, baseUrl: provider.baseUrl });
    console.log(JSON.stringify(registered));
  } finally { key.fill(0); }
} finally { await admin.end(); }
