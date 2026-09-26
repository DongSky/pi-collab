import path from "node:path";
import { spawn } from "node:child_process";
import { localConfig, executorConnectionString } from "./local-config";
const name = process.env.PI_COLLAB_E2E_DATABASE ?? "", root = process.env.PI_COLLAB_E2E_DATA ?? "";
if (!/^pi_collab_test_[a-f0-9]+$/.test(name) || !path.basename(root).startsWith("identity-e2e-")) throw new Error("Isolated service fixture required");
const child = spawn(process.execPath, ["--import", "tsx", "scripts/executor.ts"], { env: { ...process.env, PI_COLLAB_DATA_DIR: root, PI_COLLAB_EXECUTOR_DATABASE_URL: executorConnectionString(await localConfig(), name) }, stdio: ["ignore", "ignore", "inherit"] });
const stop = () => child.kill("SIGTERM"); process.on("SIGTERM", stop); process.on("SIGINT", stop);
child.once("exit", code => process.exit(code ?? 0));
