/** Explicit opt-in import of the one provider/model authorized for the local demo. */
import { readFile, writeFile, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import lockfile from "proper-lockfile";
import { localConfig, connectionString, dataRoot } from "./local-config";
import { masterKey, openCredential } from "../lib/collab/gateway/credentials";
import { registerModelProfile } from "../lib/collab/gateway/profiles";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { "from-pi": { type: "boolean" }, provider: { type: "string" }, model: { type: "string" } } });
if (process.env.NODE_ENV === "production" || !values["from-pi"] || !values.provider || !values.model) throw new Error("Explicit local demo selection required: --from-pi --provider NAME --model ID");
const file = path.join(dataRoot, "live-demo/state.json");
const release = await lockfile.lock(path.dirname(file), { retries: 0 });
const state = JSON.parse(await readFile(file, "utf8"));
if (!state.ready) throw new Error("Prepare the local demo first");
const selected = JSON.parse(await readFile(path.join(os.homedir(), ".pi/agent/models.json"), "utf8")).providers?.[values.provider];
const model = selected?.models?.find((m: { id: string }) => m.id === values.model);
if (!model || (model.api ?? selected.api) !== "openai-responses" || typeof selected.apiKey !== "string" || selected.apiKey.startsWith("!") || selected.headers || model.headers)
  throw new Error("The selected Pi configuration requires manual supported import; no command or environment secret resolution is performed");
const pool = new Pool({ connectionString: connectionString(await localConfig(), true) });
const key = await masterKey(path.join(dataRoot, "model-master.key"));
try {
  const current = state.modelProfileId ? (await pool.query("SELECT p.id,p.project_id,p.model_id,p.context_window,c.sealed FROM collab.model_profiles p JOIN collab_gateway.credentials c ON c.profile_id=p.id WHERE p.id=$1 AND p.project_id=$2", [state.modelProfileId, state.projectId])).rows[0] : null;
  const secret = current ? openCredential(key, current.id, current.project_id, current.sealed) : null;
  if (secret?.apiKey === selected.apiKey && secret?.baseUrl === selected.baseUrl.replace(/\/$/, "") && current.model_id === model.id && current.context_window === 128000) {
    console.log("Selected demo model already matches Pi");
  } else {
    const profile = await registerModelProfile(pool, key, {
      projectId: state.projectId, actorId: state.accounts.find((a: { name: string }) => a.name === "Alice").id,
      name: `${values.provider} / ${model.id} · 本机验收`, modelId: model.id, reasoning: !!model.reasoning,
      contextWindow: 128000, maxOutputTokens: 4096, runRequestLimit: 12, runTokenLimit: 1000000, dailyTokenLimit: 2000000,
    }, { apiKey: selected.apiKey, baseUrl: selected.baseUrl });
    state.modelProfileId = profile.id;
    await writeFile(file + ".tmp", JSON.stringify(state, null, 2) + "\n", { mode: 0o600 }); await rename(file + ".tmp", file);
    console.log(JSON.stringify({ modelProfileId: profile.id, imported: true }));
  }
} finally { key.fill(0); await pool.end(); await release(); }
