import assert from "node:assert/strict";
import { Client } from "pg";
import { localConfig, connectionString, dataRoot } from "../../../scripts/local-config";
import { startNativeDatabase } from "../../../scripts/native-database";

export async function verifySharedDatabase(delay: number) {
  assert.match(dataRoot, /pi-collab-tests-/);
  const config = await localConfig();
  const database = await startNativeDatabase(config);
  assert.equal(database.owned, false);
  const client = new Client({ connectionString: connectionString(config, true, "postgres") });
  try {
    await client.connect();
    await client.query("SELECT 1");
    await new Promise(resolve => setTimeout(resolve, delay));
    await database.stop();
    assert.equal((await client.query("SELECT 1 AS alive")).rows[0].alive, 1);
  } finally { await client.end(); }
}
