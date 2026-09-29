import { Pool, type PoolClient } from "pg";

declare global { var __piCollabPool: Pool | undefined; }

export function database(): Pool {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required; run npm run dev:local");
  return globalThis.__piCollabPool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 12, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30_000,
  });
}

/** Set transaction-local session identity and dev MFA bypass. Use everywhere a DB session is opened. */
export async function setupSession(client: PoolClient, userId: string): Promise<void> {
  await client.query("SELECT set_config('collab.user_id', $1, true)", [userId]);
  // Dev/test escape hatch: PI_COLLAB_DISABLE_MFA=1 makes user_requires_mfa()
  // return false. Never enable in production.
  if (process.env.PI_COLLAB_DISABLE_MFA === "1")
    await client.query("SELECT set_config('pi_collab.disable_mfa', '1', true)");
}

/** One checked-out connection + transaction-local identity, never pool-global SET. */
export async function asUser<T>(userId: string, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await database().connect();
  let disconnected = false;
  // pg reports a broken checked-out connection both through the query promise
  // and an error event. Keep the latter handled until release, preserving the
  // original uncertain transaction error instead of crashing the Web process.
  const onDisconnect = () => { disconnected = true; };
  client.on("error", onDisconnect);
  try {
    await client.query("BEGIN");
    await setupSession(client, userId);
    const value = await operation(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { disconnected = true; }
    throw error;
  } finally { client.removeListener("error", onDisconnect); client.release(disconnected); }
}
