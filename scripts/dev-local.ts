import { writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { nativeBootId } from "../lib/collab/runtime/receipts";
import { operationLock } from "./operations-core";
import { dataRoot } from "./local-config";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { applicationEnvironment, executorEnvironment, gatewayEnvironment, brokerEnvironment, gitEnvironment, localConfig } from "./local-config";
import { startNativeDatabase } from "./native-database";
import { migrate } from "./migrate";
import { verifyRelease } from "./release.mjs";
import { Pool } from "pg";
import { connectionString } from "./local-config";
import { checkMigrationPrefix } from "./operations-core";
import { deploymentSettings } from "./deployment-config";

const config = await localConfig();
const require = createRequire(import.meta.url);
const tsxLoader = require.resolve("tsx");
const deployment = deploymentSettings(config);
if (deployment.production) {
  await verifyRelease();
}
const occupied = await Promise.all([config.port, config.gatewayPort].map(port => new Promise<number | null>(resolve => {
  const socket = createConnection({ host: "127.0.0.1", port });
  socket.once("connect", () => { socket.destroy(); resolve(port); });
  socket.once("error", () => resolve(null));
})));
if (occupied.some(Boolean)) throw new Error(`Port ${occupied.filter(Boolean).join(", ")} is already in use. Check the existing process; it has not been stopped.`);
const releaseOperationLock = await operationLock(dataRoot);
const database = await startNativeDatabase(config);
await writeFile(path.join(dataRoot, "supervisor.json"), JSON.stringify({ pid: process.pid, bootId: await nativeBootId(), cwd: process.cwd() }), { mode: 0o600 });
Object.assign(process.env, applicationEnvironment(config));
try {
  if (deployment.production) {
    const admin = new Pool({ connectionString: connectionString(config, true) });
    try {
      const applied = (await admin.query("SELECT name,hash FROM collab_meta.migrations ORDER BY name")).rows;
      if ((await checkMigrationPrefix(applied)).length !== applied.length) throw new Error("Run ops:upgrade while stopped before starting this release");
    } finally { await admin.end(); }
  } else await migrate(config);
} catch (error) { await database.stop(); await rm(path.join(dataRoot, "supervisor.json"), { force: true }); await releaseOperationLock(); throw error; }
console.log(`pi-collab: ${deployment.webOrigin} · ${deployment.nodeEnv} · ${process.env.PI_COLLAB_RUNTIME ?? "native"} · data: ${process.env.PI_COLLAB_DATA_DIR}`);
const web = spawn(process.execPath, [require.resolve("next/dist/bin/next"), deployment.production ? "start" : "dev", "-H", "127.0.0.1", "-p", String(config.port)], {
  env: applicationEnvironment(config), stdio: "inherit",
});
const executor = spawn(process.execPath, ["--import", tsxLoader, "scripts/executor.ts"], { env: executorEnvironment(config), stdio: "inherit" });
const gateway = spawn(process.execPath, ["--import", tsxLoader, "scripts/model-gateway.ts"], { env: gatewayEnvironment(config), stdio: "inherit" });
const broker = spawn(process.execPath, ["--import", tsxLoader, "scripts/resource-broker.ts"], { env: brokerEnvironment(config), stdio: "inherit" });
const gitBroker = spawn(process.execPath, ["--import", tsxLoader, "scripts/git-broker.ts"], { env: gitEnvironment(config), stdio: "inherit" });
const gitExit = new Promise<number | null>(resolve => gitBroker.once("exit", resolve));
const brokerExit = new Promise<number | null>(resolve => broker.once("exit", resolve));
const webExit = new Promise<number | null>(resolve => web.once("exit", resolve));
const executorExit = new Promise<number | null>(resolve => executor.once("exit", resolve));
const gatewayExit = new Promise<number | null>(resolve => gateway.once("exit", resolve));
let stopping = false;
const stop = () => { if (!stopping) { stopping = true; web.kill("SIGTERM"); executor.kill("SIGTERM"); gateway.kill("SIGTERM"); broker.kill("SIGTERM"); gitBroker.kill("SIGTERM"); } };
// embedded-postgres registers async-exit-hook signal handlers on import. Its
// handler otherwise stops PostgreSQL and exits this process before our workers
// finish, leaving a stale supervisor receipt. This supervisor owns shutdown;
// keep the library's exit fallback, but handle these signals in order below.
const postgresRequire = createRequire(require.resolve("embedded-postgres"));
const databaseExitHook = postgresRequire("async-exit-hook") as { unhookEvent: (event: string) => void };
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) databaseExitHook.unhookEvent(signal);
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("SIGHUP", stop);
void Promise.race([webExit, executorExit, gatewayExit, brokerExit, gitExit]).then(async code => {
  stop(); await Promise.all([webExit, executorExit, gatewayExit, brokerExit, gitExit]); await database.stop(); await rm(path.join(dataRoot, "supervisor.json"), { force: true }); await releaseOperationLock(); process.exit(code ?? 0);
});
