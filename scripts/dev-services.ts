import { localConfig } from "./local-config";
import { startNativeDatabase } from "./native-database";

const config = await localConfig();
const database = await startNativeDatabase(config);
console.log(`pi-collab PostgreSQL ready at 127.0.0.1:${config.databasePort} (${database.owned ? "started" : "reused"}; native, no Docker).`);
if (!database.owned) process.exit(0);
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await database.stop();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
setInterval(() => {}, 60_000);
