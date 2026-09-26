import { spawn } from "node:child_process";
import { gitEnvironment, localConfig } from "./local-config";
// Only the launcher reads local development configuration. The service receives
// its restricted role URL, no administrator/auth/model/resource credentials.
const child = spawn(process.execPath, ["--import", "tsx", "scripts/git-broker.ts"], { env: gitEnvironment(await localConfig()), stdio: "inherit" });
process.on("SIGINT", () => child.kill("SIGINT")); process.on("SIGTERM", () => child.kill("SIGTERM"));
child.once("exit", code => { process.exitCode = code ?? 1; });
